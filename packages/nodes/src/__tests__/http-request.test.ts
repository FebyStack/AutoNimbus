import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLogger } from "@autonimbus/shared";
import { RateLimiter } from "../actions/http/rate-limiter.js";
import { createHttpRequestNode } from "../actions/http/http-request.js";

const log = createLogger("test", { level: "silent" });
const signal = new AbortController().signal;

describe("RateLimiter", () => {
  it("spaces calls to the same key by the minimum interval", async () => {
    const limiter = new RateLimiter(100);
    const start = Date.now();
    await limiter.acquire("api.example.com");
    await limiter.acquire("api.example.com");
    await limiter.acquire("api.example.com");
    expect(Date.now() - start).toBeGreaterThanOrEqual(200);
  });

  it("does not delay calls to different keys", async () => {
    const limiter = new RateLimiter(200);
    const start = Date.now();
    await limiter.acquire("a.com");
    await limiter.acquire("b.com");
    expect(Date.now() - start).toBeLessThan(100);
  });
});

describe("http-request node", () => {
  let server: Server;
  let baseUrl: string;
  let flakyRemaining = 0;

  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url === "/json") {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ price: 450 }));
      } else if (req.url === "/flaky") {
        if (flakyRemaining > 0) {
          flakyRemaining -= 1;
          res.statusCode = 429;
          res.end("slow down");
        } else {
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ ok: true }));
        }
      } else {
        res.statusCode = 404;
        res.end("nope");
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address();
    baseUrl = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
  });

  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it("fetches and parses JSON", async () => {
    const httpNode = createHttpRequestNode({ limiter: new RateLimiter(0) });
    const out = (await httpNode.run({
      config: { method: "GET", url: `${baseUrl}/json` },
      input: {},
      log,
      signal,
    })) as { status: number; body: { price: number } };
    expect(out.status).toBe(200);
    expect(out.body.price).toBe(450);
  });

  it("retries with backoff on 429 and eventually succeeds", async () => {
    flakyRemaining = 2;
    const httpNode = createHttpRequestNode({
      limiter: new RateLimiter(0),
      backoffMs: [10, 20],
    });
    const out = (await httpNode.run({
      config: { method: "GET", url: `${baseUrl}/flaky` },
      input: {},
      log,
      signal,
    })) as { status: number };
    expect(out.status).toBe(200);
  });

  it("fails friendly after exhausting retries", async () => {
    flakyRemaining = 99;
    const httpNode = createHttpRequestNode({
      limiter: new RateLimiter(0),
      backoffMs: [10, 20],
    });
    await expect(
      httpNode.run({
        config: { method: "GET", url: `${baseUrl}/flaky` },
        input: {},
        log,
        signal,
      }),
    ).rejects.toThrowError(/asked us to slow down/i);
  });

  it("fails friendly on a 404", async () => {
    const httpNode = createHttpRequestNode({ limiter: new RateLimiter(0) });
    await expect(
      httpNode.run({
        config: { method: "GET", url: `${baseUrl}/missing` },
        input: {},
        log,
        signal,
      }),
    ).rejects.toThrowError(/404/);
  });
});
