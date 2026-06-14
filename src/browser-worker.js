import fs from "node:fs/promises";
import { chromium } from "playwright-core";
import { config, publicConfig } from "./config.js";

export class BrowserWorker {
  constructor(store) {
    this.store = store;
    this.remoteDisplay = null;
    this.context = null;
    this.page = null;
    this.mode = "stopped";
    this.busy = Promise.resolve();
    this.idleTimer = null;
  }

  async status() {
    const page = this.page;
    const currentUrl = page ? page.url() : "";
    const loggedIn = page ? await this.detectLoggedIn().catch(() => false) : this.store.state.loggedIn;
    await this.store.patch({
      mode: this.mode,
      currentUrl,
      loggedIn,
      lastError: this.store.state.lastError || ""
    });
    return {
      ok: true,
      mode: this.mode,
      browserRunning: Boolean(this.context),
      currentUrl,
      loggedIn,
      profileDir: config.profileDir,
      lastError: this.store.state.lastError,
      lastRequestAt: this.store.state.lastRequestAt,
      idleMs: config.browserIdleMs,
      remoteDisplay: this.remoteDisplay ? this.remoteDisplay.info() : null
      ,
      config: publicConfig()
    };
  }

  async startLogin() {
    if (this.remoteDisplay) await this.remoteDisplay.start();
    await this.start("login");
    await this.openTrae();
    return this.status();
  }

  async startService() {
    await this.start("service");
    await this.openTrae();
    this.armIdleTimer();
    return this.status();
  }

  async stop() {
    this.clearIdleTimer();
    const oldMode = this.mode;
    if (this.context) await this.context.close().catch(() => {});
    this.context = null;
    this.page = null;
    this.mode = "stopped";
    if (oldMode === "login" && this.remoteDisplay) await this.remoteDisplay.stop();
    await this.store.patch({ mode: "stopped", currentUrl: "", lastError: "" });
    return this.status();
  }

  async chat(prompt) {
    return this.enqueue(async () => {
      await this.ensureService();
      await this.store.patch({ lastRequestAt: new Date().toISOString() });
      const page = this.page;
      await this.openTrae();
      const before = await getPageText(page);
      await sendPrompt(page, prompt);
      await waitForStableAnswer(page, prompt);
      const text = await getFinalAgentAnswer(page, prompt) || await getJsonAnswerFromPage(page, prompt) || await getLatestAgentAnswer(page) || extractDelta(before, await getPageText(page));
      this.armIdleTimer();
      return { text };
    });
  }

  async domSummary() {
    await this.ensureService();
    await this.openTrae();
    return await this.page.evaluate(() => {
      const selectors = [
        "div[role='textbox'].chat-input-v2-input-box-editable",
        "textarea",
        "[contenteditable=true]",
        "[role=textbox]",
        ".ProseMirror",
        "button.chat-input-v2-send-button"
      ];
      const body = document.body?.innerText || "";
      return {
        url: location.href,
        title: document.title,
        bodyTail: body.slice(-2000),
        selectors: selectors.map((selector) => ({
          selector,
          count: document.querySelectorAll(selector).length,
          samples: Array.from(document.querySelectorAll(selector)).slice(0, 3).map((node) => ({
            tag: node.tagName,
            className: String(node.className || ""),
            role: node.getAttribute("role") || "",
            text: (node.innerText || node.textContent || "").slice(0, 200),
            disabled: Boolean(node.disabled)
          }))
        }))
      };
    });
  }

  async ensureService() {
    if (!this.context) await this.startService();
  }

  async start(mode) {
    if (this.context && this.mode === mode) return;
    if (this.context) await this.stop();

    await fs.mkdir(config.profileDir, { recursive: true });
    const headless = mode === "service" ? config.headlessService : false;
    const launchOptions = {
      channel: config.chromeChannel,
      headless,
      env: mode === "login" ? { ...process.env, DISPLAY: config.loginDisplay } : process.env,
      viewport: { width: 1280, height: 900 },
      locale: "zh-CN",
      timezoneId: "Asia/Shanghai",
      args: [
        "--disable-dev-shm-usage",
        "--no-first-run",
        "--no-default-browser-check"
      ]
    };
    const proxy = buildProxy();
    if (proxy) launchOptions.proxy = proxy;

    this.context = await chromium.launchPersistentContext(config.profileDir, launchOptions);
    this.context.on("close", () => {
      this.context = null;
      this.page = null;
      this.mode = "stopped";
    });
    this.page = this.context.pages()[0] || await this.context.newPage();
    this.mode = mode;
    await this.store.patch({
      mode,
      lastStartedAt: new Date().toISOString(),
      lastError: ""
    });
  }

  async openTrae() {
    if (!this.page) throw new Error("Browser is not running");
    if (!this.page.url().startsWith(config.traeUrl)) {
      await this.page.goto(config.traeUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
    }
    await this.page.waitForLoadState("domcontentloaded", { timeout: 30000 }).catch(() => {});
  }

  async detectLoggedIn() {
    if (!this.page) return false;
    const url = this.page.url();
    if (/login|passport|sso/i.test(url)) return false;
    const text = await this.page.locator("body").innerText({ timeout: 5000 }).catch(() => "");
    if (/登录|扫码|验证码|Sign in|Login/i.test(text) && !/新建|发送|模型|chat|TRAE/i.test(text)) {
      return false;
    }
    return url.includes("trae") || url.includes("work.");
  }

  armIdleTimer() {
    this.clearIdleTimer();
    if (!config.browserIdleMs) return;
    this.idleTimer = setTimeout(() => {
      if (this.mode === "service") this.stop().catch(() => {});
    }, config.browserIdleMs);
  }

  clearIdleTimer() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  enqueue(task) {
    const next = this.busy.then(task, task);
    this.busy = next.catch(() => {});
    return next;
  }
}

function buildProxy() {
  if (!config.proxyServer) return null;
  const proxy = { server: config.proxyServer };
  if (config.proxyUsername) proxy.username = config.proxyUsername;
  if (config.proxyPassword) proxy.password = config.proxyPassword;
  return proxy;
}

async function sendPrompt(page, prompt) {
  const candidates = [
    "div[role='textbox'].chat-input-v2-input-box-editable",
    "textarea",
    "[contenteditable=true]",
    "[role=textbox]",
    ".ProseMirror"
  ];
  let input = null;
  for (const selector of candidates) {
    const candidate = page.locator(selector).last();
    await candidate.waitFor({ state: "visible", timeout: 6000 }).catch(() => {});
    if ((await candidate.count().catch(() => 0)) > 0) {
      input = candidate;
      break;
    }
  }
  if (!input) throw new Error("Cannot find TRAE chat input. Login may be required.");

  await input.click({ timeout: 10000 });
  await input.fill(prompt).catch(async () => {
    await page.keyboard.insertText(prompt);
  });

  const sendButton = page.locator("button.chat-input-v2-send-button").last();
  if (await sendButton.count().catch(() => 0)) {
    await page.waitForFunction(() => {
      const button = document.querySelector("button.chat-input-v2-send-button");
      return button && !button.disabled && !String(button.className).includes("disabled");
    }, { timeout: 30000 }).catch(() => {});
    await sendButton.click({ timeout: 10000 });
  } else {
    await page.keyboard.press("Enter");
  }
}

async function getPageText(page) {
  return await page.evaluate(() => document.body.innerText || "");
}

async function waitForStableAnswer(page, prompt) {
  const deadline = Date.now() + 120000;
  let last = "";
  let stableCount = 0;
  while (Date.now() < deadline) {
    const answer = await getFinalAgentAnswer(page, prompt);
    const jsonAnswer = answer || await getJsonAnswerFromPage(page, prompt);
    if (jsonAnswer && !/Thinking|Generating|Stop generating|思考中|停止/i.test(jsonAnswer)) {
      if (jsonAnswer === last) stableCount += 1;
      else stableCount = 0;
      last = jsonAnswer;
      if (stableCount >= 2) return jsonAnswer;
    }
    await page.waitForTimeout(1200);
  }
  throw new Error("Timed out waiting for TRAE response");
}

async function getJsonAnswerFromPage(page, prompt = "") {
  return await page.evaluate((prompt) => {
    const body = document.body?.innerText || "";
    const start = prompt ? body.lastIndexOf(prompt) : 0;
    const text = start >= 0 ? body.slice(start + prompt.length) : body;
    const matches = text.match(/\{[\s\S]*?"type"\s*:\s*"(?:tool_call|final)"[\s\S]*?\}/g) || [];
    for (let i = matches.length - 1; i >= 0; i -= 1) {
      const candidate = balanceJson(matches[i], text);
      try {
        const parsed = JSON.parse(candidate);
        if (parsed?.type === "tool_call" || parsed?.type === "final") return candidate;
      } catch {}
    }
    return "";

    function balanceJson(prefix, source) {
      const index = source.lastIndexOf(prefix);
      if (index < 0) return prefix;
      let depth = 0;
      let inString = false;
      let escaped = false;
      for (let pos = index; pos < source.length; pos += 1) {
        const ch = source[pos];
        if (escaped) {
          escaped = false;
          continue;
        }
        if (ch === "\\") {
          escaped = true;
          continue;
        }
        if (ch === '"') inString = !inString;
        if (inString) continue;
        if (ch === "{") depth += 1;
        if (ch === "}") {
          depth -= 1;
          if (depth === 0) return source.slice(index, pos + 1);
        }
      }
      return prefix;
    }
  }, prompt);
}

async function getFinalAgentAnswer(page, prompt = "") {
  return await page.evaluate((prompt) => {
    const lastTurn = document.querySelector(".turn--last");
    if (!lastTurn) return "";
    const lastTurnText = lastTurn.innerText || lastTurn.textContent || "";
    if (prompt && !lastTurnText.includes(prompt)) return "";

    const selectors = [
      ".turn--last .turn__agent-message .core-finish-card__summary .markdown-renderer",
      ".turn--last .turn__agent-message .core-finish-card__summary",
      ".turn--last .turn__agent-message .markdown-renderer"
    ];
    for (const selector of selectors) {
      const node = document.querySelector(selector);
      const text = (node?.innerText || node?.textContent || "").trim();
      if (text) return cleanup(text);
    }
    return "";

    function cleanup(text) {
      return text
        .replace(/^TRAE Work\s*/i, "")
        .replace(/^任务耗时.*$/gm, "")
        .replace(/^思考过程\s*/gm, "")
        .trim();
    }
  }, prompt);
}

async function getLatestAgentAnswer(page) {
  return await page.evaluate(() => {
    const selectors = [
      ".turn--last .turn__agent-message .markdown-renderer",
      ".turn--last .turn__agent-message .core-finish-card__summary",
      ".turn--last .turn__agent-message"
    ];
    for (const selector of selectors) {
      const node = document.querySelector(selector);
      const text = (node?.innerText || node?.textContent || "").trim();
      if (text) return text.replace(/^TRAE Work\s*/i, "").trim();
    }
    return "";
  });
}

function extractDelta(before, after) {
  if (!after) return "";
  if (!before) return after.trim();
  const index = after.indexOf(before.slice(-1000));
  if (index >= 0) return after.slice(index + Math.min(1000, before.length)).trim();
  return after.trim();
}
