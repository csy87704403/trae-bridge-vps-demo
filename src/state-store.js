import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";

export class StateStore {
  constructor(file = config.stateFile) {
    this.file = file;
    this.state = {
      mode: "stopped",
      loggedIn: false,
      currentUrl: "",
      lastError: "",
      lastRequestAt: null,
      lastStartedAt: null
    };
  }

  async load() {
    try {
      const raw = await fs.readFile(this.file, "utf8");
      this.state = { ...this.state, ...JSON.parse(raw) };
    } catch {
      await this.save();
    }
    return this.state;
  }

  async patch(next) {
    this.state = { ...this.state, ...next };
    await this.save();
    return this.state;
  }

  async save() {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    await fs.writeFile(this.file, JSON.stringify(this.state, null, 2));
  }
}
