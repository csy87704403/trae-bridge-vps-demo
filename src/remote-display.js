import { spawn } from "node:child_process";
import { once } from "node:events";
import { config } from "./config.js";

export class RemoteDisplay {
  constructor() {
    this.processes = [];
    this.running = false;
  }

  async start() {
    if (this.running) return this.info();
    await ensureCommand("Xvfb");
    await ensureCommand("x11vnc");
    await ensureCommand("websockify");

    const xvfb = spawn("Xvfb", [
      config.loginDisplay,
      "-screen",
      "0",
      "1280x900x24",
      "-ac",
      "-nolisten",
      "tcp"
    ], { stdio: "ignore" });
    this.track(xvfb);
    await delay(700);
    ensureAlive(xvfb, "Xvfb");

    const x11vnc = spawn("x11vnc", [
      "-display",
      config.loginDisplay,
      "-forever",
      "-shared",
      "-nopw",
      "-rfbport",
      String(config.vncPort)
    ], { stdio: "ignore" });
    this.track(x11vnc);
    await delay(700);
    ensureAlive(x11vnc, "x11vnc");

    const websockify = spawn("websockify", [
      "--web",
      config.noVncWebRoot,
      String(config.noVncPort),
      `localhost:${config.vncPort}`
    ], { stdio: "ignore" });
    this.track(websockify);
    await delay(700);
    ensureAlive(websockify, "websockify");

    this.running = true;
    return this.info();
  }

  async stop() {
    for (const proc of [...this.processes].reverse()) {
      if (!proc.killed) proc.kill("SIGTERM");
    }
    await delay(300);
    for (const proc of [...this.processes].reverse()) {
      if (!proc.killed) proc.kill("SIGKILL");
    }
    this.processes = [];
    this.running = false;
    return this.info();
  }

  info() {
    return {
      running: this.running,
      display: config.loginDisplay,
      vncPort: config.vncPort,
      noVncPort: config.noVncPort,
      noVncPath: `/vnc.html?host=${locationHostPlaceholder}&port=${config.noVncPort}&autoconnect=1&resize=scale`
    };
  }

  track(proc) {
    this.processes.push(proc);
    proc.once("exit", () => {
      this.processes = this.processes.filter((item) => item !== proc);
      if (!this.processes.length) this.running = false;
    });
  }
}

const locationHostPlaceholder = "__HOST__";

async function ensureCommand(command) {
  const checker = spawn("sh", ["-lc", `command -v ${command}`], { stdio: "ignore" });
  const [code] = await once(checker, "exit");
  if (code !== 0) {
    throw new Error(
      `${command} is not installed. Run: sudo apt update && sudo apt install -y xvfb x11vnc novnc websockify`
    );
  }
}

function ensureAlive(proc, name) {
  if (proc.exitCode !== null) throw new Error(`${name} exited during startup`);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
