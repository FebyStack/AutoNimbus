import type { NodeModule } from "@autonimbus/shared";
import { manualTrigger } from "./triggers/manual-trigger.js";
import { setData } from "./actions/set-data.js";
import { ifRule } from "./rules/if.js";
import { createHttpRequestNode } from "./actions/http/http-request.js";

export { manualTrigger, setData, ifRule, createHttpRequestNode };
export { RateLimiter } from "./actions/http/rate-limiter.js";

export const builtinNodes: NodeModule[] = [
  manualTrigger,
  setData,
  ifRule,
  createHttpRequestNode(),
];
