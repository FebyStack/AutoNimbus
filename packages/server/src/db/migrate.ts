import "dotenv/config";
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { createDb } from "./client.js";

const { db, pool } = createDb(process.env.DATABASE_URL!);
await migrate(db, { migrationsFolder: fileURLToPath(new URL("./migrations", import.meta.url)) });
await pool.end();
console.log("migrations applied");
