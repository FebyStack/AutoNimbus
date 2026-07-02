import type { FastifyInstance } from "fastify";
import type { RunsService } from "../../services/runs-service.js";

export function registerRunRoutes(app: FastifyInstance, service: RunsService) {
  app.post("/api/workflows/:id/run", async (req, reply) => {
    const run = await service.runWorkflow((req.params as { id: string }).id);
    return reply.code(201).send(run);
  });

  app.get("/api/workflows/:id/runs", async (req) =>
    service.listRuns((req.params as { id: string }).id),
  );

  app.get("/api/runs/:id", async (req) =>
    service.getRun((req.params as { id: string }).id),
  );
}
