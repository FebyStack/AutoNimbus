import "dotenv/config";
import { afterAll, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { createDb } from "../db/client.js";

const url = process.env.DATABASE_URL;

const graph = {
  nodes: [
    {
      id: "t1",
      type: "core.manual-trigger",
      kind: "trigger",
      label: "When I click Run",
      config: {},
      position: { x: 0, y: 0 },
    },
  ],
  edges: [],
};

describe.skipIf(!url)("workflows API", () => {
  const { db, pool } = createDb(url!);
  const app = buildApp({ db });
  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  it("creates, reads, updates, lists and deletes a workflow", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/workflows",
      payload: { name: "Test flow", graph },
    });
    expect(created.statusCode).toBe(201);
    const { id } = created.json();

    const got = await app.inject({ method: "GET", url: `/api/workflows/${id}` });
    expect(got.json().name).toBe("Test flow");

    const updated = await app.inject({
      method: "PATCH",
      url: `/api/workflows/${id}`,
      payload: { name: "Renamed flow" },
    });
    expect(updated.json().name).toBe("Renamed flow");

    const list = await app.inject({ method: "GET", url: "/api/workflows" });
    expect(list.json().some((w: { id: string }) => w.id === id)).toBe(true);

    const del = await app.inject({ method: "DELETE", url: `/api/workflows/${id}` });
    expect(del.statusCode).toBe(204);
  });

  it("rejects an invalid graph with a friendly error", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/workflows",
      payload: { name: "Bad", graph: { nodes: [{ id: "x" }], edges: [] } },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().friendlyMessage).toBeTruthy();
  });

  it("rejects a missing or blank name with a friendly error", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/workflows",
      payload: { graph },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("INVALID_WORKFLOW");

    const blank = await app.inject({
      method: "POST",
      url: "/api/workflows",
      payload: { name: "   ", graph },
    });
    expect(blank.statusCode).toBe(400);
  });

  it("rejects an unknown status with a friendly error", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/workflows",
      payload: { name: "Status check", graph },
    });
    const { id } = created.json();
    const res = await app.inject({
      method: "PATCH",
      url: `/api/workflows/${id}`,
      payload: { status: "banana" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("INVALID_WORKFLOW");
    await app.inject({ method: "DELETE", url: `/api/workflows/${id}` });
  });

  it("404s with a friendly error for a missing workflow", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/workflows/00000000-0000-0000-0000-000000000000",
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe("WORKFLOW_NOT_FOUND");
  });
});
