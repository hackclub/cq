import { createApp } from "./app.js";
import { getConfig } from "./config.js";

const config = getConfig();
const app = await createApp({ config });

const server = app.listen(config.port, () => {
  console.info(`CQ is listening at ${config.baseUrl}`);
});

function shutdown(signal) {
  console.info(`${signal} received, closing CQ.`);
  server.close(() => {
    process.exit(0);
  });
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
