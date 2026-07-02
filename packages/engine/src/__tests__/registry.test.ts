import { describe, expect, it } from "vitest";
import type { NodeModule } from "@autonimbus/shared";
import { NodeRegistry } from "../registry.js";

const echoNode: NodeModule = {
  manifest: {
    slug: "test.echo",
    kind: "action",
    name: "Echo",
    description: "Returns its input",
    inputHint: "Anything",
    outputHint: "The same thing",
  },
  run: async (ctx) => ctx.input,
};

describe("NodeRegistry", () => {
  it("registers and retrieves a node module", () => {
    const registry = new NodeRegistry();
    registry.register(echoNode);
    expect(registry.get("test.echo")).toBe(echoNode);
    expect(registry.list().map((m) => m.slug)).toEqual(["test.echo"]);
  });

  it("rejects duplicate slugs", () => {
    const registry = new NodeRegistry();
    registry.register(echoNode);
    expect(() => registry.register(echoNode)).toThrowError(/already/i);
  });

  it("fails friendly on unknown node types", () => {
    const registry = new NodeRegistry();
    expect(() => registry.get("test.missing")).toThrowError(/isn't installed/i);
  });
});
