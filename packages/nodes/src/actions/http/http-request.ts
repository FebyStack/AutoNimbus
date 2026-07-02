import { AppError, type NodeModule } from "@autonimbus/shared";
import { RateLimiter } from "./rate-limiter.js";

export interface HttpNodeOptions {
  limiter?: RateLimiter;
  backoffMs?: number[];
}

const RETRYABLE = new Set([429, 500, 502, 503, 504]);

export function createHttpRequestNode(options: HttpNodeOptions = {}): NodeModule {
  const limiter = options.limiter ?? new RateLimiter();
  const backoffMs = options.backoffMs ?? [500, 1_500, 4_000];

  return {
    manifest: {
      slug: "core.http-request",
      kind: "action",
      name: "Call an API",
      description: "Sends a request to any web API and returns what it says.",
      inputHint: "Optional data to send along.",
      outputHint: "The API's answer: status and body.",
    },
    async run(ctx) {
      const { method = "GET", url, headers = {}, body } = ctx.config as {
        method?: string;
        url: string;
        headers?: Record<string, string>;
        body?: unknown;
      };
      if (!url) {
        throw new AppError({
          code: "HTTP_URL_MISSING",
          friendlyMessage: "This API step has no address (URL) to call.",
          suggestedFix: "Open the step and paste the API's URL.",
        });
      }

      const host = new URL(url).host;
      let lastStatus = 0;

      for (let attempt = 0; attempt <= backoffMs.length; attempt++) {
        await limiter.acquire(host);
        let res: Response;
        try {
          res = await fetch(url, {
            method,
            headers: { "content-type": "application/json", ...headers },
            body: body === undefined ? undefined : JSON.stringify(body),
            signal: ctx.signal,
          });
        } catch (err) {
          throw new AppError({
            code: "HTTP_NETWORK_ERROR",
            friendlyMessage: `Couldn't reach ${host} — the network request failed.`,
            suggestedFix: "Check the URL and your internet connection, then run again.",
            cause: err,
          });
        }

        lastStatus = res.status;

        if (RETRYABLE.has(res.status) && attempt < backoffMs.length) {
          ctx.log.warn({ status: res.status, attempt }, "retrying after backoff");
          await new Promise((resolve) => setTimeout(resolve, backoffMs[attempt]));
          continue;
        }

        const contentType = res.headers.get("content-type") ?? "";
        const parsed = contentType.includes("application/json")
          ? await res.json()
          : await res.text();

        if (res.status === 429) {
          throw new AppError({
            code: "HTTP_RATE_LIMITED",
            friendlyMessage: `${host} asked us to slow down (429) and kept refusing after retries.`,
            suggestedFix: "Wait a few minutes, or lower how often this automation runs.",
          });
        }
        if (res.status >= 400) {
          throw new AppError({
            code: "HTTP_REQUEST_FAILED",
            friendlyMessage: `${host} answered with an error (${res.status}).`,
            suggestedFix: "Open the step and check the URL, method, and API key.",
          });
        }

        return { status: res.status, body: parsed };
      }

      throw new AppError({
        code: "HTTP_RATE_LIMITED",
        friendlyMessage: `${host} kept answering ${lastStatus} after every retry.`,
        suggestedFix: "Wait a few minutes and run again.",
      });
    },
  };
}
