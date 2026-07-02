import {
  boolean,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

export const workflows = pgTable("workflows", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  graph: jsonb("graph").notNull(),
  status: text("status").notNull().default("draft"), // draft | active | paused
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const runs = pgTable("runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  workflowId: uuid("workflow_id")
    .notNull()
    .references(() => workflows.id, { onDelete: "cascade" }),
  triggerKind: text("trigger_kind").notNull(),
  status: text("status").notNull().default("running"), // running | success | failed | cancelled
  errorSummary: text("error_summary"),
  startedAt: timestamp("started_at").notNull().defaultNow(),
  finishedAt: timestamp("finished_at"),
});

export const runSteps = pgTable("run_steps", {
  id: uuid("id").primaryKey().defaultRandom(),
  runId: uuid("run_id")
    .notNull()
    .references(() => runs.id, { onDelete: "cascade" }),
  nodeId: text("node_id").notNull(),
  nodeType: text("node_type").notNull(),
  status: text("status").notNull(), // success | failed
  inputSnapshot: jsonb("input_snapshot"),
  outputSnapshot: jsonb("output_snapshot"),
  error: jsonb("error"), // { code, friendlyMessage, suggestedFix }
  modelUsed: text("model_used"),
  durationMs: integer("duration_ms"),
  startedAt: timestamp("started_at").notNull().defaultNow(),
  finishedAt: timestamp("finished_at"),
});

export const nodeTypes = pgTable("node_types", {
  id: text("id").primaryKey(), // slug e.g. "core.http-request"
  kind: text("kind").notNull(), // trigger | action | rule
  source: text("source").notNull().default("builtin"), // builtin | agent | user
  manifest: jsonb("manifest").notNull(),
  filePath: text("file_path").notNull(),
  version: integer("version").notNull().default(1),
  enabled: boolean("enabled").notNull().default(true),
});

export const credentials = pgTable("credentials", {
  id: uuid("id").primaryKey().defaultRandom(),
  service: text("service").notNull(),
  label: text("label").notNull(),
  encryptedPayload: text("encrypted_payload").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  lastVerifiedAt: timestamp("last_verified_at"),
});

export const setupGuides = pgTable("setup_guides", {
  service: text("service").primaryKey(),
  steps: jsonb("steps").notNull(),
  source: text("source").notNull().default("builtin"), // builtin | generated
  generatedAt: timestamp("generated_at"),
});

export const schedules = pgTable("schedules", {
  id: uuid("id").primaryKey().defaultRandom(),
  workflowId: uuid("workflow_id")
    .notNull()
    .references(() => workflows.id, { onDelete: "cascade" }),
  cronExpr: text("cron_expr").notNull(),
  plainText: text("plain_text").notNull(),
  nextRunAt: timestamp("next_run_at"),
  enabled: boolean("enabled").notNull().default(true),
});

export const webhooks = pgTable("webhooks", {
  id: uuid("id").primaryKey().defaultRandom(),
  workflowId: uuid("workflow_id")
    .notNull()
    .references(() => workflows.id, { onDelete: "cascade" }),
  pathToken: text("path_token").notNull().unique(),
  secret: text("secret"),
});

export const permissions = pgTable("permissions", {
  id: uuid("id").primaryKey().defaultRandom(),
  workflowId: uuid("workflow_id")
    .notNull()
    .references(() => workflows.id, { onDelete: "cascade" }),
  scope: text("scope").notNull(), // e.g. "fs:/Users/x/Downloads", "shell", "browser"
  grantedAt: timestamp("granted_at").notNull().defaultNow(),
});

export const chatMessages = pgTable("chat_messages", {
  id: uuid("id").primaryKey().defaultRandom(),
  workflowId: uuid("workflow_id").references(() => workflows.id, {
    onDelete: "set null",
  }),
  role: text("role").notNull(), // user | assistant | tool
  content: text("content").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const settings = pgTable("settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
});
