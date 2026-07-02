import Fastify, { type FastifyInstance } from "fastify";
import { AppError } from "@autonimbus/shared";
import type { Db } from "./db/client.js";
import { WorkflowsService } from "./services/workflows-service.js";
import { registerWorkflowRoutes } from "./api/routes/workflows.js";

export interface AppDeps {
  db?: Db;
}

const ERROR_STATUS: Record<string, number> = {
  WORKFLOW_NOT_FOUND: 404,
  INVALID_GRAPH: 400,
};

export function buildApp(deps: AppDeps = {}): FastifyInstance {
  const app = Fastify({ logger: false });

  app.setErrorHandler((err, _req, reply) => {
    const appErr = AppError.wrap(err);
    const status = ERROR_STATUS[appErr.code] ?? 500;
    reply.code(status).send({
      code: appErr.code,
      friendlyMessage: appErr.friendlyMessage,
      suggestedFix: appErr.suggestedFix,
    });
  });

  app.get("/api/health", async () => ({ ok: true }));

  if (deps.db) {
    registerWorkflowRoutes(app, new WorkflowsService(deps.db));
  }

  return app;
}
