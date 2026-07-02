import Fastify, { type FastifyInstance } from "fastify";
import { AppError, createLogger, type Logger } from "@autonimbus/shared";
import { NodeRegistry } from "@autonimbus/engine";
import { builtinNodes } from "@autonimbus/nodes";
import type { Db } from "./db/client.js";
import { WorkflowsService } from "./services/workflows-service.js";
import { RunsService } from "./services/runs-service.js";
import { registerWorkflowRoutes } from "./api/routes/workflows.js";
import { registerRunRoutes } from "./api/routes/runs.js";

export interface AppDeps {
  db?: Db;
  log?: Logger;
}

const ERROR_STATUS: Record<string, number> = {
  WORKFLOW_NOT_FOUND: 404,
  RUN_NOT_FOUND: 404,
  INVALID_GRAPH: 400,
  INVALID_WORKFLOW: 400,
};

export function buildApp(deps: AppDeps = {}): FastifyInstance {
  const app = Fastify({ logger: false });
  const log = deps.log ?? createLogger("server");

  app.setErrorHandler((err, _req, reply) => {
    const appErr = AppError.wrap(err);
    const status = ERROR_STATUS[appErr.code] ?? 500;
    if (status === 500) log.error({ err }, "unhandled error");
    reply.code(status).send({
      code: appErr.code,
      friendlyMessage: appErr.friendlyMessage,
      suggestedFix: appErr.suggestedFix,
    });
  });

  app.get("/api/health", async () => ({ ok: true }));

  if (deps.db) {
    const registry = new NodeRegistry();
    for (const mod of builtinNodes) registry.register(mod);
    registerWorkflowRoutes(app, new WorkflowsService(deps.db));
    registerRunRoutes(app, new RunsService(deps.db, registry, log));
  }

  return app;
}
