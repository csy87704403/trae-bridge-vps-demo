import "dotenv/config";
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
  responseTimeoutMs: Number(process.env.RESPONSE_TIMEOUT_MS || 120000),
  freshSessionPerRequest: String(process.env.FRESH_SESSION_PER_REQUEST || "true") !== "false",
  headlessService: String(process.env.HEADLESS_SERVICE || "true") !== "false",
  remoteDisplay: process.env.REMOTE_DISPLAY || "auto",
  loginDisplay: process.env.LOGIN_DISPLAY || ":99",
  vncPort: Number(process.env.VNC_PORT || 5900),
  noVncPort: Number(process.env.NOVNC_PORT || 6080),
  noVncWebRoot: process.env.NOVNC_WEB_ROOT || "/usr/share/novnc",
  proxyServer: process.env.PROXY_SERVER || "",
  proxyUsername: process.env.PROXY_USERNAME || "",
  proxyPassword: process.env.PROXY_PASSWORD || "",
  profileDir: path.join(root, "data", "profile"),
  stateFile: path.join(root, "data", "state.json")
};

export function shouldUseRemoteDisplay() {
  if (config.remoteDisplay === "true") return true;
  if (config.remoteDisplay === "false") return false;
  return process.platform !== "win32" && process.platform !== "darwin";
}

export function publicConfig() {
  return {
    remoteDisplay: config.remoteDisplay,
    remoteDisplayEnabled: shouldUseRemoteDisplay(),
    freshSessionPerRequest: config.freshSessionPerRequest,
    proxyEnabled: Boolean(config.proxyServer),
    proxyServer: redactProxy(config.proxyServer)
  };
}

function redactProxy(value) {
  if (!value) return "";
  try {
    const url = new URL(value);
    if (url.username || url.password) {
      url.username = "***";
      url.password = "***";
    }
    return url.toString();
  } catch {
    return value.replace(/\/\/([^:@/]+):([^@/]+)@/, "//***:***@");
  }
}
