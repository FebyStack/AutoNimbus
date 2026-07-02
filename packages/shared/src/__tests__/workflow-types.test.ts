import { describe, expect, it } from "vitest";
import { workflowGraphSchema } from "../types/workflow.js";

const validGraph = {
  nodes: [
    {
      id: "t1",
      type: "core.manual-trigger",
      kind: "trigger",
      label: "When I click Run",
      config: {},
      position: { x: 0, y: 0 },
    },
    {
      id: "a1",
      type: "core.set-data",
      kind: "action",
      label: "Set sample data",
      config: { data: { price: 450 } },
      position: { x: 240, y: 0 },
    },
  ],
  edges: [{ id: "e1", from: "t1", to: "a1" }],
};

describe("workflowGraphSchema", () => {
  it("accepts a valid graph", () => {
    const parsed = workflowGraphSchema.parse(validGraph);
    expect(parsed.nodes).toHaveLength(2);
  });

  it("rejects an unknown node kind", () => {
    const bad = structuredClone(validGraph);
    (bad.nodes[0] as { kind: string }).kind = "widget";
    expect(() => workflowGraphSchema.parse(bad)).toThrow();
  });

  it("defaults config to an empty object", () => {
    const noConfig = structuredClone(validGraph);
    delete (noConfig.nodes[0] as Record<string, unknown>).config;
    const parsed = workflowGraphSchema.parse(noConfig);
    expect(parsed.nodes[0].config).toEqual({});
  });
});
