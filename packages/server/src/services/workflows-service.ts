import { eq } from "drizzle-orm";
import { AppError, workflowGraphSchema, type WorkflowGraph } from "@autonimbus/shared";
import type { Db } from "../db/client.js";
import { workflows } from "../db/schema.js";

const WORKFLOW_STATUSES = ["draft", "active", "paused"] as const;

export class WorkflowsService {
  constructor(private readonly db: Db) {}

  async create(input: { name?: string; description?: string; graph: unknown }) {
    const name = this.parseName(input.name);
    const graph = this.parseGraph(input.graph);
    const [row] = await this.db
      .insert(workflows)
      .values({ name, description: input.description ?? "", graph })
      .returning();
    return row;
  }

  async list() {
    return this.db.select().from(workflows);
  }

  async get(id: string) {
    const [row] = await this.db.select().from(workflows).where(eq(workflows.id, id));
    if (!row) {
      throw new AppError({
        code: "WORKFLOW_NOT_FOUND",
        friendlyMessage: "That automation doesn't exist — it may have been deleted.",
        suggestedFix: "Refresh your automations list.",
      });
    }
    return row;
  }

  async update(
    id: string,
    patch: { name?: string; description?: string; graph?: unknown; status?: string },
  ) {
    await this.get(id);
    const values: Record<string, unknown> = { updatedAt: new Date() };
    if (patch.name !== undefined) values.name = this.parseName(patch.name);
    if (patch.description !== undefined) values.description = patch.description;
    if (patch.status !== undefined) values.status = this.parseStatus(patch.status);
    if (patch.graph !== undefined) values.graph = this.parseGraph(patch.graph);
    const [row] = await this.db
      .update(workflows)
      .set(values)
      .where(eq(workflows.id, id))
      .returning();
    return row;
  }

  async delete(id: string) {
    await this.get(id);
    await this.db.delete(workflows).where(eq(workflows.id, id));
  }

  private parseName(name: unknown): string {
    if (typeof name !== "string" || name.trim() === "") {
      throw new AppError({
        code: "INVALID_WORKFLOW",
        friendlyMessage: "This automation needs a name.",
        suggestedFix: "Give it a short name that says what it does.",
      });
    }
    return name.trim();
  }

  private parseStatus(status: string): string {
    if (!WORKFLOW_STATUSES.includes(status as (typeof WORKFLOW_STATUSES)[number])) {
      throw new AppError({
        code: "INVALID_WORKFLOW",
        friendlyMessage: `"${status}" isn't a valid automation status.`,
        suggestedFix: "Use draft, active, or paused.",
      });
    }
    return status;
  }

  private parseGraph(graph: unknown): WorkflowGraph {
    const result = workflowGraphSchema.safeParse(graph);
    if (!result.success) {
      throw new AppError({
        code: "INVALID_GRAPH",
        friendlyMessage: "This automation's layout isn't valid.",
        suggestedFix: "Ask Nimbus to check the automation, or undo your last change.",
        cause: result.error,
      });
    }
    return result.data;
  }
}
