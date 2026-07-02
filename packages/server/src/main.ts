import "dotenv/config";
import { createLogger } from "@autonimbus/shared";
import { buildApp } from "./app.js";
import { serverConfig } from "./config.js";

const log = createLogger("server");
const app = buildApp();
await app.listen({ host: serverConfig.host, port: serverConfig.port });
log.info(`AutoNimbus listening on http://${serverConfig.host}:${serverConfig.port}`);
