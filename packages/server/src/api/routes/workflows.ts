import type { FastifyInstance } from "fastify";
import type { WorkflowsService } from "../../services/workflows-service.js";

export function registerWorkflowRoutes(
  app: FastifyInstance,
  service: WorkflowsService,
) {
  app.post("/api/workflows", async (req, reply) => {
    const body = req.body as { name: string; description?: string; graph: unknown };
    const row = await service.create(body);
    return reply.code(201).send(row);
  });

  app.get("/api/workflows", async () => service.list());

  app.get("/api/workflows/:id", async (req) =>
    service.get((req.params as { id: string }).id),
  );

  app.patch("/api/workflows/:id", async (req) =>
    service.update(
      (req.params as { id: string }).id,
      req.body as Parameters<WorkflowsService["update"]>[1],
    ),
  );

  app.delete("/api/workflows/:id", async (req, reply) => {
    await service.delete((req.params as { id: string }).id);
    return reply.code(204).send();
  });
}
