import type { Logger } from "../logger/logger.js";
import type { NodeKind } from "./workflow.js";

export interface NodeManifest {
  slug: string; // e.g. "core.http-request"
  kind: NodeKind;
  name: string; // plain English: "Call an API"
  description: string;
  inputHint: string; // human sentence, not a schema
  outputHint: string;
}

export interface NodeContext {
  config: Record<string, unknown>;
  input: unknown;
  log: Logger;
  signal: AbortSignal;
}

export interface NodeModule {
  manifest: NodeManifest;
  run(ctx: NodeContext): Promise<unknown>;
}
