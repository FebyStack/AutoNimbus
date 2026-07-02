import "dotenv/config";
import { createLogger } from "@autonimbus/shared";
import { buildApp } from "./app.js";
import { serverConfig } from "./config.js";
import { createDb } from "./db/client.js";

const log = createLogger("server");
const { db } = createDb(process.env.DATABASE_URL!);
const app = buildApp({ db });
await app.listen({ host: serverConfig.host, port: serverConfig.port });
log.info(`AutoNimbus listening on http://${serverConfig.host}:${serverConfig.port}`);
