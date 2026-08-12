import { homedir } from "node:os";
import { join } from "node:path";
import { createModelStatusExtension } from "./src/model-status.ts";

export const AUTO_ROUTER_EVENTS_PATH = join(
  homedir(),
  ".pi",
  "agent",
  "extensions",
  "auto-router.events.jsonl",
);

export default createModelStatusExtension({ eventsPath: AUTO_ROUTER_EVENTS_PATH });
export * from "./src/model-status.ts";
