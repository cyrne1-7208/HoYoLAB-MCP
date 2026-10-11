import { createRequire } from "node:module";
import { serveHoYoLabMcp } from "../src/mcp/hoyolab-server.mjs";

// stdout belongs exclusively to JSON-RPC. Load dotenv synchronously so its optional startup logs use stderr without changing its configuration precedence or leaving console modified during serving.
const stdoutLog = console.log;
try {
  console.log = (...values) => console.error(...values);
  createRequire(import.meta.url)("dotenv/config");
} finally {
  console.log = stdoutLog;
}

serveHoYoLabMcp().catch((error) => {
  console.error("hoyolab-mcp: " + (error instanceof Error ? error.stack || error.message : String(error)));
  process.exitCode = 1;
});
