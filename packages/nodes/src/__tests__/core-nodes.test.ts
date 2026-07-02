import { describe, expect, it } from "vitest";
import { createLogger } from "@autonimbus/shared";
import { manualTrigger } from "../triggers/manual-trigger.js";
import { setData } from "../actions/set-data.js";
import { ifRule } from "../rules/if.js";

const log = createLogger("test", { level: "silent" });
const signal = new AbortController().signal;

describe("core nodes", () => {
  it("manual trigger emits its configured payload", async () => {
    const out = await manualTrigger.run({
      config: { payload: { hello: "world" } },
      input: undefined,
      log,
      signal,
    });
    expect(out).toEqual({ hello: "world" });
  });

  it("manual trigger defaults to an empty object", async () => {
    const out = await manualTrigger.run({ config: {}, input: undefined, log, signal });
    expect(out).toEqual({});
  });

  it("set-data returns the configured data", async () => {
    const out = await setData.run({
      config: { data: { price: 450 } },
      input: { ignored: true },
      log,
      signal,
    });
    expect(out).toEqual({ price: 450 });
  });

  it("if rule compares a field on the input", async () => {
    const ctx = {
      config: { field: "price", operator: "lessThan", value: 500 },
      input: { price: 450 },
      log,
      signal,
    };
    expect(await ifRule.run(ctx)).toBe(true);
    expect(await ifRule.run({ ...ctx, input: { price: 900 } })).toBe(false);
  });

  it("if rule supports equals and contains", async () => {
    expect(
      await ifRule.run({
        config: { field: "airline", operator: "equals", value: "Cebu Pacific" },
        input: { airline: "Cebu Pacific" },
        log,
        signal,
      }),
    ).toBe(true);
    expect(
      await ifRule.run({
        config: { field: "subject", operator: "contains", value: "invoice" },
        input: { subject: "Your invoice #42" },
        log,
        signal,
      }),
    ).toBe(true);
  });

  it("if rule fails friendly on an unknown operator", async () => {
    await expect(
      ifRule.run({
        config: { field: "x", operator: "resembles", value: 1 },
        input: { x: 1 },
        log,
        signal,
      }),
    ).rejects.toThrowError(/doesn't understand/i);
  });
});
