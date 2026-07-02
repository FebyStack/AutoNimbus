# AutoNimbus Phase 1: Foundation & Engine Core — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A running local AutoNimbus core: pnpm monorepo, PostgreSQL schema, Fastify API bound to 127.0.0.1, and a workflow engine that executes trigger → action → rule graphs with per-step snapshots, caps, timeouts, secret redaction, and a rate-limited HTTP node — all drivable via curl.

**Architecture:** One Node.js process (Fastify server owning Postgres via Drizzle) hosting the engine. Strict one-way deps: `server → engine → nodes`, everyone importing `shared` (types, errors, logger, redaction). Spec: `docs/superpowers/specs/2026-07-03-autonimbus-design.md`.

**Tech Stack:** Node 22, TypeScript 5 (ESM), pnpm workspaces, Vitest, Fastify 5, Drizzle ORM + node-postgres, PostgreSQL 16 (Docker), Zod, Pino.

## Phase roadmap (this plan = Phase 1)

1. **Foundation & engine core** ← this document
2. **Credentials vault + local power nodes** — AES-256-GCM vault w/ macOS Keychain, files/shell/notify nodes, permission prompts + folder allowlists
3. **Triggers & browser automation** — plain-English schedules → cron, webhook endpoints (token + rate limit), Playwright browser node family + failure artifacts
4. **Web UI** — Figma-grade React Flow canvas, inspector, palette, runs/replay, WebSocket live status
5. **Nimbus agent** — Claude Agent SDK (subscription auth), tools (buildWorkflow/createNodeType/writeSetupGuide/fixRun), Ollama routing, approval previews, budgets, audit
6. **Guided API wizard** — built-in + generated setup guides, curl import, test-call flow, E2E smoke test

Each later phase gets its own plan document in this folder before implementation starts.

## Prerequisites

- Node 22+ (`node --version`), pnpm 9+ (`pnpm --version`), Docker Desktop running.
- All commands run from repo root: `/Users/febrielotud/Desktop/AutoNimbus`.

## File structure created in this phase

```
autonimbus/
├── package.json · pnpm-workspace.yaml · tsconfig.base.json · .env · .env.example
├── docker-compose.yml
├── packages/
│   ├── shared/src/{errors,logger,redact,types}/… + __tests__/
│   ├── engine/src/{registry.ts,executor.ts} + __tests__/
│   ├── nodes/src/{triggers,actions,rules,index.ts} + __tests__/
│   └── server/src/{config.ts,app.ts,main.ts,db/,services/,api/routes/} + __tests__/
```

---

### Task 1: Monorepo scaffold

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `.env.example`, `.env`
- Create: `packages/{shared,engine,nodes,server}/package.json`, `packages/{shared,engine,nodes,server}/tsconfig.json`, `packages/{shared,engine,nodes,server}/src/index.ts`

- [ ] **Step 1: Create root files**

`package.json`:
```json
{
  "name": "autonimbus",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "pnpm -r test",
    "dev": "pnpm --filter @autonimbus/server dev"
  },
  "devDependencies": {
    "typescript": "^5.5.4",
    "vitest": "^2.1.9"
  }
}
```

`pnpm-workspace.yaml`:
```yaml
packages:
  - packages/*
```

`tsconfig.base.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "sourceMap": true,
    "types": ["node"]
  }
}
```

`.env.example` (and copy to `.env` — `.env` is already gitignored):
```
DATABASE_URL=postgres://autonimbus:autonimbus@127.0.0.1:5433/autonimbus
```

- [ ] **Step 2: Create the four packages**

For each of `shared`, `engine`, `nodes`, `server`, create `packages/<name>/package.json` (shown for `shared`; change the `name` field for the others):
```json
{
  "name": "@autonimbus/shared",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "scripts": {
    "test": "vitest run --passWithNoTests"
  }
}
```

Each `packages/<name>/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "include": ["src"]
}
```

Each `packages/<name>/src/index.ts` starts as:
```ts
export {};
```

- [ ] **Step 3: Add workspace dependencies**

Run:
```bash
pnpm add -D @types/node -w
pnpm --filter @autonimbus/engine add @autonimbus/shared@workspace:*
pnpm --filter @autonimbus/nodes add @autonimbus/shared@workspace:*
pnpm --filter @autonimbus/server add @autonimbus/shared@workspace:* @autonimbus/engine@workspace:* @autonimbus/nodes@workspace:*
pnpm install
```

- [ ] **Step 4: Verify the workspace resolves**

Run: `pnpm -r test`
Expected: all four packages report "No test files found" and exit 0 (thanks to `--passWithNoTests`).

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "chore: scaffold pnpm monorepo with shared/engine/nodes/server packages"
```

---

### Task 2: shared — AppError

**Files:**
- Create: `packages/shared/src/errors/app-error.ts`
- Modify: `packages/shared/src/index.ts`
- Test: `packages/shared/src/__tests__/app-error.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { AppError } from "../errors/app-error.js";

describe("AppError", () => {
  it("carries code, friendlyMessage, suggestedFix and cause", () => {
    const cause = new Error("boom");
    const err = new AppError({
      code: "GMAIL_SCOPE_MISSING",
      friendlyMessage: "Gmail said your key doesn't have permission to send.",
      suggestedFix: "Re-run the setup wizard and tick the 'send email' scope.",
      cause,
    });
    expect(err.code).toBe("GMAIL_SCOPE_MISSING");
    expect(err.friendlyMessage).toMatch(/permission to send/);
    expect(err.suggestedFix).toMatch(/setup wizard/);
    expect(err.cause).toBe(cause);
    expect(err).toBeInstanceOf(Error);
  });

  it("wrap() passes AppError through unchanged", () => {
    const original = new AppError({ code: "X", friendlyMessage: "x" });
    expect(AppError.wrap(original)).toBe(original);
  });

  it("wrap() normalizes unknown errors with a default code", () => {
    const wrapped = AppError.wrap(new Error("socket hang up"));
    expect(wrapped.code).toBe("UNEXPECTED");
    expect(wrapped.friendlyMessage).toContain("socket hang up");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @autonimbus/shared test`
Expected: FAIL — cannot find module `../errors/app-error.js`.

- [ ] **Step 3: Write the implementation**

`packages/shared/src/errors/app-error.ts`:
```ts
export interface AppErrorOptions {
  code: string;
  friendlyMessage: string;
  suggestedFix?: string;
  cause?: unknown;
}

export class AppError extends Error {
  readonly code: string;
  readonly friendlyMessage: string;
  readonly suggestedFix?: string;

  constructor(opts: AppErrorOptions) {
    super(opts.friendlyMessage, { cause: opts.cause });
    this.name = "AppError";
    this.code = opts.code;
    this.friendlyMessage = opts.friendlyMessage;
    this.suggestedFix = opts.suggestedFix;
  }

  static wrap(err: unknown, code = "UNEXPECTED"): AppError {
    if (err instanceof AppError) return err;
    const message = err instanceof Error ? err.message : String(err);
    return new AppError({
      code,
      friendlyMessage: `Something went wrong: ${message}`,
      cause: err,
    });
  }
}
```

Replace `packages/shared/src/index.ts` content with:
```ts
export * from "./errors/app-error.js";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @autonimbus/shared test`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/shared && git commit -m "feat(shared): AppError with code, friendly message and suggested fix"
```

---

### Task 3: shared — structured logger

**Files:**
- Create: `packages/shared/src/logger/logger.ts`
- Modify: `packages/shared/src/index.ts`
- Test: `packages/shared/src/__tests__/logger.test.ts`

- [ ] **Step 1: Install pino**

```bash
pnpm --filter @autonimbus/shared add pino
```

- [ ] **Step 2: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { Writable } from "node:stream";
import { createLogger } from "../logger/logger.js";

function memorySink() {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      lines.push(chunk.toString());
      cb();
    },
  });
  return { lines, stream };
}

describe("createLogger", () => {
  it("writes JSON lines with the scope", () => {
    const { lines, stream } = memorySink();
    const log = createLogger("engine", { destination: stream });
    log.info("started");
    const entry = JSON.parse(lines[0]);
    expect(entry.scope).toBe("engine");
    expect(entry.msg).toBe("started");
  });

  it("child loggers carry correlation ids", () => {
    const { lines, stream } = memorySink();
    const log = createLogger("engine", { destination: stream });
    log.child({ runId: "run-1", nodeId: "n-2" }).warn("slow step");
    const entry = JSON.parse(lines[0]);
    expect(entry.runId).toBe("run-1");
    expect(entry.nodeId).toBe("n-2");
    expect(entry.scope).toBe("engine");
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @autonimbus/shared test -- logger`
Expected: FAIL — cannot find module `../logger/logger.js`.

- [ ] **Step 4: Write the implementation**

`packages/shared/src/logger/logger.ts`:
```ts
import { pino, type DestinationStream, type Logger } from "pino";

export type { Logger };

export interface LoggerOptions {
  destination?: DestinationStream;
  level?: string;
}

export function createLogger(scope: string, options: LoggerOptions = {}): Logger {
  return pino(
    {
      level: options.level ?? "info",
      base: { scope },
      timestamp: pino.stdTimeFunctions.isoTime,
    },
    options.destination,
  );
}
```

Append to `packages/shared/src/index.ts`:
```ts
export * from "./logger/logger.js";
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @autonimbus/shared test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/shared && git commit -m "feat(shared): pino structured logger with scoped children"
```

---

### Task 4: shared — workflow graph types (Zod)

**Files:**
- Create: `packages/shared/src/types/workflow.ts`, `packages/shared/src/types/node.ts`
- Modify: `packages/shared/src/index.ts`
- Test: `packages/shared/src/__tests__/workflow-types.test.ts`

- [ ] **Step 1: Install zod**

```bash
pnpm --filter @autonimbus/shared add zod
```

- [ ] **Step 2: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { workflowGraphSchema } from "../types/workflow.js";

const validGraph = {
  nodes: [
    {
      id: "t1",
      type: "core.manual-trigger",
      kind: "trigger",
      label: "When I click Run",
      config: {},
      position: { x: 0, y: 0 },
    },
    {
      id: "a1",
      type: "core.set-data",
      kind: "action",
      label: "Set sample data",
      config: { data: { price: 450 } },
      position: { x: 240, y: 0 },
    },
  ],
  edges: [{ id: "e1", from: "t1", to: "a1" }],
};

describe("workflowGraphSchema", () => {
  it("accepts a valid graph", () => {
    const parsed = workflowGraphSchema.parse(validGraph);
    expect(parsed.nodes).toHaveLength(2);
  });

  it("rejects an unknown node kind", () => {
    const bad = structuredClone(validGraph);
    (bad.nodes[0] as { kind: string }).kind = "widget";
    expect(() => workflowGraphSchema.parse(bad)).toThrow();
  });

  it("defaults config to an empty object", () => {
    const noConfig = structuredClone(validGraph);
    delete (noConfig.nodes[0] as Record<string, unknown>).config;
    const parsed = workflowGraphSchema.parse(noConfig);
    expect(parsed.nodes[0].config).toEqual({});
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @autonimbus/shared test -- workflow-types`
Expected: FAIL — cannot find module `../types/workflow.js`.

- [ ] **Step 4: Write the implementation**

`packages/shared/src/types/workflow.ts`:
```ts
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
```

`packages/shared/src/types/node.ts`:
```ts
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
```

Append to `packages/shared/src/index.ts`:
```ts
export * from "./types/workflow.js";
export * from "./types/node.js";
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @autonimbus/shared test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/shared && git commit -m "feat(shared): workflow graph zod schemas and node module types"
```

---

### Task 5: shared — secret redaction

**Files:**
- Create: `packages/shared/src/redact/redact.ts`
- Modify: `packages/shared/src/index.ts`
- Test: `packages/shared/src/__tests__/redact.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { redactSecrets } from "../redact/redact.js";

describe("redactSecrets", () => {
  it("scrubs bearer tokens inside nested objects", () => {
    const out = redactSecrets({
      request: { headers: { authorization: "Bearer sk_live_a1b2c3d4e5f6g7h8i9" } },
    });
    expect(JSON.stringify(out)).not.toContain("sk_live_a1b2c3d4e5f6g7h8i9");
    expect(JSON.stringify(out)).toContain("•••redacted•••");
  });

  it("scrubs known credential values wherever they appear", () => {
    const out = redactSecrets(
      { note: "called api with topsecret123 embedded" },
      ["topsecret123"],
    );
    expect(JSON.stringify(out)).not.toContain("topsecret123");
  });

  it("scrubs values of secret-named keys", () => {
    const out = redactSecrets({ api_key: "shortval", name: "keep me" }) as {
      api_key: string;
      name: string;
    };
    expect(out.api_key).toBe("•••redacted•••");
    expect(out.name).toBe("keep me");
  });

  it("leaves non-secret data untouched", () => {
    const data = { price: 450, airline: "Cebu Pacific" };
    expect(redactSecrets(data)).toEqual(data);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @autonimbus/shared test -- redact`
Expected: FAIL — cannot find module `../redact/redact.js`.

- [ ] **Step 3: Write the implementation**

`packages/shared/src/redact/redact.ts`:
```ts
const MASK = "•••redacted•••";

const SECRET_VALUE_PATTERNS: RegExp[] = [
  /bearer\s+[a-z0-9._~+/=-]{8,}/gi,
  /\b(?:sk|pk|api|key|token|secret|ghp|xox[bap])[-_][a-z0-9_-]{12,}\b/gi,
];

const SECRET_KEY_PATTERN =
  /(pass(word)?|secret|token|api[-_]?key|authorization|credential)/i;

function redactString(value: string, knownSecrets: string[]): string {
  let out = value;
  for (const secret of knownSecrets) {
    if (secret) out = out.split(secret).join(MASK);
  }
  for (const pattern of SECRET_VALUE_PATTERNS) {
    out = out.replace(pattern, MASK);
  }
  return out;
}

export function redactSecrets<T>(value: T, knownSecrets: string[] = []): T {
  function walk(node: unknown, keyHint?: string): unknown {
    if (typeof node === "string") {
      if (keyHint && SECRET_KEY_PATTERN.test(keyHint)) return MASK;
      return redactString(node, knownSecrets);
    }
    if (Array.isArray(node)) return node.map((item) => walk(item));
    if (node !== null && typeof node === "object") {
      return Object.fromEntries(
        Object.entries(node as Record<string, unknown>).map(([k, v]) => [
          k,
          walk(v, k),
        ]),
      );
    }
    return node;
  }
  return walk(value) as T;
}
```

Append to `packages/shared/src/index.ts`:
```ts
export * from "./redact/redact.js";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @autonimbus/shared test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/shared && git commit -m "feat(shared): secret redaction for snapshots and logs"
```

---

### Task 6: PostgreSQL — docker-compose, Drizzle schema, migrations

**Files:**
- Create: `docker-compose.yml`, `packages/server/drizzle.config.ts`, `packages/server/src/db/schema.ts`, `packages/server/src/db/client.ts`, `packages/server/src/db/migrate.ts`
- Test: `packages/server/src/__tests__/db.test.ts`

- [ ] **Step 1: Install dependencies**

```bash
pnpm --filter @autonimbus/server add fastify drizzle-orm pg dotenv
pnpm --filter @autonimbus/server add -D drizzle-kit @types/pg tsx
```

- [ ] **Step 2: Create docker-compose.yml (repo root)**

Port 5433 so it never clashes with an existing local Postgres on 5432:
```yaml
services:
  db:
    image: postgres:16
    container_name: autonimbus-db
    environment:
      POSTGRES_USER: autonimbus
      POSTGRES_PASSWORD: autonimbus
      POSTGRES_DB: autonimbus
    ports:
      - "127.0.0.1:5433:5432"
    volumes:
      - pgdata:/var/lib/postgresql/data
volumes:
  pgdata:
```

Run: `docker compose up -d db` — expected: container `autonimbus-db` running.

- [ ] **Step 3: Write the Drizzle schema**

`packages/server/src/db/schema.ts` — all 11 tables from spec §2.3:
```ts
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
```

- [ ] **Step 4: Create client, migrator and drizzle config**

`packages/server/src/db/client.ts`:
```ts
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema.js";

export function createDb(connectionString: string) {
  const pool = new pg.Pool({ connectionString });
  const db = drizzle(pool, { schema });
  return { db, pool };
}

export type Db = ReturnType<typeof createDb>["db"];
```

`packages/server/drizzle.config.ts`:
```ts
import "dotenv/config";
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./src/db/migrations",
  dialect: "postgresql",
  dbCredentials: { url: process.env.DATABASE_URL! },
});
```

`packages/server/src/db/migrate.ts`:
```ts
import "dotenv/config";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { createDb } from "./client.js";

const { db, pool } = createDb(process.env.DATABASE_URL!);
await migrate(db, { migrationsFolder: new URL("./migrations", import.meta.url).pathname });
await pool.end();
console.log("migrations applied");
```

Add to `packages/server/package.json` scripts:
```json
{
  "db:generate": "drizzle-kit generate",
  "db:migrate": "tsx src/db/migrate.ts"
}
```

- [ ] **Step 5: Generate and apply the initial migration**

```bash
cd packages/server
cp ../../.env .env
pnpm db:generate && pnpm db:migrate
```
Expected: a SQL file appears in `packages/server/src/db/migrations/` and `migrations applied` prints. (The `.env` copy keeps drizzle-kit and tsx happy from the package dir; add `packages/server/.env` to nothing — root `.gitignore` already ignores `.env` everywhere? No — add a line `**/.env` to root `.gitignore` now.)

- [ ] **Step 6: Write the DB smoke test**

`packages/server/src/__tests__/db.test.ts`:
```ts
import "dotenv/config";
import { afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDb } from "../db/client.js";
import { workflows } from "../db/schema.js";

const url = process.env.DATABASE_URL;

describe.skipIf(!url)("database", () => {
  const { db, pool } = createDb(url!);
  afterAll(() => pool.end());

  it("inserts and reads a workflow row", async () => {
    const [row] = await db
      .insert(workflows)
      .values({ name: "smoke-test", graph: { nodes: [], edges: [] } })
      .returning();
    expect(row.id).toBeTruthy();
    expect(row.status).toBe("draft");
    const found = await db.select().from(workflows).where(eq(workflows.id, row.id));
    expect(found).toHaveLength(1);
    await db.delete(workflows).where(eq(workflows.id, row.id));
  });
});
```

- [ ] **Step 7: Run test to verify it passes**

Run: `pnpm --filter @autonimbus/server test`
Expected: PASS (with `autonimbus-db` container up).

- [ ] **Step 8: Commit**

```bash
git add -A && git commit -m "feat(server): postgres via docker, drizzle schema for all 11 tables, migrations"
```

---

### Task 7: server — Fastify app locked to 127.0.0.1

**Files:**
- Create: `packages/server/src/config.ts`, `packages/server/src/app.ts`, `packages/server/src/main.ts`
- Test: `packages/server/src/__tests__/app.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { serverConfig } from "../config.js";

describe("app", () => {
  it("binds only to loopback — never exposed to the network", () => {
    expect(serverConfig.host).toBe("127.0.0.1");
    expect(serverConfig.port).toBe(4680);
  });

  it("responds to health checks", async () => {
    const app = buildApp();
    const res = await app.inject({ method: "GET", url: "/api/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    await app.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @autonimbus/server test -- app`
Expected: FAIL — cannot find module `../app.js`.

- [ ] **Step 3: Write the implementation**

`packages/server/src/config.ts`:
```ts
// Security invariant (spec §12): AutoNimbus is local-only. Never bind 0.0.0.0.
export const serverConfig = {
  host: "127.0.0.1",
  port: 4680,
} as const;
```

`packages/server/src/app.ts`:
```ts
import Fastify, { type FastifyInstance } from "fastify";

export function buildApp(): FastifyInstance {
  const app = Fastify({ logger: false });
  app.get("/api/health", async () => ({ ok: true }));
  return app;
}
```

`packages/server/src/main.ts`:
```ts
import "dotenv/config";
import { createLogger } from "@autonimbus/shared";
import { buildApp } from "./app.js";
import { serverConfig } from "./config.js";

const log = createLogger("server");
const app = buildApp();
await app.listen({ host: serverConfig.host, port: serverConfig.port });
log.info(`AutoNimbus listening on http://${serverConfig.host}:${serverConfig.port}`);
```

Add to `packages/server/package.json` scripts:
```json
{
  "dev": "tsx watch src/main.ts"
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @autonimbus/server test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/server && git commit -m "feat(server): fastify app with health route, loopback-only binding"
```

---

### Task 8: server — workflows service + CRUD routes

**Files:**
- Create: `packages/server/src/services/workflows-service.ts`, `packages/server/src/api/routes/workflows.ts`
- Modify: `packages/server/src/app.ts`
- Test: `packages/server/src/__tests__/workflows-api.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import "dotenv/config";
import { afterAll, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { createDb } from "../db/client.js";

const url = process.env.DATABASE_URL;

const graph = {
  nodes: [
    {
      id: "t1",
      type: "core.manual-trigger",
      kind: "trigger",
      label: "When I click Run",
      config: {},
      position: { x: 0, y: 0 },
    },
  ],
  edges: [],
};

describe.skipIf(!url)("workflows API", () => {
  const { db, pool } = createDb(url!);
  const app = buildApp({ db });
  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  it("creates, reads, updates, lists and deletes a workflow", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/workflows",
      payload: { name: "Test flow", graph },
    });
    expect(created.statusCode).toBe(201);
    const { id } = created.json();

    const got = await app.inject({ method: "GET", url: `/api/workflows/${id}` });
    expect(got.json().name).toBe("Test flow");

    const updated = await app.inject({
      method: "PATCH",
      url: `/api/workflows/${id}`,
      payload: { name: "Renamed flow" },
    });
    expect(updated.json().name).toBe("Renamed flow");

    const list = await app.inject({ method: "GET", url: "/api/workflows" });
    expect(list.json().some((w: { id: string }) => w.id === id)).toBe(true);

    const del = await app.inject({ method: "DELETE", url: `/api/workflows/${id}` });
    expect(del.statusCode).toBe(204);
  });

  it("rejects an invalid graph with a friendly error", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/workflows",
      payload: { name: "Bad", graph: { nodes: [{ id: "x" }], edges: [] } },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().friendlyMessage).toBeTruthy();
  });

  it("404s with a friendly error for a missing workflow", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/workflows/00000000-0000-0000-0000-000000000000",
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe("WORKFLOW_NOT_FOUND");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @autonimbus/server test -- workflows-api`
Expected: FAIL — `buildApp` does not accept arguments / routes missing.

- [ ] **Step 3: Write the service**

`packages/server/src/services/workflows-service.ts`:
```ts
import { eq } from "drizzle-orm";
import { AppError, workflowGraphSchema, type WorkflowGraph } from "@autonimbus/shared";
import type { Db } from "../db/client.js";
import { workflows } from "../db/schema.js";

export class WorkflowsService {
  constructor(private readonly db: Db) {}

  async create(input: { name: string; description?: string; graph: unknown }) {
    const graph = this.parseGraph(input.graph);
    const [row] = await this.db
      .insert(workflows)
      .values({ name: input.name, description: input.description ?? "", graph })
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
    if (patch.name !== undefined) values.name = patch.name;
    if (patch.description !== undefined) values.description = patch.description;
    if (patch.status !== undefined) values.status = patch.status;
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
```

- [ ] **Step 4: Write the routes and wire into the app**

`packages/server/src/api/routes/workflows.ts`:
```ts
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
```

Replace `packages/server/src/app.ts` with:
```ts
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
```

Update `packages/server/src/main.ts` to pass the db:
```ts
import "dotenv/config";
import { createLogger } from "@autonimbus/shared";
import { buildApp } from "./app.js";
import { serverConfig } from "./config.js";
import { createDb } from "./db/client.js";

const log = createLogger("server");
const { db } = createDb(process.env.DATABASE_URL!);
const app = buildApp({ db });
await app.listen({ host: serverConfig.host, port: serverConfig.port });
log.info(`AutoNimbus listening on http://${serverConfig.host}:${serverConfig.port}`);
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @autonimbus/server test`
Expected: PASS (db, app, workflows-api).

- [ ] **Step 6: Commit**

```bash
git add packages/server && git commit -m "feat(server): workflows service and CRUD API with friendly errors"
```

---

### Task 9: engine — node registry

**Files:**
- Create: `packages/engine/src/registry.ts`
- Modify: `packages/engine/src/index.ts`
- Test: `packages/engine/src/__tests__/registry.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import type { NodeModule } from "@autonimbus/shared";
import { NodeRegistry } from "../registry.js";

const echoNode: NodeModule = {
  manifest: {
    slug: "test.echo",
    kind: "action",
    name: "Echo",
    description: "Returns its input",
    inputHint: "Anything",
    outputHint: "The same thing",
  },
  run: async (ctx) => ctx.input,
};

describe("NodeRegistry", () => {
  it("registers and retrieves a node module", () => {
    const registry = new NodeRegistry();
    registry.register(echoNode);
    expect(registry.get("test.echo")).toBe(echoNode);
    expect(registry.list().map((m) => m.slug)).toEqual(["test.echo"]);
  });

  it("rejects duplicate slugs", () => {
    const registry = new NodeRegistry();
    registry.register(echoNode);
    expect(() => registry.register(echoNode)).toThrowError(/already/i);
  });

  it("fails friendly on unknown node types", () => {
    const registry = new NodeRegistry();
    expect(() => registry.get("test.missing")).toThrowError(/isn't installed/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @autonimbus/engine test`
Expected: FAIL — cannot find module `../registry.js`.

- [ ] **Step 3: Write the implementation**

`packages/engine/src/registry.ts`:
```ts
import { AppError, type NodeManifest, type NodeModule } from "@autonimbus/shared";

export class NodeRegistry {
  private readonly modules = new Map<string, NodeModule>();

  register(mod: NodeModule): void {
    if (this.modules.has(mod.manifest.slug)) {
      throw new AppError({
        code: "NODE_DUPLICATE",
        friendlyMessage: `A node called "${mod.manifest.slug}" is already registered.`,
      });
    }
    this.modules.set(mod.manifest.slug, mod);
  }

  get(slug: string): NodeModule {
    const mod = this.modules.get(slug);
    if (!mod) {
      throw new AppError({
        code: "NODE_UNKNOWN",
        friendlyMessage: `The node type "${slug}" isn't installed.`,
        suggestedFix: "Ask Nimbus to create it, or pick a different node.",
      });
    }
    return mod;
  }

  list(): NodeManifest[] {
    return [...this.modules.values()].map((m) => m.manifest);
  }
}
```

Replace `packages/engine/src/index.ts` with:
```ts
export * from "./registry.js";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @autonimbus/engine test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/engine && git commit -m "feat(engine): node registry with friendly unknown/duplicate errors"
```

---

### Task 10: nodes — manual trigger, set-data, if rule

**Files:**
- Create: `packages/nodes/src/triggers/manual-trigger.ts`, `packages/nodes/src/actions/set-data.ts`, `packages/nodes/src/rules/if.ts`
- Modify: `packages/nodes/src/index.ts`
- Test: `packages/nodes/src/__tests__/core-nodes.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { createLogger } from "@autonimbus/shared";
import { manualTrigger } from "../triggers/manual-trigger.js";
import { setData } from "../actions/set-data.js";
import { ifRule } from "../rules/if.js";

const log = createLogger("test", { level: "silent" });
const signal = new AbortController().signal;

describe("core nodes", () => {
  it("manual trigger emits its configured payload", async () => {
    const out = await manualTrigger.run({
      config: { payload: { hello: "world" } },
      input: undefined,
      log,
      signal,
    });
    expect(out).toEqual({ hello: "world" });
  });

  it("manual trigger defaults to an empty object", async () => {
    const out = await manualTrigger.run({ config: {}, input: undefined, log, signal });
    expect(out).toEqual({});
  });

  it("set-data returns the configured data", async () => {
    const out = await setData.run({
      config: { data: { price: 450 } },
      input: { ignored: true },
      log,
      signal,
    });
    expect(out).toEqual({ price: 450 });
  });

  it("if rule compares a field on the input", async () => {
    const ctx = {
      config: { field: "price", operator: "lessThan", value: 500 },
      input: { price: 450 },
      log,
      signal,
    };
    expect(await ifRule.run(ctx)).toBe(true);
    expect(await ifRule.run({ ...ctx, input: { price: 900 } })).toBe(false);
  });

  it("if rule supports equals and contains", async () => {
    expect(
      await ifRule.run({
        config: { field: "airline", operator: "equals", value: "Cebu Pacific" },
        input: { airline: "Cebu Pacific" },
        log,
        signal,
      }),
    ).toBe(true);
    expect(
      await ifRule.run({
        config: { field: "subject", operator: "contains", value: "invoice" },
        input: { subject: "Your invoice #42" },
        log,
        signal,
      }),
    ).toBe(true);
  });

  it("if rule fails friendly on an unknown operator", async () => {
    await expect(
      ifRule.run({
        config: { field: "x", operator: "resembles", value: 1 },
        input: { x: 1 },
        log,
        signal,
      }),
    ).rejects.toThrowError(/doesn't understand/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @autonimbus/nodes test`
Expected: FAIL — modules not found.

- [ ] **Step 3: Write the three nodes**

`packages/nodes/src/triggers/manual-trigger.ts`:
```ts
import type { NodeModule } from "@autonimbus/shared";

export const manualTrigger: NodeModule = {
  manifest: {
    slug: "core.manual-trigger",
    kind: "trigger",
    name: "When I click Run",
    description: "Starts the automation when you press the Run button.",
    inputHint: "Nothing — you start it yourself.",
    outputHint: "The sample data you configured, if any.",
  },
  async run(ctx) {
    return ctx.config.payload ?? {};
  },
};
```

`packages/nodes/src/actions/set-data.ts`:
```ts
import type { NodeModule } from "@autonimbus/shared";

export const setData: NodeModule = {
  manifest: {
    slug: "core.set-data",
    kind: "action",
    name: "Set data",
    description: "Replaces the flowing data with values you type in.",
    inputHint: "Anything (it will be replaced).",
    outputHint: "Exactly the data you configured.",
  },
  async run(ctx) {
    return ctx.config.data ?? {};
  },
};
```

`packages/nodes/src/rules/if.ts`:
```ts
import { AppError, type NodeModule } from "@autonimbus/shared";

export const ifRule: NodeModule = {
  manifest: {
    slug: "core.if",
    kind: "rule",
    name: "If…",
    description: "Continues down the matching branch based on a simple comparison.",
    inputHint: "Data with the field you want to compare.",
    outputHint: "true or false — which branch to follow.",
  },
  async run(ctx) {
    const { field, operator, value } = ctx.config as {
      field: string;
      operator: string;
      value: unknown;
    };
    const actual = (ctx.input as Record<string, unknown> | undefined)?.[field];
    switch (operator) {
      case "equals":
        return actual === value;
      case "lessThan":
        return Number(actual) < Number(value);
      case "greaterThan":
        return Number(actual) > Number(value);
      case "contains":
        return String(actual).toLowerCase().includes(String(value).toLowerCase());
      default:
        throw new AppError({
          code: "RULE_UNKNOWN_OPERATOR",
          friendlyMessage: `The If rule doesn't understand "${operator}".`,
          suggestedFix: "Use equals, lessThan, greaterThan, or contains.",
        });
    }
  },
};
```

Replace `packages/nodes/src/index.ts` with:
```ts
import type { NodeModule } from "@autonimbus/shared";
import { manualTrigger } from "./triggers/manual-trigger.js";
import { setData } from "./actions/set-data.js";
import { ifRule } from "./rules/if.js";

export { manualTrigger, setData, ifRule };

export const builtinNodes: NodeModule[] = [manualTrigger, setData, ifRule];
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @autonimbus/nodes test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/nodes && git commit -m "feat(nodes): manual trigger, set-data action, plain-English if rule"
```

---

### Task 11: engine — executor with caps and timeouts

**Files:**
- Create: `packages/engine/src/executor.ts`
- Modify: `packages/engine/src/index.ts`
- Test: `packages/engine/src/__tests__/executor.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { createLogger, type NodeModule, type WorkflowGraph } from "@autonimbus/shared";
import { NodeRegistry } from "../registry.js";
import { executeWorkflow } from "../executor.js";

const log = createLogger("test", { level: "silent" });

function makeRegistry(extra: NodeModule[] = []): NodeRegistry {
  const registry = new NodeRegistry();
  const base: NodeModule[] = [
    {
      manifest: { slug: "t.start", kind: "trigger", name: "Start", description: "", inputHint: "", outputHint: "" },
      run: async () => ({ price: 450 }),
    },
    {
      manifest: { slug: "t.double", kind: "action", name: "Double", description: "", inputHint: "", outputHint: "" },
      run: async (ctx) => ({ price: (ctx.input as { price: number }).price * 2 }),
    },
    {
      manifest: { slug: "t.cheap", kind: "rule", name: "Cheap?", description: "", inputHint: "", outputHint: "" },
      run: async (ctx) => (ctx.input as { price: number }).price < 500,
    },
  ];
  for (const mod of [...base, ...extra]) registry.register(mod);
  return registry;
}

function node(id: string, type: string, kind: "trigger" | "action" | "rule") {
  return { id, type, kind, label: id, config: {}, position: { x: 0, y: 0 } };
}

describe("executeWorkflow", () => {
  it("runs a linear chain passing data between nodes", async () => {
    const graph: WorkflowGraph = {
      nodes: [node("n1", "t.start", "trigger"), node("n2", "t.double", "action")],
      edges: [{ id: "e1", from: "n1", to: "n2" }],
    };
    const result = await executeWorkflow({ graph, registry: makeRegistry(), log });
    expect(result.status).toBe("success");
    expect(result.steps).toHaveLength(2);
    expect(result.steps[1].input).toEqual({ price: 450 });
    expect(result.steps[1].output).toEqual({ price: 900 });
  });

  it("follows the matching branch of a rule and keeps the rule's input", async () => {
    const graph: WorkflowGraph = {
      nodes: [
        node("n1", "t.start", "trigger"),
        node("n2", "t.cheap", "rule"),
        node("yes", "t.double", "action"),
        node("no", "t.double", "action"),
      ],
      edges: [
        { id: "e1", from: "n1", to: "n2" },
        { id: "e2", from: "n2", to: "yes", branch: "true" },
        { id: "e3", from: "n2", to: "no", branch: "false" },
      ],
    };
    const result = await executeWorkflow({ graph, registry: makeRegistry(), log });
    expect(result.status).toBe("success");
    expect(result.steps.map((s) => s.nodeId)).toEqual(["n1", "n2", "yes"]);
    expect(result.steps[2].input).toEqual({ price: 450 });
  });

  it("fails friendly when there is no trigger", async () => {
    const graph: WorkflowGraph = { nodes: [node("n2", "t.double", "action")], edges: [] };
    const result = await executeWorkflow({ graph, registry: makeRegistry(), log });
    expect(result.status).toBe("failed");
    expect(result.errorSummary).toMatch(/no trigger/i);
  });

  it("records a failed step with a friendly error and stops", async () => {
    const boom: NodeModule = {
      manifest: { slug: "t.boom", kind: "action", name: "Boom", description: "", inputHint: "", outputHint: "" },
      run: async () => {
        throw new Error("kaput");
      },
    };
    const graph: WorkflowGraph = {
      nodes: [node("n1", "t.start", "trigger"), node("n2", "t.boom", "action"), node("n3", "t.double", "action")],
      edges: [
        { id: "e1", from: "n1", to: "n2" },
        { id: "e2", from: "n2", to: "n3" },
      ],
    };
    const result = await executeWorkflow({ graph, registry: makeRegistry([boom]), log });
    expect(result.status).toBe("failed");
    expect(result.steps).toHaveLength(2);
    expect(result.steps[1].error?.friendlyMessage).toContain("kaput");
  });

  it("aborts a step that exceeds the timeout", async () => {
    const slow: NodeModule = {
      manifest: { slug: "t.slow", kind: "action", name: "Slow", description: "", inputHint: "", outputHint: "" },
      run: () => new Promise((resolve) => setTimeout(() => resolve("late"), 5_000)),
    };
    const graph: WorkflowGraph = {
      nodes: [node("n1", "t.start", "trigger"), node("n2", "t.slow", "action")],
      edges: [{ id: "e1", from: "n1", to: "n2" }],
    };
    const result = await executeWorkflow({
      graph,
      registry: makeRegistry([slow]),
      log,
      caps: { stepTimeoutMs: 50 },
    });
    expect(result.status).toBe("failed");
    expect(result.steps[1].error?.code).toBe("STEP_TIMEOUT");
  }, 2_000);

  it("stops runaway workflows at maxSteps", async () => {
    const graph: WorkflowGraph = {
      nodes: [node("n1", "t.start", "trigger"), node("n2", "t.double", "action")],
      edges: [
        { id: "e1", from: "n1", to: "n2" },
        { id: "e2", from: "n2", to: "n2" }, // self-loop
      ],
    };
    const result = await executeWorkflow({
      graph,
      registry: makeRegistry(),
      log,
      caps: { maxSteps: 5 },
    });
    expect(result.status).toBe("failed");
    expect(result.steps.length).toBeLessThanOrEqual(5);
    expect(result.errorSummary).toMatch(/5 steps/);
  });

  it("reports each step through onStep as it happens", async () => {
    const seen: string[] = [];
    const graph: WorkflowGraph = {
      nodes: [node("n1", "t.start", "trigger"), node("n2", "t.double", "action")],
      edges: [{ id: "e1", from: "n1", to: "n2" }],
    };
    await executeWorkflow({
      graph,
      registry: makeRegistry(),
      log,
      onStep: (step) => {
        seen.push(step.nodeId);
      },
    });
    expect(seen).toEqual(["n1", "n2"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @autonimbus/engine test -- executor`
Expected: FAIL — cannot find module `../executor.js`.

- [ ] **Step 3: Write the implementation**

`packages/engine/src/executor.ts`:
```ts
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
```

Update `packages/engine/src/index.ts`:
```ts
export * from "./registry.js";
export * from "./executor.js";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @autonimbus/engine test`
Expected: PASS (all executor + registry tests).

- [ ] **Step 5: Commit**

```bash
git add packages/engine && git commit -m "feat(engine): graph executor with branch routing, timeouts and step caps"
```

---

### Task 12: nodes — HTTP request with rate limiting and backoff

**Files:**
- Create: `packages/nodes/src/actions/http/rate-limiter.ts`, `packages/nodes/src/actions/http/http-request.ts`
- Modify: `packages/nodes/src/index.ts`
- Test: `packages/nodes/src/__tests__/http-request.test.ts`

- [ ] **Step 1: Write the failing rate limiter test** (same test file, first describe block)

```ts
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLogger } from "@autonimbus/shared";
import { RateLimiter } from "../actions/http/rate-limiter.js";
import { createHttpRequestNode } from "../actions/http/http-request.js";

const log = createLogger("test", { level: "silent" });
const signal = new AbortController().signal;

describe("RateLimiter", () => {
  it("spaces calls to the same key by the minimum interval", async () => {
    const limiter = new RateLimiter(100);
    const start = Date.now();
    await limiter.acquire("api.example.com");
    await limiter.acquire("api.example.com");
    await limiter.acquire("api.example.com");
    expect(Date.now() - start).toBeGreaterThanOrEqual(200);
  });

  it("does not delay calls to different keys", async () => {
    const limiter = new RateLimiter(200);
    const start = Date.now();
    await limiter.acquire("a.com");
    await limiter.acquire("b.com");
    expect(Date.now() - start).toBeLessThan(100);
  });
});

describe("http-request node", () => {
  let server: Server;
  let baseUrl: string;
  let hits = 0;
  let flakyRemaining = 0;

  beforeAll(async () => {
    server = createServer((req, res) => {
      hits += 1;
      if (req.url === "/json") {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ price: 450 }));
      } else if (req.url === "/flaky") {
        if (flakyRemaining > 0) {
          flakyRemaining -= 1;
          res.statusCode = 429;
          res.end("slow down");
        } else {
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ ok: true }));
        }
      } else {
        res.statusCode = 404;
        res.end("nope");
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address();
    baseUrl = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
  });

  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it("fetches and parses JSON", async () => {
    const httpNode = createHttpRequestNode({ limiter: new RateLimiter(0) });
    const out = (await httpNode.run({
      config: { method: "GET", url: `${baseUrl}/json` },
      input: {},
      log,
      signal,
    })) as { status: number; body: { price: number } };
    expect(out.status).toBe(200);
    expect(out.body.price).toBe(450);
  });

  it("retries with backoff on 429 and eventually succeeds", async () => {
    flakyRemaining = 2;
    const httpNode = createHttpRequestNode({
      limiter: new RateLimiter(0),
      backoffMs: [10, 20],
    });
    const out = (await httpNode.run({
      config: { method: "GET", url: `${baseUrl}/flaky` },
      input: {},
      log,
      signal,
    })) as { status: number };
    expect(out.status).toBe(200);
  });

  it("fails friendly after exhausting retries", async () => {
    flakyRemaining = 99;
    const httpNode = createHttpRequestNode({
      limiter: new RateLimiter(0),
      backoffMs: [10, 20],
    });
    await expect(
      httpNode.run({
        config: { method: "GET", url: `${baseUrl}/flaky` },
        input: {},
        log,
        signal,
      }),
    ).rejects.toThrowError(/asked us to slow down/i);
  });

  it("fails friendly on a 404", async () => {
    const httpNode = createHttpRequestNode({ limiter: new RateLimiter(0) });
    await expect(
      httpNode.run({
        config: { method: "GET", url: `${baseUrl}/missing` },
        input: {},
        log,
        signal,
      }),
    ).rejects.toThrowError(/404/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @autonimbus/nodes test -- http-request`
Expected: FAIL — modules not found.

- [ ] **Step 3: Write the rate limiter**

`packages/nodes/src/actions/http/rate-limiter.ts`:
```ts
// Spec §13: default one request per second per service, never removable.
export class RateLimiter {
  private readonly nextAllowed = new Map<string, number>();

  constructor(private readonly minIntervalMs = 1_000) {}

  async acquire(key: string): Promise<void> {
    const now = Date.now();
    const earliest = this.nextAllowed.get(key) ?? 0;
    const startAt = Math.max(now, earliest);
    this.nextAllowed.set(key, startAt + this.minIntervalMs);
    const wait = startAt - now;
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  }
}
```

- [ ] **Step 4: Write the HTTP node**

`packages/nodes/src/actions/http/http-request.ts`:
```ts
import { AppError, type NodeModule } from "@autonimbus/shared";
import { RateLimiter } from "./rate-limiter.js";

export interface HttpNodeOptions {
  limiter?: RateLimiter;
  backoffMs?: number[];
}

const RETRYABLE = new Set([429, 500, 502, 503, 504]);

export function createHttpRequestNode(options: HttpNodeOptions = {}): NodeModule {
  const limiter = options.limiter ?? new RateLimiter();
  const backoffMs = options.backoffMs ?? [500, 1_500, 4_000];

  return {
    manifest: {
      slug: "core.http-request",
      kind: "action",
      name: "Call an API",
      description: "Sends a request to any web API and returns what it says.",
      inputHint: "Optional data to send along.",
      outputHint: "The API's answer: status and body.",
    },
    async run(ctx) {
      const { method = "GET", url, headers = {}, body } = ctx.config as {
        method?: string;
        url: string;
        headers?: Record<string, string>;
        body?: unknown;
      };
      if (!url) {
        throw new AppError({
          code: "HTTP_URL_MISSING",
          friendlyMessage: "This API step has no address (URL) to call.",
          suggestedFix: "Open the step and paste the API's URL.",
        });
      }

      const host = new URL(url).host;
      let lastStatus = 0;

      for (let attempt = 0; attempt <= backoffMs.length; attempt++) {
        await limiter.acquire(host);
        let res: Response;
        try {
          res = await fetch(url, {
            method,
            headers: { "content-type": "application/json", ...headers },
            body: body === undefined ? undefined : JSON.stringify(body),
            signal: ctx.signal,
          });
        } catch (err) {
          throw new AppError({
            code: "HTTP_NETWORK_ERROR",
            friendlyMessage: `Couldn't reach ${host} — the network request failed.`,
            suggestedFix: "Check the URL and your internet connection, then run again.",
            cause: err,
          });
        }

        lastStatus = res.status;

        if (RETRYABLE.has(res.status) && attempt < backoffMs.length) {
          ctx.log.warn({ status: res.status, attempt }, "retrying after backoff");
          await new Promise((resolve) => setTimeout(resolve, backoffMs[attempt]));
          continue;
        }

        const contentType = res.headers.get("content-type") ?? "";
        const parsed = contentType.includes("application/json")
          ? await res.json()
          : await res.text();

        if (res.status === 429) {
          throw new AppError({
            code: "HTTP_RATE_LIMITED",
            friendlyMessage: `${host} asked us to slow down (429) and kept refusing after retries.`,
            suggestedFix: "Wait a few minutes, or lower how often this automation runs.",
          });
        }
        if (res.status >= 400) {
          throw new AppError({
            code: "HTTP_REQUEST_FAILED",
            friendlyMessage: `${host} answered with an error (${res.status}).`,
            suggestedFix: "Open the step and check the URL, method, and API key.",
          });
        }

        return { status: res.status, body: parsed };
      }

      throw new AppError({
        code: "HTTP_RATE_LIMITED",
        friendlyMessage: `${host} kept answering ${lastStatus} after every retry.`,
        suggestedFix: "Wait a few minutes and run again.",
      });
    },
  };
}
```

Update `packages/nodes/src/index.ts`:
```ts
import type { NodeModule } from "@autonimbus/shared";
import { manualTrigger } from "./triggers/manual-trigger.js";
import { setData } from "./actions/set-data.js";
import { ifRule } from "./rules/if.js";
import { createHttpRequestNode } from "./actions/http/http-request.js";

export { manualTrigger, setData, ifRule, createHttpRequestNode };
export { RateLimiter } from "./actions/http/rate-limiter.js";

export const builtinNodes: NodeModule[] = [
  manualTrigger,
  setData,
  ifRule,
  createHttpRequestNode(),
];
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @autonimbus/nodes test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/nodes && git commit -m "feat(nodes): http request node with per-host rate limiting and 429 backoff"
```

---

### Task 13: server — runs service and run API

**Files:**
- Create: `packages/server/src/services/runs-service.ts`, `packages/server/src/api/routes/runs.ts`
- Modify: `packages/server/src/app.ts`, `packages/server/src/main.ts`
- Test: `packages/server/src/__tests__/runs-api.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import "dotenv/config";
import { afterAll, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { createDb } from "../db/client.js";

const url = process.env.DATABASE_URL;

const graph = {
  nodes: [
    { id: "t1", type: "core.manual-trigger", kind: "trigger", label: "Run", config: { payload: { secretNote: "Bearer sk_live_abcdef1234567890xx", price: 450 } }, position: { x: 0, y: 0 } },
    { id: "a1", type: "core.set-data", kind: "action", label: "Set", config: { data: { done: true } }, position: { x: 200, y: 0 } },
  ],
  edges: [{ id: "e1", from: "t1", to: "a1" }],
};

describe.skipIf(!url)("runs API", () => {
  const { db, pool } = createDb(url!);
  const app = buildApp({ db });
  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  it("executes a workflow, persists the run and redacted step snapshots", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/workflows",
      payload: { name: "Runnable", graph },
    });
    const workflowId = created.json().id;

    const runRes = await app.inject({
      method: "POST",
      url: `/api/workflows/${workflowId}/run`,
    });
    expect(runRes.statusCode).toBe(201);
    const run = runRes.json();
    expect(run.status).toBe("success");

    const detail = await app.inject({ method: "GET", url: `/api/runs/${run.id}` });
    const body = detail.json();
    expect(body.run.workflowId).toBe(workflowId);
    expect(body.steps).toHaveLength(2);
    expect(body.steps[1].outputSnapshot).toEqual({ done: true });
    // Spec §12: secret-shaped values never reach stored snapshots.
    expect(JSON.stringify(body.steps)).not.toContain("sk_live_abcdef1234567890xx");

    await app.inject({ method: "DELETE", url: `/api/workflows/${workflowId}` });
  });

  it("lists runs for a workflow", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/workflows",
      payload: { name: "Listable", graph },
    });
    const workflowId = created.json().id;
    await app.inject({ method: "POST", url: `/api/workflows/${workflowId}/run` });
    const list = await app.inject({ method: "GET", url: `/api/workflows/${workflowId}/runs` });
    expect(list.json().length).toBeGreaterThanOrEqual(1);
    await app.inject({ method: "DELETE", url: `/api/workflows/${workflowId}` });
  });

  it("records a failed run with the error summary", async () => {
    const badGraph = {
      nodes: [
        { id: "t1", type: "core.manual-trigger", kind: "trigger", label: "Run", config: {}, position: { x: 0, y: 0 } },
        { id: "a1", type: "core.not-installed", kind: "action", label: "Missing", config: {}, position: { x: 200, y: 0 } },
      ],
      edges: [{ id: "e1", from: "t1", to: "a1" }],
    };
    const created = await app.inject({
      method: "POST",
      url: "/api/workflows",
      payload: { name: "Broken", graph: badGraph },
    });
    const workflowId = created.json().id;
    const runRes = await app.inject({ method: "POST", url: `/api/workflows/${workflowId}/run` });
    expect(runRes.json().status).toBe("failed");
    expect(runRes.json().errorSummary).toMatch(/isn't installed/i);
    await app.inject({ method: "DELETE", url: `/api/workflows/${workflowId}` });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @autonimbus/server test -- runs-api`
Expected: FAIL — route not found (404s).

- [ ] **Step 3: Write the runs service**

`packages/server/src/services/runs-service.ts`:
```ts
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
```

- [ ] **Step 4: Write the routes and wire everything**

`packages/server/src/api/routes/runs.ts`:
```ts
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
```

Update `packages/server/src/app.ts` (full file):
```ts
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
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @autonimbus/server test`
Expected: PASS (db, app, workflows-api, runs-api).

- [ ] **Step 6: Commit**

```bash
git add packages/server && git commit -m "feat(server): run execution API with persisted, redacted step snapshots"
```

---

### Task 14: End-to-end verification and README

**Files:**
- Create: `README.md`

- [ ] **Step 1: Full test sweep**

Run: `pnpm -r test`
Expected: every package PASSES.

- [ ] **Step 2: Manual end-to-end via curl**

```bash
pnpm dev &
sleep 2
curl -s http://127.0.0.1:4680/api/health
# → {"ok":true}

WF=$(curl -s -X POST http://127.0.0.1:4680/api/workflows \
  -H 'content-type: application/json' \
  -d '{"name":"First flow","graph":{"nodes":[{"id":"t1","type":"core.manual-trigger","kind":"trigger","label":"Run","config":{"payload":{"price":450}},"position":{"x":0,"y":0}},{"id":"r1","type":"core.if","kind":"rule","label":"Cheap?","config":{"field":"price","operator":"lessThan","value":500},"position":{"x":200,"y":0}},{"id":"a1","type":"core.set-data","kind":"action","label":"Mark cheap","config":{"data":{"verdict":"cheap"}},"position":{"x":400,"y":0}}],"edges":[{"id":"e1","from":"t1","to":"r1"},{"id":"e2","from":"r1","to":"a1","branch":"true"}]}}' \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')

curl -s -X POST http://127.0.0.1:4680/api/workflows/$WF/run
# → status "success"
kill %1
```
Expected: the run returns `"status":"success"`; `GET /api/runs/<id>` shows 3 steps ending in `{"verdict":"cheap"}`.

- [ ] **Step 3: Write README.md**

```markdown
# AutoNimbus

AI-agent-driven automation that runs entirely on your machine. Plain-English
nodes, a Figma-grade canvas (coming in Phase 4), and a Claude-powered builder
agent (Phase 5). Spec: `docs/superpowers/specs/2026-07-03-autonimbus-design.md`.

## Quickstart

```bash
docker compose up -d db     # local PostgreSQL on 127.0.0.1:5433
cp .env.example .env
pnpm install
pnpm --filter @autonimbus/server db:migrate
pnpm dev                    # API on http://127.0.0.1:4680
```

## Development

- `pnpm -r test` — run all package tests (needs the db container for server tests)
- Packages: `shared` (types/errors/logger/redaction) ← `engine` (executor) ← `nodes` (built-ins) ← `server` (API + Postgres)
- Everything binds to 127.0.0.1 only. Nothing is exposed to the network.
```

- [ ] **Step 4: Commit and push**

```bash
git add -A && git commit -m "docs: README quickstart; phase 1 complete"
git push
```

---

## Self-review notes

- **Spec coverage (phase 1 slice):** monorepo + folder structure (§2.2, Task 1), Postgres schema all 11 tables (§2.3, Task 6), loopback-only binding (§12, Task 7), friendly `AppError` shape end to end (§9, Tasks 2/8/13), correlation-ID logging (§2.4, Tasks 3/13), redacted snapshots (§12, Tasks 5/13), executor caps + timeouts (§13, Task 11), per-host rate limit + backoff (§13, Task 12), three node kinds with plain-English manifests (§3, Task 10). Remaining spec sections are explicitly assigned to Phases 2–6 in the roadmap.
- **Types checked:** `NodeModule`/`NodeContext` (Task 4) match usage in Tasks 9–13; `StepRecord` fields (Task 11) match `run_steps` columns written in Task 13; `buildApp(deps)` signature consistent across Tasks 7/8/13.
- **Node/engine boundary:** engine never imports `nodes`; server composes them — matches the one-way dependency rule (§2.1).
