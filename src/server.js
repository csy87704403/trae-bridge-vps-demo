import express from "express";
import path from "node:path";
import { config } from "./config.js";
import { StateStore } from "./state-store.js";
import { BrowserWorker } from "./browser-worker.js";
import { RemoteDisplay } from "./remote-display.js";
import { completionResponse, promptFromChat, streamResponse } from "./openai-adapter.js";

const app = express();
const store = new StateStore();
await store.load();
const worker = new BrowserWorker(store);
worker.remoteDisplay = new RemoteDisplay();

app.use(express.json({ limit: "3mb" }));
app.use("/public", express.static(path.join(config.root, "public")));

app.get("/", (_req, res) => res.redirect("/admin"));
app.get("/admin", (_req, res) => {
  res.sendFile(path.join(config.root, "public", "admin.html"));
});

app.get("/health", async (_req, res) => {
  res.json(await worker.status());
});

app.get("/v1/models", (_req, res) => {
  res.json({
    object: "list",
    data: [{ id: "trae-auto", object: "model", created: 0, owned_by: "trae" }]
  });
});

app.post("/v1/chat/completions", async (req, res) => {
  try {
    const model = req.body?.model || "trae-auto";
    const prompt = promptFromChat(req.body);
    if (!prompt.trim()) {
      res.status(400).json({ error: { message: "messages is required" } });
      return;
    }
    const result = await worker.chat(prompt);
    if (req.body?.stream) {
      streamResponse(res, { model, content: result.text });
      return;
    }
    res.json(completionResponse({ model, content: result.text }));
  } catch (error) {
    await store.patch({ lastError: String(error?.message || error) });
    res.status(502).json({
      error: {
        type: "trae_bridge_error",
        message: String(error?.message || error)
      }
    });
  }
});

app.get("/admin/api/status", requireAdmin, async (_req, res) => {
  res.json(await worker.status());
});

app.post("/admin/api/browser/start-login", requireAdmin, async (_req, res) => {
  try {
    res.json(await worker.startLogin());
  } catch (error) {
    await store.patch({ lastError: String(error?.message || error) });
    res.status(500).json({ ok: false, error: String(error?.message || error) });
  }
});

app.post("/admin/api/browser/start-service", requireAdmin, async (_req, res) => {
  try {
    res.json(await worker.startService());
  } catch (error) {
    await store.patch({ lastError: String(error?.message || error) });
    res.status(500).json({ ok: false, error: String(error?.message || error) });
  }
});

app.post("/admin/api/browser/stop", requireAdmin, async (_req, res) => {
  res.json(await worker.stop());
});

app.post("/admin/api/trae/open", requireAdmin, async (_req, res) => {
  try {
    await worker.ensureService();
    await worker.openTrae();
    res.json(await worker.status());
  } catch (error) {
    await store.patch({ lastError: String(error?.message || error) });
    res.status(500).json({ ok: false, error: String(error?.message || error) });
  }
});

app.post("/admin/api/test-chat", requireAdmin, async (req, res) => {
  try {
    const prompt = String(req.body?.prompt || "回复 ok");
    res.json(await worker.chat(prompt));
  } catch (error) {
    await store.patch({ lastError: String(error?.message || error) });
    res.status(500).json({ ok: false, error: String(error?.message || error) });
  }
});

function requireAdmin(req, res, next) {
  const password = req.get("x-admin-password") || req.query.password || "";
  if (config.adminPassword !== "change-me" && password !== config.adminPassword) {
    res.status(401).json({ ok: false, error: "Unauthorized" });
    return;
  }
  next();
}

app.listen(config.port, config.host, () => {
  console.log(`TRAE bridge VPS demo listening on http://${config.host}:${config.port}`);
  console.log(`Admin UI: http://${config.host}:${config.port}/admin`);
});
