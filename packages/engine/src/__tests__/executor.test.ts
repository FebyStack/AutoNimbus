import { describe, expect, it } from "vitest";
import { createLogger, type NodeModule, type WorkflowGraph } from "@autonimbus/shared";
import { NodeRegistry } from "../registry.js";
import { executeWorkflow } from "../executor.js";

const log = createLogger("test", { level: "silent" });

function makeRegistry(extra: NodeModule[] = []): NodeRegistry {
  const registry = new NodeRegistry();
  const base: NodeModule[] = [
    {
      manifest: { slug: "t.start", kind: "trigger", name: "Start", description: "", inputHint: "", outputHint: "" },
      run: async () => ({ price: 450 }),
    },
    {
      manifest: { slug: "t.double", kind: "action", name: "Double", description: "", inputHint: "", outputHint: "" },
      run: async (ctx) => ({ price: (ctx.input as { price: number }).price * 2 }),
    },
    {
      manifest: { slug: "t.cheap", kind: "rule", name: "Cheap?", description: "", inputHint: "", outputHint: "" },
      run: async (ctx) => (ctx.input as { price: number }).price < 500,
    },
  ];
  for (const mod of [...base, ...extra]) registry.register(mod);
  return registry;
}

function node(id: string, type: string, kind: "trigger" | "action" | "rule") {
  return { id, type, kind, label: id, config: {}, position: { x: 0, y: 0 } };
}

describe("executeWorkflow", () => {
  it("runs a linear chain passing data between nodes", async () => {
    const graph: WorkflowGraph = {
      nodes: [node("n1", "t.start", "trigger"), node("n2", "t.double", "action")],
      edges: [{ id: "e1", from: "n1", to: "n2" }],
    };
    const result = await executeWorkflow({ graph, registry: makeRegistry(), log });
    expect(result.status).toBe("success");
    expect(result.steps).toHaveLength(2);
    expect(result.steps[1].input).toEqual({ price: 450 });
    expect(result.steps[1].output).toEqual({ price: 900 });
  });

  it("follows the matching branch of a rule and keeps the rule's input", async () => {
    const graph: WorkflowGraph = {
      nodes: [
        node("n1", "t.start", "trigger"),
        node("n2", "t.cheap", "rule"),
        node("yes", "t.double", "action"),
        node("no", "t.double", "action"),
      ],
      edges: [
        { id: "e1", from: "n1", to: "n2" },
        { id: "e2", from: "n2", to: "yes", branch: "true" },
        { id: "e3", from: "n2", to: "no", branch: "false" },
      ],
    };
    const result = await executeWorkflow({ graph, registry: makeRegistry(), log });
    expect(result.status).toBe("success");
    expect(result.steps.map((s) => s.nodeId)).toEqual(["n1", "n2", "yes"]);
    expect(result.steps[2].input).toEqual({ price: 450 });
  });

  it("fails friendly when there is no trigger", async () => {
    const graph: WorkflowGraph = { nodes: [node("n2", "t.double", "action")], edges: [] };
    const result = await executeWorkflow({ graph, registry: makeRegistry(), log });
    expect(result.status).toBe("failed");
    expect(result.errorSummary).toMatch(/no trigger/i);
  });

  it("records a failed step with a friendly error and stops", async () => {
    const boom: NodeModule = {
      manifest: { slug: "t.boom", kind: "action", name: "Boom", description: "", inputHint: "", outputHint: "" },
      run: async () => {
        throw new Error("kaput");
      },
    };
    const graph: WorkflowGraph = {
      nodes: [node("n1", "t.start", "trigger"), node("n2", "t.boom", "action"), node("n3", "t.double", "action")],
      edges: [
        { id: "e1", from: "n1", to: "n2" },
        { id: "e2", from: "n2", to: "n3" },
      ],
    };
    const result = await executeWorkflow({ graph, registry: makeRegistry([boom]), log });
    expect(result.status).toBe("failed");
    expect(result.steps).toHaveLength(2);
    expect(result.steps[1].error?.friendlyMessage).toContain("kaput");
  });

  it("aborts a step that exceeds the timeout", async () => {
    const slow: NodeModule = {
      manifest: { slug: "t.slow", kind: "action", name: "Slow", description: "", inputHint: "", outputHint: "" },
      run: () => new Promise((resolve) => setTimeout(() => resolve("late"), 5_000)),
    };
    const graph: WorkflowGraph = {
      nodes: [node("n1", "t.start", "trigger"), node("n2", "t.slow", "action")],
      edges: [{ id: "e1", from: "n1", to: "n2" }],
    };
    const result = await executeWorkflow({
      graph,
      registry: makeRegistry([slow]),
      log,
      caps: { stepTimeoutMs: 50 },
    });
    expect(result.status).toBe("failed");
    expect(result.steps[1].error?.code).toBe("STEP_TIMEOUT");
  }, 2_000);

  it("stops runaway workflows at maxSteps", async () => {
    const graph: WorkflowGraph = {
      nodes: [node("n1", "t.start", "trigger"), node("n2", "t.double", "action")],
      edges: [
        { id: "e1", from: "n1", to: "n2" },
        { id: "e2", from: "n2", to: "n2" },
      ],
    };
    const result = await executeWorkflow({
      graph,
      registry: makeRegistry(),
      log,
      caps: { maxSteps: 5 },
    });
    expect(result.status).toBe("failed");
    expect(result.steps.length).toBeLessThanOrEqual(5);
    expect(result.errorSummary).toMatch(/5 steps/);
  });

  it("reports each step through onStep as it happens", async () => {
    const seen: string[] = [];
    const graph: WorkflowGraph = {
      nodes: [node("n1", "t.start", "trigger"), node("n2", "t.double", "action")],
      edges: [{ id: "e1", from: "n1", to: "n2" }],
    };
    await executeWorkflow({
      graph,
      registry: makeRegistry(),
      log,
      onStep: (step) => {
        seen.push(step.nodeId);
      },
    });
    expect(seen).toEqual(["n1", "n2"]);
  });
});
