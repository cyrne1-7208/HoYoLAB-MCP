import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const scenarios = [
  { name: "debug logging without an env file", environment: { HOYOLAB_LANGUAGE: "en-us", DOTENV_CONFIG_QUIET: "false", DOTENV_CONFIG_DEBUG: "true" }, expected: "en-us" },
  { name: "logging flags within the env file", file: "HOYOLAB_LANGUAGE=ja-jp\nDOTENV_CONFIG_DEBUG=true\nDOTENV_CONFIG_QUIET=false\n", expected: "ja-jp" },
  { name: "existing values retain precedence", environment: { HOYOLAB_LANGUAGE: "en-us", DOTENV_CONFIG_DEBUG: "true" }, file: "HOYOLAB_LANGUAGE=ja-jp\n", expected: "en-us" },
  { name: "a custom env file overrides existing values", environment: { HOYOLAB_LANGUAGE: "en-us", DOTENV_CONFIG_OVERRIDE: "true", DOTENV_CONFIG_DEBUG: "true" }, file: "HOYOLAB_LANGUAGE=zh-cn\nDOTENV_CONFIG_DEBUG=true\nDOTENV_CONFIG_QUIET=false\n", customPath: true, expected: "zh-cn" }
];

for (const scenario of scenarios) test(`stdio keeps valid JSON-RPC and dotenv semantics: ${scenario.name}`, { timeout: 10000 }, async (t) => {
  const stdioDirectory = await mkdtemp(join(tmpdir(), "hoyolab-stdio-test-"));
  // Preserve the parent process environment while isolating dotenv selectors and app defaults for each test.
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("DOTENV_") && !key.startsWith("HOYOLAB_")));
  Object.assign(environment, scenario.environment);
  if (scenario.file) {
    const configPath = join(stdioDirectory, scenario.customPath ? "settings.env" : ".env");
    await writeFile(configPath, scenario.file, { mode: 0o600 });
    if (scenario.customPath) environment.DOTENV_CONFIG_PATH = configPath;
  }
  const client = new Client({ name: "stdio-wire-test", version: "0.1.0" });
  const errors = [];
  client.onerror = (error) => errors.push(error);
  const transport = new StdioClientTransport({ command: process.execPath,
    args: ["--import", fileURLToPath(new URL("./fixtures/stdio-fetch.mjs", import.meta.url)), fileURLToPath(new URL("../scripts/mcp-server.mjs", import.meta.url))],
    cwd: stdioDirectory, env: environment, stderr: "pipe" });
  transport.stderr.on("data", () => {});
  t.after(async () => { await client.close(); await transport.close(); await rm(stdioDirectory, { recursive: true, force: true }); });
  await client.connect(transport);
  const listed = await client.listTools();
  assert.equal(listed.tools.length, 8);
  assert.ok(listed.tools.every((tool) => tool.annotations.readOnlyHint && tool.outputSchema));
  const invalid = await client.callTool({ name: "read_hoyolab_article", arguments: { post_id: "not-numeric" } });
  assert.equal(invalid.isError, true);
  const article = await client.callTool({ name: "read_hoyolab_article", arguments: { post_id: "101" } });
  assert.equal(article.isError, undefined, article.content?.[0]?.text);
  assert.match(article.structuredContent.mdx, /STDIO-FIXTURE-BODY/);
  assert.equal(article.structuredContent.requested_language, scenario.expected);
  assert.equal(article.structuredContent.actual_language, scenario.expected);
  assert.deepEqual(errors, [], "Non-protocol stdout or transport errors occurred during startup");
});
