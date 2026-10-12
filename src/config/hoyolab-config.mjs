import { constants, openSync, fstatSync, readSync, closeSync } from "node:fs";
import { resolve } from "node:path";
import YAML from "yaml";
import { z } from "zod";
import { normalizeHoYoLabLanguage } from "../hoyolab/api.mjs";

export const DEFAULT_CONFIG_FILENAME = "hoyolab.config.yaml";
const MAX_CONFIG_BYTES = 64 * 1024;
const descriptions = {
  language: "must be a supported language code or an empty string",
  gameId: "must be an integer from 0 to 100000",
  api: "must be a mapping containing only supported API settings",
  "api.timeoutMs": "must be an integer from 1 to 2147483647",
  "api.minRequestIntervalMs": "must be an integer from 0 to 10000",
  "api.concurrency": "must be an integer from 1 to 32",
  "api.maxQueue": "must be an integer from 0 to 1000"
};
const configSchema = z.object({
  language: z.string().refine((value) => {
    try { normalizeHoYoLabLanguage(value); return true; }
    catch { return false; }
  }).transform(normalizeHoYoLabLanguage).optional(),
  gameId: z.number().int().min(0).max(100000).optional(),
  api: z.object({
    timeoutMs: z.number().int().min(1).max(2147483647).optional(),
    minRequestIntervalMs: z.number().int().min(0).max(10000).optional(),
    concurrency: z.number().int().min(1).max(32).optional(),
    maxQueue: z.number().int().min(0).max(1000).optional()
  }).strict().optional()
}).strict();

export class HoYoLabConfigError extends Error {
  constructor(message) {
    super("Invalid HoYoLAB configuration: " + message);
    this.name = "HoYoLabConfigError";
  }
}

export function parseHoYoLabConfig(text) {
  if (typeof text !== "string" || Buffer.byteLength(text) > MAX_CONFIG_BYTES) {
    throw new HoYoLabConfigError("file must be UTF-8 text of at most 64KiB");
  }
  let parsed;
  try {
    const document = YAML.parseDocument(text, { prettyErrors: false, strict: true, uniqueKeys: true });
    if (document.errors.length || document.warnings.length) throw new Error("Invalid YAML");
    const pending = [{ node: document.contents, depth: 0 }];
    let nodes = 0;
    while (pending.length) {
      const { node, depth } = pending.pop();
      if (!node) continue;
      if (++nodes > 1024 || depth > 16 || YAML.isAlias(node)) throw new Error("Configuration is too complex");
      if (YAML.isPair(node)) pending.push({ node: node.key, depth: depth + 1 }, { node: node.value, depth: depth + 1 });
      else if (YAML.isCollection(node)) for (const item of node.items) pending.push({ node: item, depth: depth + 1 });
    }
    // Configurations are small scalar mappings; aliases and custom tags are not needed and must not expand arbitrary data.
    parsed = document.contents === null ? {} : document.toJS({ maxAliasCount: 0 });
  } catch {
    // Parser diagnostics can contain source values; only report a fixed message on stderr at startup.
    throw new HoYoLabConfigError("file must contain a single valid YAML mapping without aliases or custom tags");
  }
  const result = configSchema.safeParse(parsed);
  if (!result.success) {
    const issue = result.error.issues[0];
    const path = issue.path.join(".");
    const name = Object.hasOwn(descriptions, path) ? path : "configuration";
    const description = issue.code === "unrecognized_keys" ? "contains an unsupported setting"
      : descriptions[name] || "must be a mapping of supported settings";
    throw new HoYoLabConfigError(name + " " + description);
  }
  const settings = result.data;
  const apiClientOptions = { ...settings.api };
  if (settings.language !== undefined) apiClientOptions.defaultLanguage = settings.language;
  if (settings.gameId !== undefined) apiClientOptions.defaultGameId = settings.gameId;
  return { settings, apiClientOptions };
}

export function loadHoYoLabConfig({ configPath, cwd = process.cwd() } = {}) {
  if (configPath !== undefined && (typeof configPath !== "string" || !configPath.trim())) {
    throw new HoYoLabConfigError("--config requires a file path");
  }
  const filename = resolve(cwd, configPath ?? DEFAULT_CONFIG_FILENAME);
  let descriptor;
  try {
    // A nonblocking open lets us reject pipes/devices rather than hang before checking their type.
    descriptor = openSync(filename, constants.O_RDONLY | constants.O_NONBLOCK);
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.size > MAX_CONFIG_BYTES) throw new HoYoLabConfigError("file must be a regular file of at most 64KiB");
    const buffer = Buffer.alloc(MAX_CONFIG_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = readSync(descriptor, buffer, length, buffer.length - length, null);
      if (!count) break;
      length += count;
    }
    if (length > MAX_CONFIG_BYTES) throw new HoYoLabConfigError("file must be at most 64KiB");
    const text = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, length));
    return { ...parseHoYoLabConfig(text), filename };
  } catch (error) {
    if (error instanceof HoYoLabConfigError) throw error;
    if (error.code === "ENOENT" && configPath === undefined) return undefined;
    throw new HoYoLabConfigError(error.code === "ENOENT" ? "the explicitly selected file does not exist" : "file could not be read");
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

export function parseHoYoLabServerArgs(args) {
  let configPath;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument !== "--config" && !argument.startsWith("--config=")) {
      throw new HoYoLabConfigError("only --config <file> is supported");
    }
    if (configPath !== undefined) throw new HoYoLabConfigError("specify --config only once");
    const value = argument === "--config" ? args[++index] : argument.slice("--config=".length);
    if (!value?.trim() || value.startsWith("--")) throw new HoYoLabConfigError("--config requires a file path");
    configPath = value;
  }
  return { configPath };
}
