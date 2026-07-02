import {
  AppError,
  type Logger,
  type StepStatus,
  type WorkflowGraph,
  type WorkflowNode,
} from "@autonimbus/shared";
import type { NodeRegistry } from "./registry.js";

export interface ExecutorCaps {
  maxSteps: number;
  stepTimeoutMs: number;
}

// Spec §13: caps are always on; these are the defaults.
export const DEFAULT_CAPS: ExecutorCaps = { maxSteps: 200, stepTimeoutMs: 60_000 };

export interface StepRecord {
  nodeId: string;
  nodeType: string;
  status: StepStatus;
  input: unknown;
  output?: unknown;
  error?: { code: string; friendlyMessage: string; suggestedFix?: string };
  durationMs: number;
}

export interface RunResult {
  status: "success" | "failed";
  steps: StepRecord[];
  errorSummary?: string;
}

export interface ExecuteOptions {
  graph: WorkflowGraph;
  registry: NodeRegistry;
  log: Logger;
  caps?: Partial<ExecutorCaps>;
  onStep?: (step: StepRecord) => void | Promise<void>;
}

export async function executeWorkflow(opts: ExecuteOptions): Promise<RunResult> {
  const caps: ExecutorCaps = { ...DEFAULT_CAPS, ...opts.caps };
  const { graph, registry, log, onStep } = opts;
  const steps: StepRecord[] = [];

  const trigger = graph.nodes.find((n) => n.kind === "trigger");
  if (!trigger) {
    return {
      status: "failed",
      steps,
      errorSummary:
        "This automation has no trigger — add a 'When…' node so it knows when to start.",
    };
  }

  let current: WorkflowNode | undefined = trigger;
  let input: unknown = {};

  while (current) {
    if (steps.length >= caps.maxSteps) {
      return {
        status: "failed",
        steps,
        errorSummary: `Stopped after ${caps.maxSteps} steps — this automation appears to loop forever.`,
      };
    }

    const record = await runStep(current, input, registry, log, caps.stepTimeoutMs);
    steps.push(record);
    await onStep?.(record);

    if (record.status === "failed") {
      return { status: "failed", steps, errorSummary: record.error!.friendlyMessage };
    }

    if (current.kind === "rule") {
      const branch = record.output === true ? "true" : "false";
      const edge = graph.edges.find(
        (e) => e.from === current!.id && (e.branch ?? "true") === branch,
      );
      current = edge && graph.nodes.find((n) => n.id === edge.to);
      // A rule routes the data; it doesn't change it.
    } else {
      const edge = graph.edges.find((e) => e.from === current!.id);
      current = edge && graph.nodes.find((n) => n.id === edge.to);
      input = record.output;
    }
  }

  return { status: "success", steps };
}

async function runStep(
  node: WorkflowNode,
  input: unknown,
  registry: NodeRegistry,
  log: Logger,
  timeoutMs: number,
): Promise<StepRecord> {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const mod = registry.get(node.type);
    const timeout = new Promise<never>((_, reject) =>
      controller.signal.addEventListener("abort", () =>
        reject(
          new AppError({
            code: "STEP_TIMEOUT",
            friendlyMessage: `The step "${node.label}" took longer than ${Math.round(timeoutMs / 1000)}s and was stopped.`,
            suggestedFix: "Increase this automation's step timeout, or simplify the step.",
          }),
        ),
      ),
    );
    const output = await Promise.race([
      mod.run({
        config: node.config,
        input,
        log: log.child({ nodeId: node.id }),
        signal: controller.signal,
      }),
      timeout,
    ]);
    return {
      nodeId: node.id,
      nodeType: node.type,
      status: "success",
      input,
      output,
      durationMs: Date.now() - started,
    };
  } catch (err) {
    const appErr = AppError.wrap(err, "STEP_FAILED");
    return {
      nodeId: node.id,
      nodeType: node.type,
      status: "failed",
      input,
      error: {
        code: appErr.code,
        friendlyMessage: appErr.friendlyMessage,
        suggestedFix: appErr.suggestedFix,
      },
      durationMs: Date.now() - started,
    };
  } finally {
    clearTimeout(timer);
  }
}
