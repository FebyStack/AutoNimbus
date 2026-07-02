import "dotenv/config";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { createDb } from "./client.js";

const { db, pool } = createDb(process.env.DATABASE_URL!);
await migrate(db, { migrationsFolder: new URL("./migrations", import.meta.url).pathname });
await pool.end();
console.log("migrations applied");
