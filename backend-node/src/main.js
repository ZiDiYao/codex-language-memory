import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createPool, checkSchema } from "./database.js";
import { Repository } from "./repository.js";

export async function start(environment = process.env) {
  const config = loadConfig(environment);
  const pool = createPool(config.databaseUrl);
  const handler = createApp({ config, repositoryFactory: (principal) => new Repository(pool, principal), readiness: () => checkSchema(pool) });
  const server = createServer(handler);
  server.requestTimeout = 30000;
  server.headersTimeout = 10000;
  server.on("clientError", (_error, socket) => { socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n"); });
  try {
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(config.port, config.host, resolve); });
  } catch {
    await pool.end();
    throw new Error("Cloud service startup failed");
  }
  let closing;
  function close() {
    closing ??= (async () => {
      // An open MCP SSE response must not prevent a deployment from stopping.
      const forceClose = setTimeout(() => server.closeAllConnections(), 5000);
      forceClose.unref();
      try { await new Promise((resolve) => server.close(resolve)); }
      finally { clearTimeout(forceClose); await pool.end(); }
    })();
    return closing;
  }
  return { server, pool, close };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const service = await start();
    let closing = false;
    for (const signal of ["SIGTERM", "SIGINT"]) process.once(signal, async () => {
      if (closing) return;
      closing = true;
      try { await service.close(); }
      catch { console.error("cloud_shutdown_failed"); process.exitCode = 1; }
    });
  } catch {
    // Configuration/database exceptions may contain credentials. Emit only a fixed code.
    console.error("cloud_startup_failed");
    process.exitCode = 1;
  }
}
