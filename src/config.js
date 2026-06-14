import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const config = {
  root,
  host: process.env.HOST || "127.0.0.1",
  port: Number(process.env.PORT || 39280),
  adminPassword: process.env.ADMIN_PASSWORD || "change-me",
  traeUrl: process.env.TRAE_URL || "https://work.trae.cn/",
  chromeChannel: process.env.CHROME_CHANNEL || "chrome",
  browserIdleMs: Number(process.env.BROWSER_IDLE_MS || 300000),
  headlessService: String(process.env.HEADLESS_SERVICE || "true") !== "false",
  profileDir: path.join(root, "data", "profile"),
  stateFile: path.join(root, "data", "state.json")
};
