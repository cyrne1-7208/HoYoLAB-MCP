import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { loadHoYoLabConfig, parseHoYoLabConfig, parseHoYoLabServerArgs, HoYoLabConfigError } from "../src/config/hoyolab-config.mjs";
import { createHoYoLabClient } from "../src/hoyolab/api.mjs";

async function directory(t) {
  const path = await mkdtemp(join(tmpdir(), "hoyolab-config-test-"));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

test("the YAML example retains the published defaults", () => {
  const text = readFileSync(new URL("../hoyolab.config.example.yaml", import.meta.url), "utf8");
  const result = parseHoYoLabConfig(text);
  assert.deepEqual(result.settings, { language: "", gameId: 2,
    api: { timeoutMs: 20000, minRequestIntervalMs: 100, concurrency: 4, maxQueue: 24 } });
  assert.deepEqual(result.apiClientOptions, { timeoutMs: 20000, minRequestIntervalMs: 100, concurrency: 4,
    maxQueue: 24, defaultLanguage: "", defaultGameId: 2 });
});

test("partial YAML normalizes language aliases and preserves zero limits", () => {
  const result = parseHoYoLabConfig("# Supported aliases and deliberate zeros\nlanguage: JP\napi:\n  minRequestIntervalMs: 0\n  maxQueue: 0\n");
  assert.deepEqual(result.apiClientOptions, { minRequestIntervalMs: 0, maxQueue: 0, defaultLanguage: "ja-jp" });
  assert.deepEqual(parseHoYoLabConfig("# Defaults only\n").apiClientOptions, {});
  assert.deepEqual(parseHoYoLabConfig("{}").apiClientOptions, {});
});

test("invalid setting types and ranges are startup errors rather than silent defaults", () => {
  const inputs = ["language: unsupported", "language: [en-us]", "gameId: -1", "gameId: 100001", "gameId: '2'",
    "api: false", "api:\n  timeoutMs: 0", "api:\n  timeoutMs: 2147483648", "api:\n  concurrency: 0",
    "api:\n  concurrency: 33", "api:\n  concurrency: '4'", "api:\n  maxQueue: -1", "api:\n  maxQueue: 1001",
    "api:\n  minRequestIntervalMs: 10001", "api:\n  minRequestIntervalMs: 0.5", "api:\n  minRequestIntervalMs: .inf", "[]", "null"];
  for (const text of inputs) assert.throws(() => parseHoYoLabConfig(text), HoYoLabConfigError);
});

test("malformed YAML, duplicate keys, unsupported keys, aliases and tags never expose values", () => {
  const marker = "DO_NOT_LOG_CONFIGURATION_VALUE";
  const inputs = ["language: [" + marker, "language: en-us\nlanguage: " + marker,
    "unexpected: " + marker, "api:\n  unexpected: " + marker, marker + ": en-us", "language: " + marker,
    "language: &value en-us\ngameId: *value", "language: !unsupported " + marker,
    "language: en-us\n---\nlanguage: " + marker];
  for (const text of inputs) {
    assert.throws(() => parseHoYoLabConfig(text), (error) => error instanceof HoYoLabConfigError && !error.message.includes(marker));
  }
});

test("complex and oversized YAML is bounded before object conversion", () => {
  assert.throws(() => parseHoYoLabConfig("api: " + "[".repeat(40) + "0" + "]".repeat(40)), HoYoLabConfigError);
  assert.throws(() => parseHoYoLabConfig("api: [" + Array.from({ length: 1100 }, () => "0").join(",") + "]"), HoYoLabConfigError);
  assert.deepEqual(parseHoYoLabConfig("#".repeat(64 * 1024)).apiClientOptions, {});
  assert.throws(() => parseHoYoLabConfig("#".repeat(64 * 1024 + 1)), HoYoLabConfigError);
});

test("missing default files permit legacy startup but explicit missing files fail", async (t) => {
  const cwd = await directory(t);
  assert.equal(loadHoYoLabConfig({ cwd }), undefined);
  assert.throws(() => loadHoYoLabConfig({ cwd, configPath: "missing.yaml" }), HoYoLabConfigError);
  assert.throws(() => loadHoYoLabConfig({ cwd, configPath: "" }), HoYoLabConfigError);
});

test("default, relative and absolute configuration paths select only the requested file", async (t) => {
  const cwd = await directory(t);
  await mkdir(join(cwd, "settings"));
  await writeFile(join(cwd, "hoyolab.config.yaml"), "language: ja-jp\n");
  const explicit = join(cwd, "settings", "custom.yaml");
  await writeFile(explicit, "language: zh-cn\n");
  assert.equal(loadHoYoLabConfig({ cwd }).settings.language, "ja-jp");
  assert.equal(loadHoYoLabConfig({ cwd, configPath: "settings/custom.yaml" }).settings.language, "zh-cn");
  assert.equal(loadHoYoLabConfig({ cwd, configPath: explicit }).settings.language, "zh-cn");
});

test("the loader rejects directories, invalid UTF-8 and oversized files", async (t) => {
  const cwd = await directory(t);
  assert.throws(() => loadHoYoLabConfig({ configPath: cwd }), HoYoLabConfigError);
  await writeFile(join(cwd, "invalid.yaml"), Buffer.from([0xff, 0xfe, 0xff]));
  assert.throws(() => loadHoYoLabConfig({ cwd, configPath: "invalid.yaml" }), HoYoLabConfigError);
  await writeFile(join(cwd, "large.yaml"), Buffer.alloc(64 * 1024 + 1, 35));
  assert.throws(() => loadHoYoLabConfig({ cwd, configPath: "large.yaml" }), HoYoLabConfigError);
});

test("command arguments support explicit files and reject ambiguous or unknown selectors", () => {
  assert.deepEqual(parseHoYoLabServerArgs([]), { configPath: undefined });
  assert.deepEqual(parseHoYoLabServerArgs(["--config", "settings.yaml"]), { configPath: "settings.yaml" });
  assert.deepEqual(parseHoYoLabServerArgs(["--config=settings.yaml"]), { configPath: "settings.yaml" });
  for (const args of [["--config"], ["--config="], ["--config", "--other"], ["--unknown"], ["extra.yaml"],
    ["--config", "a.yaml", "--config=b.yaml"]]) assert.throws(() => parseHoYoLabServerArgs(args), HoYoLabConfigError);
});

test("YAML API options control shared pacing and request defaults", async (t) => {
  const key = "HOYOLAB_API_MIN_REQUEST_INTERVAL_MS";
  const previous = process.env[key];
  process.env[key] = "10000";
  t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
  const { apiClientOptions } = parseHoYoLabConfig("language: JP\ngameId: 6\napi:\n  minRequestIntervalMs: 50\n  timeoutMs: 5000\n");
  const starts = [];
  const requests = [];
  const api = createHoYoLabClient({ ...apiClientOptions, maxRetries: 0, fetchImpl: async (url, options) => {
    starts.push(performance.now()); requests.push({ url: new URL(url), language: options.headers["x-rpc-language"] });
    return new Response(JSON.stringify({ retcode: 0, data: {} }));
  } });
  await Promise.all([api.searchPosts({ keyword: "fixture" }), api.getWiki({ wikiApp: "hsr", entryPageId: "202" })]);
  assert.ok(starts[1] - starts[0] >= 50);
  assert.equal(requests[0].url.searchParams.get("game_id"), "6");
  assert.deepEqual(requests.map((request) => request.language), ["ja-jp", "ja-jp"]);
});
