import "dotenv/config";
import { afterAll, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { createDb } from "../db/client.js";

const url = process.env.DATABASE_URL;

const graph = {
  nodes: [
    { id: "t1", type: "core.manual-trigger", kind: "trigger", label: "Run", config: { payload: { secretNote: "Bearer sk_live_abcdef1234567890xx", price: 450 } }, position: { x: 0, y: 0 } },
    { id: "a1", type: "core.set-data", kind: "action", label: "Set", config: { data: { done: true } }, position: { x: 200, y: 0 } },
  ],
  edges: [{ id: "e1", from: "t1", to: "a1" }],
};

describe.skipIf(!url)("runs API", () => {
  const { db, pool } = createDb(url!);
  const app = buildApp({ db });
  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  it("executes a workflow, persists the run and redacted step snapshots", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/workflows",
      payload: { name: "Runnable", graph },
    });
    const workflowId = created.json().id;

    const runRes = await app.inject({
      method: "POST",
      url: `/api/workflows/${workflowId}/run`,
    });
    expect(runRes.statusCode).toBe(201);
    const run = runRes.json();
    expect(run.status).toBe("success");

    const detail = await app.inject({ method: "GET", url: `/api/runs/${run.id}` });
    const body = detail.json();
    expect(body.run.workflowId).toBe(workflowId);
    expect(body.steps).toHaveLength(2);
    expect(body.steps[1].outputSnapshot).toEqual({ done: true });
    // Spec §12: secret-shaped values never reach stored snapshots.
    expect(JSON.stringify(body.steps)).not.toContain("sk_live_abcdef1234567890xx");

    await app.inject({ method: "DELETE", url: `/api/workflows/${workflowId}` });
  });

  it("lists runs for a workflow", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/workflows",
      payload: { name: "Listable", graph },
    });
    const workflowId = created.json().id;
    await app.inject({ method: "POST", url: `/api/workflows/${workflowId}/run` });
    const list = await app.inject({ method: "GET", url: `/api/workflows/${workflowId}/runs` });
    expect(list.json().length).toBeGreaterThanOrEqual(1);
    await app.inject({ method: "DELETE", url: `/api/workflows/${workflowId}` });
  });

  it("records a failed run with the error summary", async () => {
    const badGraph = {
      nodes: [
        { id: "t1", type: "core.manual-trigger", kind: "trigger", label: "Run", config: {}, position: { x: 0, y: 0 } },
        { id: "a1", type: "core.not-installed", kind: "action", label: "Missing", config: {}, position: { x: 200, y: 0 } },
      ],
      edges: [{ id: "e1", from: "t1", to: "a1" }],
    };
    const created = await app.inject({
      method: "POST",
      url: "/api/workflows",
      payload: { name: "Broken", graph: badGraph },
    });
    const workflowId = created.json().id;
    const runRes = await app.inject({ method: "POST", url: `/api/workflows/${workflowId}/run` });
    expect(runRes.json().status).toBe("failed");
    expect(runRes.json().errorSummary).toMatch(/isn't installed/i);
    await app.inject({ method: "DELETE", url: `/api/workflows/${workflowId}` });
  });
});
