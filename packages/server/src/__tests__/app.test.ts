import { describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { serverConfig } from "../config.js";

describe("app", () => {
  it("binds only to loopback — never exposed to the network", () => {
    expect(serverConfig.host).toBe("127.0.0.1");
    expect(serverConfig.port).toBe(4680);
  });

  it("responds to health checks", async () => {
    const app = buildApp();
    const res = await app.inject({ method: "GET", url: "/api/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    await app.close();
  });
});
