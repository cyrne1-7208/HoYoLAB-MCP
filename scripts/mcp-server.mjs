import "dotenv/config";

import { serveHoYoLabMcp } from "../src/mcp/hoyolab-server.mjs";

serveHoYoLabMcp().catch((error) => {
  console.error("hoyolab-mcp: " + (error instanceof Error ? error.stack || error.message : String(error)));
  process.exitCode = 1;
});
