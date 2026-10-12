import { createRequire } from "node:module";
import { serveHoYoLabMcp } from "../src/mcp/hoyolab-server.mjs";
import { createHoYoLabClient } from "../src/hoyolab/api.mjs";
import { loadHoYoLabConfig, parseHoYoLabServerArgs } from "../src/config/hoyolab-config.mjs";

async function start() {
  const config = loadHoYoLabConfig(parseHoYoLabServerArgs(process.argv.slice(2)));
  if (!config) {
    // Keep legacy launches compatible only when no YAML file was selected; stdout always belongs to JSON-RPC.
    const stdoutLog = console.log;
    try {
      console.log = (...values) => console.error(...values);
      createRequire(import.meta.url)("dotenv/config");
    } finally {
      console.log = stdoutLog;
    }
  }
  return serveHoYoLabMcp({ apiClient: createHoYoLabClient(config?.apiClientOptions) });
}

start().catch((error) => {
  console.error("hoyolab-mcp: " + (error instanceof Error ? error.stack || error.message : String(error)));
  process.exitCode = 1;
});
