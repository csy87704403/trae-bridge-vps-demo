import fs from "node:fs/promises";
import { chromium } from "playwright-core";
import { config } from "./config.js";

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
      const before = await lastAssistantText(page);
      await sendPrompt(page, prompt);
      const text = await waitForNewAssistantText(page, before);
      this.armIdleTimer();
      return { text };
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
    this.context = await chromium.launchPersistentContext(config.profileDir, {
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
    });
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

async function sendPrompt(page, prompt) {
  const candidates = [
    "textarea",
    "[contenteditable=true]",
    "[role=textbox]",
    ".ProseMirror"
  ];
  let input = null;
  for (const selector of candidates) {
    const candidate = page.locator(selector).last();
    if (await candidate.count().catch(() => 0)) {
      input = candidate;
      break;
    }
  }
  if (!input) throw new Error("Cannot find TRAE chat input. Login may be required.");

  await input.click({ timeout: 10000 });
  await page.keyboard.insertText(prompt);
  await page.keyboard.press("Enter");
}

async function lastAssistantText(page) {
  const body = await page.locator("body").innerText({ timeout: 10000 }).catch(() => "");
  return body.slice(-4000);
}

async function waitForNewAssistantText(page, before) {
  const deadline = Date.now() + 120000;
  let latest = before;
  while (Date.now() < deadline) {
    await page.waitForTimeout(1000);
    latest = await lastAssistantText(page);
    if (latest && latest !== before && latest.length > before.length + 20) {
      await page.waitForTimeout(2500);
      const settled = await lastAssistantText(page);
      return extractDelta(before, settled);
    }
  }
  throw new Error("Timed out waiting for TRAE response");
}

function extractDelta(before, after) {
  if (!after) return "";
  if (!before) return after.trim();
  const index = after.indexOf(before.slice(-1000));
  if (index >= 0) return after.slice(index + Math.min(1000, before.length)).trim();
  return after.trim();
}
