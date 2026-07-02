import { z } from "zod";

export const nodeKindSchema = z.enum(["trigger", "action", "rule"]);

export const workflowNodeSchema = z.object({
  id: z.string().min(1),
  type: z.string().min(1),
  kind: nodeKindSchema,
  label: z.string(),
  config: z.record(z.string(), z.unknown()).default({}),
  position: z.object({ x: z.number(), y: z.number() }),
});

export const workflowEdgeSchema = z.object({
  id: z.string().min(1),
  from: z.string().min(1),
  to: z.string().min(1),
  branch: z.enum(["true", "false"]).optional(),
});

export const workflowGraphSchema = z.object({
  nodes: z.array(workflowNodeSchema),
  edges: z.array(workflowEdgeSchema),
});

export type NodeKind = z.infer<typeof nodeKindSchema>;
export type WorkflowNode = z.infer<typeof workflowNodeSchema>;
export type WorkflowEdge = z.infer<typeof workflowEdgeSchema>;
export type WorkflowGraph = z.infer<typeof workflowGraphSchema>;

export type RunStatus = "running" | "success" | "failed" | "cancelled";
export type StepStatus = "success" | "failed";
