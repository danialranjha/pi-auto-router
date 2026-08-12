import { accessSync, constants, mkdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

export const DEFAULT_AUTO_ROUTER_LOG_DIR = join(homedir(), ".pi", "agent", "extensions");
export const DEFAULT_ROUTES_CONFIG_PATH = join(DEFAULT_AUTO_ROUTER_LOG_DIR, "auto-router.routes.json");

export type AutoRouterStoragePaths = {
  directory: string;
  decisions: string;
  events: string;
  stats: string;
  latency: string;
  ratings: string;
};

export function readConfiguredLogDir(configPath = DEFAULT_ROUTES_CONFIG_PATH): string | undefined {
  try {
    const parsed = JSON.parse(readFileSync(configPath, "utf8")) as { logDir?: unknown };
    return typeof parsed.logDir === "string" ? parsed.logDir : undefined;
  } catch {
    return undefined;
  }
}

export function resolveAutoRouterLogDir(options: {
  env?: NodeJS.ProcessEnv;
  configLogDir?: unknown;
  homeDir?: string;
} = {}): string {
  const env = options.env ?? process.env;
  const configured = env.AUTO_ROUTER_LOG_DIR ?? options.configLogDir;
  if (configured !== undefined && (typeof configured !== "string" || configured.trim() === "")) {
    throw new Error("AUTO_ROUTER_LOG_DIR/logDir must be a non-empty path");
  }
  if (typeof configured !== "string") return options.homeDir ? join(options.homeDir, ".pi", "agent", "extensions") : DEFAULT_AUTO_ROUTER_LOG_DIR;

  const expanded = configured.startsWith("~/")
    ? join(options.homeDir ?? homedir(), configured.slice(2))
    : configured;
  return isAbsolute(expanded) ? resolve(expanded) : resolve(expanded);
}

/** Create and verify the directory before any writer switches to it. */
export function ensureAutoRouterLogDir(directory: string): void {
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (!statSync(directory).isDirectory()) throw new Error("path is not a directory");
    accessSync(directory, constants.W_OK);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Auto-router log directory is not writable: ${directory} (${detail})`);
  }
}

export function getAutoRouterStoragePaths(options: {
  env?: NodeJS.ProcessEnv;
  configLogDir?: unknown;
  homeDir?: string;
  ensure?: boolean;
} = {}): AutoRouterStoragePaths {
  const directory = resolveAutoRouterLogDir(options);
  if (options.ensure !== false) ensureAutoRouterLogDir(directory);
  return {
    directory,
    decisions: join(directory, "auto-router.decisions.jsonl"),
    events: join(directory, "auto-router.events.jsonl"),
    stats: join(directory, "auto-router.stats.json"),
    latency: join(directory, "auto-router.latency.json"),
    ratings: join(directory, "auto-router.ratings.json"),
  };
}
