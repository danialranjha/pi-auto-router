import { createModelStatusExtension } from "./src/model-status.ts";
import { getAutoRouterStoragePaths, readConfiguredLogDir } from "./src/storage-paths.ts";

export const AUTO_ROUTER_EVENTS_PATH = getAutoRouterStoragePaths({
  configLogDir: readConfiguredLogDir(),
}).events;

export default createModelStatusExtension({ eventsPath: AUTO_ROUTER_EVENTS_PATH });
export * from "./src/model-status.ts";
