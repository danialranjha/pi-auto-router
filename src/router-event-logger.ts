import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const DEFAULT_EVENTS_PATH = path.join(os.homedir(), ".pi", "agent", "extensions", "auto-router.events.jsonl");

type RouterEventEnvelope<T = Record<string, unknown>> = {
  type: string;
  timestamp: string;
  requestId: string;
  conversationId: string;
  routeId: string;
  version: 1;
  data: T;
};

export class RouterEventLogger {
  constructor(private readonly filePath = DEFAULT_EVENTS_PATH) {}

  log<T extends Record<string, unknown>>(event: RouterEventEnvelope<T>): void {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.appendFileSync(this.filePath, JSON.stringify(event) + "\n");
    } catch {
      // best-effort
    }
  }

  clear(): void {
    try {
      fs.writeFileSync(this.filePath, "");
    } catch {
      // best-effort
    }
  }

  get logFilePath(): string {
    return this.filePath;
  }
}

export type { RouterEventEnvelope };
