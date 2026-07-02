import "dotenv/config";
import { afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDb } from "../db/client.js";
import { workflows } from "../db/schema.js";

const url = process.env.DATABASE_URL;

describe.skipIf(!url)("database", () => {
  const { db, pool } = createDb(url!);
  afterAll(() => pool.end());

  it("inserts and reads a workflow row", async () => {
    const [row] = await db
      .insert(workflows)
      .values({ name: "smoke-test", graph: { nodes: [], edges: [] } })
      .returning();
    expect(row.id).toBeTruthy();
    expect(row.status).toBe("draft");
    const found = await db.select().from(workflows).where(eq(workflows.id, row.id));
    expect(found).toHaveLength(1);
    await db.delete(workflows).where(eq(workflows.id, row.id));
  });
});
