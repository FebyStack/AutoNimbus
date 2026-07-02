import { eq } from "drizzle-orm";
import {
  AppError,
  redactSecrets,
  workflowGraphSchema,
  type Logger,
} from "@autonimbus/shared";
import { executeWorkflow, type NodeRegistry } from "@autonimbus/engine";
import type { Db } from "../db/client.js";
import { runs, runSteps, workflows } from "../db/schema.js";

export class RunsService {
  constructor(
    private readonly db: Db,
    private readonly registry: NodeRegistry,
    private readonly log: Logger,
  ) {}

  async runWorkflow(workflowId: string) {
    const [wf] = await this.db.select().from(workflows).where(eq(workflows.id, workflowId));
    if (!wf) {
      throw new AppError({
        code: "WORKFLOW_NOT_FOUND",
        friendlyMessage: "That automation doesn't exist — it may have been deleted.",
      });
    }
    const graph = workflowGraphSchema.parse(wf.graph);

    const [run] = await this.db
      .insert(runs)
      .values({ workflowId, triggerKind: "manual", status: "running" })
      .returning();

    const runLog = this.log.child({ runId: run.id });
    const result = await executeWorkflow({
      graph,
      registry: this.registry,
      log: runLog,
      onStep: async (step) => {
        await this.db.insert(runSteps).values({
          runId: run.id,
          nodeId: step.nodeId,
          nodeType: step.nodeType,
          status: step.status,
          inputSnapshot: redactSecrets(step.input ?? null),
          outputSnapshot: redactSecrets(step.output ?? null),
          error: step.error ?? null,
          durationMs: step.durationMs,
          finishedAt: new Date(),
        });
      },
    });

    const [finished] = await this.db
      .update(runs)
      .set({
        status: result.status,
        errorSummary: result.errorSummary ?? null,
        finishedAt: new Date(),
      })
      .where(eq(runs.id, run.id))
      .returning();

    runLog.info({ status: result.status, steps: result.steps.length }, "run finished");
    return finished;
  }

  async getRun(runId: string) {
    const [run] = await this.db.select().from(runs).where(eq(runs.id, runId));
    if (!run) {
      throw new AppError({
        code: "RUN_NOT_FOUND",
        friendlyMessage: "That run doesn't exist.",
      });
    }
    const steps = await this.db.select().from(runSteps).where(eq(runSteps.runId, runId));
    return { run, steps };
  }

  async listRuns(workflowId: string) {
    return this.db.select().from(runs).where(eq(runs.workflowId, workflowId));
  }
}
