import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const script = fileURLToPath(new URL("../scripts/mcp-server.mjs", import.meta.url));
const fixture = fileURLToPath(new URL("./fixtures/stdio-fetch.mjs", import.meta.url));
const environment = (values = {}) => ({ ...Object.fromEntries(Object.entries(process.env)
  .filter(([key]) => !key.startsWith("HOYOLAB_") && !key.startsWith("DOTENV_"))), ...values });

async function prepare(t, files) {
  const cwd = await mkdtemp(join(tmpdir(), "hoyolab-config-stdio-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  for (const [name, text] of Object.entries(files)) {
    const path = join(cwd, name);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, text, { mode: 0o600 });
  }
  return cwd;
}

const cases = [
  { name: "automatic YAML skips dotenv and overrides inherited settings", files: {
    "hoyolab.config.yaml": "language: JP\napi:\n  minRequestIntervalMs: 0\n",
    ".env": "HOYOLAB_LANGUAGE=zh-cn\nDOTENV_CONFIG_DEBUG=true\nDOTENV_CONFIG_OVERRIDE=true\n"
  }, env: { HOYOLAB_LANGUAGE: "en-us", DOTENV_CONFIG_DEBUG: "true" }, expected: "ja-jp" },
  { name: "an explicit relative path does not read the default YAML", files: {
    "hoyolab.config.yaml": "unknown: ignored-default\n", "settings/custom.yaml": "language: zh-cn\n",
    ".env": "HOYOLAB_LANGUAGE=en-us\nDOTENV_CONFIG_DEBUG=true\n"
  }, args: ["--config", "settings/custom.yaml"], expected: "zh-cn" },
  { name: "partial YAML keeps inherited defaults without reading dotenv", files: {
    "hoyolab.config.yaml": "api:\n  minRequestIntervalMs: 0\n", ".env": "HOYOLAB_LANGUAGE=zh-cn\nDOTENV_CONFIG_OVERRIDE=true\n"
  }, env: { HOYOLAB_LANGUAGE: "en-us" }, expected: "en-us" },
  { name: "tool arguments override YAML language", files: { "hoyolab.config.yaml": "language: ja-jp\n" },
    toolLanguage: "en-us", expected: "en-us" }
];

for (const scenario of cases) test(`YAML startup preserves MCP stdio: ${scenario.name}`, { timeout: 10000 }, async (t) => {
  const cwd = await prepare(t, scenario.files);
  const client = new Client({ name: "config-wire-test", version: "0.1.0" });
  const errors = [];
  let stderr = "";
  client.onerror = (error) => errors.push(error);
  const transport = new StdioClientTransport({ command: process.execPath, args: ["--import", fixture, script, ...(scenario.args || [])],
    cwd, env: environment(scenario.env), stderr: "pipe" });
  transport.stderr.on("data", (data) => { stderr += data.toString(); });
  t.after(async () => { await client.close(); await transport.close(); });
  await client.connect(transport);
  assert.equal((await client.listTools()).tools.length, 8);
  const article = await client.callTool({ name: "read_hoyolab_article", arguments: { post_id: "101", ...(scenario.toolLanguage ? { language: scenario.toolLanguage } : {}) } });
  assert.equal(article.isError, undefined, article.content?.[0]?.text);
  assert.match(article.structuredContent.mdx, /STDIO-FIXTURE-BODY/);
  assert.equal(article.structuredContent.requested_language, scenario.expected);
  assert.equal(article.structuredContent.actual_language, scenario.expected);
  assert.deepEqual(errors, []);
  assert.equal(stderr, "", "YAML startup must not initialize dotenv or print configuration values");
});

async function startup(cwd, args = []) {
  const child = spawn(process.execPath, [script, ...args], { cwd, env: environment(), stdio: ["pipe", "pipe", "pipe"] });
  const stdout = [];
  const stderr = [];
  child.stdout.on("data", (data) => stdout.push(data));
  child.stderr.on("data", (data) => stderr.push(data));
  const result = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", (code) => resolve(code)); });
  return { code: result, stdout: Buffer.concat(stdout).toString(), stderr: Buffer.concat(stderr).toString() };
}

test("invalid YAML fails before MCP starts without leaking the source value", { timeout: 10000 }, async (t) => {
  const marker = "DO_NOT_LOG_THIS_CONFIGURATION_VALUE";
  const cwd = await prepare(t, { "hoyolab.config.yaml": "unexpected: " + marker });
  const result = await startup(cwd);
  assert.equal(result.code, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /Invalid HoYoLAB configuration/);
  assert.ok(!result.stderr.includes(marker));
});

test("an explicitly missing configuration fails instead of loading dotenv", { timeout: 10000 }, async (t) => {
  const cwd = await prepare(t, { ".env": "DOTENV_CONFIG_DEBUG=true\nDOTENV_CONFIG_QUIET=false\n" });
  const result = await startup(cwd, ["--config=missing.yaml"]);
  assert.equal(result.code, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /explicitly selected file does not exist/);
  assert.doesNotMatch(result.stderr, /dotenv/i);
});
