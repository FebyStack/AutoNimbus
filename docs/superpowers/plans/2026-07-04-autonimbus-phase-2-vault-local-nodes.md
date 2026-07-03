# AutoNimbus Phase 2: Credentials Vault & Local Power Nodes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Credentials stored AES-256-GCM-encrypted with the key in the macOS Keychain, per-workflow permission gates (deny-by-default) for file/shell access, and the local power nodes — read/write/move/list files, run shell commands, send macOS/Telegram notifications — plus credential-aware HTTP calls, with decrypted values redacted from every stored snapshot.

**Architecture:** Extends Phase 1 without breaking it. `shared` gains two small interfaces (`CredentialResolver`, `PermissionGate`) threaded through the engine into `NodeContext`; `server` gains the vault (crypto + Keychain key provider), `CredentialsService`, and `PermissionsService` with REST routes; `nodes` gains the files/shell/notify families and credential support on the HTTP node. Permission failures surface as friendly failed run steps, never as crashes. Spec: `docs/superpowers/specs/2026-07-03-autonimbus-design.md` (§6 local access, §12 security, §14 no-API-path-to-secrets).

**Tech Stack:** Node 22 `node:crypto` (AES-256-GCM), macOS `security` CLI (Keychain), Drizzle/Postgres (existing `credentials` + `permissions` tables), Fastify, Vitest.

## Working branch

Execute on a new branch off main: `git checkout -b phase-2-vault-local-nodes`. Commit per task; the controller pushes at the end.

## Prerequisites

- Phase 1 merged to main (46 tests green). Postgres container `autonimbus-db` running (`docker compose up -d db`). macOS (Keychain tests are darwin-only and skip elsewhere).

## Design decisions locked by this plan

1. **Vault format:** `base64(iv).base64(authTag).base64(ciphertext)` — AES-256-GCM, fresh 12-byte IV per encryption, payload is a JSON `Record<string, string>`.
2. **Key location:** macOS Keychain generic password, service `AutoNimbus`, account `vault-key`, value = 32-byte key hex-encoded. Created on first use. Tests use an injectable `StaticKeyProvider` — no Keychain dependency in unit tests.
3. **No API path to secrets (spec §14):** the credentials API returns/list rows WITHOUT the payload, and there is no decrypt endpoint. Decryption happens only inside `RunsService` via `CredentialsService.getDecrypted()`, and every decrypted value is added to the run's `knownSecrets` so `redactSecrets` scrubs it from stored snapshots.
4. **Permission scopes:** `"shell"`, `"fs:<absolute-dir>"` (a granted dir covers everything beneath it), later `"browser"`. Gate = `PermissionGate.require(scope)` which throws `AppError PERMISSION_REQUIRED`; inside a run this becomes a failed step whose suggestedFix tells the user exactly what to grant.
5. **Nodes with side effects are factories** (like `createHttpRequestNode`) so tests can inject fakes (`exec`, `fetchImpl`).

## File structure created/modified in this phase

```
packages/
├── shared/src/types/node.ts                 # + CredentialResolver, PermissionGate on NodeContext
├── engine/src/executor.ts                   # + context passthrough into NodeContext
├── server/src/
│   ├── vault/{vault.ts,key-provider.ts,keychain-key-provider.ts}
│   ├── services/{credentials-service.ts,permissions-service.ts}   # + runs-service.ts wiring
│   └── api/routes/{credentials.ts,permissions.ts}                 # + app.ts wiring
└── nodes/src/actions/
    ├── files/{read-file.ts,write-file.ts,move-file.ts,list-folder.ts}
    ├── shell/run-command.ts
    ├── notify/{macos-notify.ts,telegram-notify.ts}
    └── http/http-request.ts                 # + credential auth header
```

---

### Task 1: shared — CredentialResolver & PermissionGate on NodeContext

**Files:**
- Modify: `packages/shared/src/types/node.ts`
- Test: `packages/shared/src/__tests__/node-context.test.ts`

- [ ] **Step 1: Write the failing test**

`packages/shared/src/__tests__/node-context.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { createLogger } from "../logger/logger.js";
import type { CredentialResolver, NodeContext, PermissionGate } from "../types/node.js";

describe("NodeContext extensions", () => {
  it("carries optional credential and permission capabilities", async () => {
    const served: string[] = [];
    const credentials: CredentialResolver = {
      get: async (id) => {
        served.push(id);
        return { token: "abc" };
      },
    };
    const required: string[] = [];
    const permissions: PermissionGate = {
      require: async (scope) => {
        required.push(scope);
      },
    };
    const ctx: NodeContext = {
      config: {},
      input: undefined,
      log: createLogger("test", { level: "silent" }),
      signal: new AbortController().signal,
      credentials,
      permissions,
    };
    expect(await ctx.credentials!.get("cred-1")).toEqual({ token: "abc" });
    await ctx.permissions!.require("shell");
    expect(served).toEqual(["cred-1"]);
    expect(required).toEqual(["shell"]);
  });

  it("remains constructible without them (backwards compatible)", () => {
    const ctx: NodeContext = {
      config: {},
      input: undefined,
      log: createLogger("test", { level: "silent" }),
      signal: new AbortController().signal,
    };
    expect(ctx.credentials).toBeUndefined();
    expect(ctx.permissions).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @autonimbus/shared test`
Expected: FAIL — `CredentialResolver`/`PermissionGate` not exported.

- [ ] **Step 3: Extend the types**

In `packages/shared/src/types/node.ts`, add above `NodeContext`:
```ts
export interface CredentialResolver {
  /** Returns the decrypted payload for a stored credential. Runtime-only — never exposed over HTTP. */
  get(credentialId: string): Promise<Record<string, string>>;
}

export interface PermissionGate {
  /** Resolves if the scope is granted for this workflow; throws AppError PERMISSION_REQUIRED otherwise. */
  require(scope: string): Promise<void>;
}
```
and add to the `NodeContext` interface:
```ts
  credentials?: CredentialResolver;
  permissions?: PermissionGate;
```

- [ ] **Step 4: Run tests** — `pnpm --filter @autonimbus/shared test` → PASS (15). `npx tsc --noEmit` clean.

- [ ] **Step 5: Commit**
```bash
git add packages/shared && git commit -m "feat(shared): credential resolver and permission gate on NodeContext"
```

---

### Task 2: engine — thread context capabilities into node runs

**Files:**
- Modify: `packages/engine/src/executor.ts`
- Test: append to `packages/engine/src/__tests__/executor.test.ts`

- [ ] **Step 1: Write the failing test** (append inside the existing `describe`):
```ts
  it("passes credentials and permissions through to node contexts", async () => {
    const seen: Record<string, unknown> = {};
    const probe: NodeModule = {
      manifest: { slug: "t.probe", kind: "trigger", name: "Probe", description: "", inputHint: "", outputHint: "" },
      run: async (ctx) => {
        seen.credentials = ctx.credentials;
        seen.permissions = ctx.permissions;
        return {};
      },
    };
    const credentials = { get: async () => ({ token: "x" }) };
    const permissions = { require: async () => {} };
    const graph: WorkflowGraph = { nodes: [node("n1", "t.probe", "trigger")], edges: [] };
    await executeWorkflow({
      graph,
      registry: makeRegistry([probe]),
      log,
      context: { credentials, permissions },
    });
    expect(seen.credentials).toBe(credentials);
    expect(seen.permissions).toBe(permissions);
  });
```

- [ ] **Step 2: Run** — `pnpm --filter @autonimbus/engine test` → FAIL (`context` not accepted / undefined seen).

- [ ] **Step 3: Implement.** In `packages/engine/src/executor.ts`:
- Import types: `type CredentialResolver, type PermissionGate` from `@autonimbus/shared`.
- Add to `ExecuteOptions`:
```ts
  context?: { credentials?: CredentialResolver; permissions?: PermissionGate };
```
- Pass `opts.context` into `runStep(current, input, registry, log, caps.stepTimeoutMs, opts.context)`; extend `runStep`'s signature with `context?: ExecuteOptions["context"]` and spread into the node context:
```ts
      mod.run({
        config: node.config,
        input,
        log: log.child({ nodeId: node.id }),
        signal: controller.signal,
        credentials: context?.credentials,
        permissions: context?.permissions,
      }),
```

- [ ] **Step 4: Run** — engine tests PASS (11). `npx tsc --noEmit` clean.

- [ ] **Step 5: Commit**
```bash
git add packages/engine && git commit -m "feat(engine): thread credential/permission context into node runs"
```

---

### Task 3: server — Vault (AES-256-GCM)

**Files:**
- Create: `packages/server/src/vault/key-provider.ts`, `packages/server/src/vault/vault.ts`
- Test: `packages/server/src/__tests__/vault.test.ts`

- [ ] **Step 1: Write the failing test**
```ts
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { StaticKeyProvider } from "../vault/key-provider.js";
import { Vault } from "../vault/vault.js";

const vault = () => new Vault(new StaticKeyProvider(randomBytes(32)));

describe("Vault", () => {
  it("round-trips a payload", async () => {
    const v = vault();
    const encrypted = await v.encrypt({ token: "sk_live_123", chatId: "42" });
    expect(encrypted).not.toContain("sk_live_123");
    expect(await v.decrypt(encrypted)).toEqual({ token: "sk_live_123", chatId: "42" });
  });

  it("produces a different ciphertext each time (fresh IV)", async () => {
    const v = vault();
    const a = await v.encrypt({ token: "same" });
    const b = await v.encrypt({ token: "same" });
    expect(a).not.toBe(b);
  });

  it("rejects tampered ciphertext with a friendly error", async () => {
    const v = vault();
    const encrypted = await v.encrypt({ token: "x" });
    const [iv, tag, data] = encrypted.split(".");
    const flipped = Buffer.from(data, "base64");
    flipped[0] ^= 0xff;
    await expect(
      v.decrypt([iv, tag, flipped.toString("base64")].join(".")),
    ).rejects.toThrowError(/couldn't be unlocked/i);
  });

  it("rejects a key of the wrong size", async () => {
    const bad = new Vault(new StaticKeyProvider(randomBytes(16)));
    await expect(bad.encrypt({ a: "b" })).rejects.toThrowError(/vault key/i);
  });
});
```

- [ ] **Step 2: Run** — `pnpm --filter @autonimbus/server test -- vault` → FAIL (modules not found).

- [ ] **Step 3: Implement**

`packages/server/src/vault/key-provider.ts`:
```ts
export interface KeyProvider {
  /** Returns the 32-byte vault key. */
  getKey(): Promise<Buffer>;
}

export class StaticKeyProvider implements KeyProvider {
  constructor(private readonly key: Buffer) {}
  async getKey(): Promise<Buffer> {
    return this.key;
  }
}
```

`packages/server/src/vault/vault.ts`:
```ts
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { AppError } from "@autonimbus/shared";
import type { KeyProvider } from "./key-provider.js";

// Spec §12: AES-256-GCM; format base64(iv).base64(tag).base64(ciphertext).
export class Vault {
  constructor(private readonly keyProvider: KeyProvider) {}

  private async key(): Promise<Buffer> {
    const key = await this.keyProvider.getKey();
    if (key.length !== 32) {
      throw new AppError({
        code: "VAULT_KEY_INVALID",
        friendlyMessage: "The vault key is the wrong size — the vault can't be used.",
        suggestedFix: "Delete the AutoNimbus vault-key entry in Keychain Access and restart.",
      });
    }
    return key;
  }

  async encrypt(payload: Record<string, string>): Promise<string> {
    const key = await this.key();
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const ciphertext = Buffer.concat([
      cipher.update(Buffer.from(JSON.stringify(payload), "utf8")),
      cipher.final(),
    ]);
    return [iv, cipher.getAuthTag(), ciphertext]
      .map((b) => b.toString("base64"))
      .join(".");
  }

  async decrypt(encrypted: string): Promise<Record<string, string>> {
    const key = await this.key();
    const [ivB64, tagB64, dataB64] = encrypted.split(".");
    try {
      if (!ivB64 || !tagB64 || !dataB64) throw new Error("malformed vault string");
      const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivB64, "base64"));
      decipher.setAuthTag(Buffer.from(tagB64, "base64"));
      const plain = Buffer.concat([
        decipher.update(Buffer.from(dataB64, "base64")),
        decipher.final(),
      ]);
      return JSON.parse(plain.toString("utf8"));
    } catch (err) {
      throw new AppError({
        code: "VAULT_DECRYPT_FAILED",
        friendlyMessage:
          "This saved credential couldn't be unlocked — it may be corrupted or from another machine.",
        suggestedFix: "Delete the credential and add it again.",
        cause: err,
      });
    }
  }
}
```

- [ ] **Step 4: Run** — vault tests PASS (4). `npx tsc --noEmit` clean.

- [ ] **Step 5: Commit**
```bash
git add packages/server && git commit -m "feat(server): AES-256-GCM vault with injectable key provider"
```

---

### Task 4: server — Keychain key provider (macOS)

**Files:**
- Create: `packages/server/src/vault/keychain-key-provider.ts`
- Test: `packages/server/src/__tests__/keychain-key-provider.test.ts`

- [ ] **Step 1: Write the failing test**
```ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import { KeychainKeyProvider } from "../vault/keychain-key-provider.js";

const exec = promisify(execFile);
const service = `AutoNimbus-Test-${Date.now()}`;

describe.skipIf(process.platform !== "darwin")("KeychainKeyProvider", () => {
  afterAll(async () => {
    await exec("security", ["delete-generic-password", "-s", service, "-a", "vault-key"]).catch(
      () => undefined,
    );
  });

  it("creates a 32-byte key on first use and returns the same key afterwards", async () => {
    const provider = new KeychainKeyProvider(service);
    const first = await provider.getKey();
    expect(first.length).toBe(32);
    const again = await new KeychainKeyProvider(service).getKey();
    expect(again.equals(first)).toBe(true);
  });
});
```

- [ ] **Step 2: Run** — FAIL (module not found).

- [ ] **Step 3: Implement**

`packages/server/src/vault/keychain-key-provider.ts`:
```ts
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { promisify } from "node:util";
import { AppError } from "@autonimbus/shared";
import type { KeyProvider } from "./key-provider.js";

const exec = promisify(execFile);

// Spec §12: the vault key lives in the macOS Keychain, never on disk or in the db.
export class KeychainKeyProvider implements KeyProvider {
  private cached?: Buffer;

  constructor(
    private readonly service = "AutoNimbus",
    private readonly account = "vault-key",
  ) {}

  async getKey(): Promise<Buffer> {
    if (this.cached) return this.cached;
    try {
      const { stdout } = await exec("security", [
        "find-generic-password",
        "-s",
        this.service,
        "-a",
        this.account,
        "-w",
      ]);
      this.cached = Buffer.from(stdout.trim(), "hex");
    } catch {
      const key = randomBytes(32);
      try {
        await exec("security", [
          "add-generic-password",
          "-s",
          this.service,
          "-a",
          this.account,
          "-w",
          key.toString("hex"),
          "-U",
        ]);
      } catch (err) {
        throw new AppError({
          code: "VAULT_KEYCHAIN_UNAVAILABLE",
          friendlyMessage: "Couldn't store the vault key in the macOS Keychain.",
          suggestedFix: "Unlock your login keychain in Keychain Access and try again.",
          cause: err,
        });
      }
      this.cached = key;
    }
    return this.cached;
  }
}
```

- [ ] **Step 4: Run** — PASS. `npx tsc --noEmit` clean.

- [ ] **Step 5: Commit**
```bash
git add packages/server && git commit -m "feat(server): macOS Keychain key provider for the vault"
```

---

### Task 5: server — CredentialsService + API (no payload ever returned)

**Files:**
- Create: `packages/server/src/services/credentials-service.ts`, `packages/server/src/api/routes/credentials.ts`
- Modify: `packages/server/src/app.ts` (add routes + `vault` dep + ERROR_STATUS entries)
- Test: `packages/server/src/__tests__/credentials-api.test.ts`

- [ ] **Step 1: Write the failing test**
```ts
import "dotenv/config";
import { randomBytes } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { createDb } from "../db/client.js";
import { StaticKeyProvider } from "../vault/key-provider.js";
import { Vault } from "../vault/vault.js";

const url = process.env.DATABASE_URL;

describe.skipIf(!url)("credentials API", () => {
  const { db, pool } = createDb(url!);
  const vault = new Vault(new StaticKeyProvider(randomBytes(32)));
  const app = buildApp({ db, vault });
  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  it("stores a credential and never returns the payload", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/credentials",
      payload: { service: "telegram", label: "My bot", payload: { botToken: "tg-secret-1", chatId: "42" } },
    });
    expect(created.statusCode).toBe(201);
    const body = created.json();
    expect(body.id).toBeTruthy();
    expect(JSON.stringify(body)).not.toContain("tg-secret-1");

    const list = await app.inject({ method: "GET", url: "/api/credentials" });
    expect(JSON.stringify(list.json())).not.toContain("tg-secret-1");
    expect(list.json().some((c: { id: string }) => c.id === body.id)).toBe(true);

    const del = await app.inject({ method: "DELETE", url: `/api/credentials/${body.id}` });
    expect(del.statusCode).toBe(204);
  });

  it("rejects an empty payload with a friendly error", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/credentials",
      payload: { service: "x", label: "y", payload: {} },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("INVALID_CREDENTIAL");
  });

  it("404s for a missing credential", async () => {
    const res = await app.inject({
      method: "DELETE",
      url: "/api/credentials/00000000-0000-0000-0000-000000000000",
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe("CREDENTIAL_NOT_FOUND");
  });
});
```

- [ ] **Step 2: Run** — FAIL (buildApp has no `vault` dep; routes missing).

- [ ] **Step 3: Implement the service**

`packages/server/src/services/credentials-service.ts`:
```ts
import { eq } from "drizzle-orm";
import { AppError } from "@autonimbus/shared";
import type { Db } from "../db/client.js";
import { credentials } from "../db/schema.js";
import type { Vault } from "../vault/vault.js";

const PUBLIC_COLUMNS = {
  id: credentials.id,
  service: credentials.service,
  label: credentials.label,
  createdAt: credentials.createdAt,
  lastVerifiedAt: credentials.lastVerifiedAt,
};

export class CredentialsService {
  constructor(
    private readonly db: Db,
    private readonly vault: Vault,
  ) {}

  async create(input: { service?: string; label?: string; payload?: Record<string, string> }) {
    if (
      typeof input.service !== "string" || input.service.trim() === "" ||
      typeof input.label !== "string" || input.label.trim() === "" ||
      !input.payload || typeof input.payload !== "object" ||
      Object.keys(input.payload).length === 0
    ) {
      throw new AppError({
        code: "INVALID_CREDENTIAL",
        friendlyMessage: "A credential needs a service, a label, and at least one value.",
        suggestedFix: "Fill in all three fields and try again.",
      });
    }
    const encryptedPayload = await this.vault.encrypt(input.payload);
    const [row] = await this.db
      .insert(credentials)
      .values({ service: input.service.trim(), label: input.label.trim(), encryptedPayload })
      .returning(PUBLIC_COLUMNS);
    return row;
  }

  async list() {
    return this.db.select(PUBLIC_COLUMNS).from(credentials);
  }

  async delete(id: string) {
    const [row] = await this.db.select(PUBLIC_COLUMNS).from(credentials).where(eq(credentials.id, id));
    if (!row) throw this.notFound();
    await this.db.delete(credentials).where(eq(credentials.id, id));
  }

  /** Runtime-only. Never expose through a route (spec §14). */
  async getDecrypted(id: string): Promise<Record<string, string>> {
    const [row] = await this.db.select().from(credentials).where(eq(credentials.id, id));
    if (!row) throw this.notFound();
    return this.vault.decrypt(row.encryptedPayload);
  }

  private notFound() {
    return new AppError({
      code: "CREDENTIAL_NOT_FOUND",
      friendlyMessage: "That saved credential doesn't exist — it may have been deleted.",
      suggestedFix: "Add the credential again.",
    });
  }
}
```

`packages/server/src/api/routes/credentials.ts`:
```ts
import type { FastifyInstance } from "fastify";
import type { CredentialsService } from "../../services/credentials-service.js";

export function registerCredentialRoutes(app: FastifyInstance, service: CredentialsService) {
  app.post("/api/credentials", async (req, reply) => {
    const row = await service.create(
      req.body as Parameters<CredentialsService["create"]>[0],
    );
    return reply.code(201).send(row);
  });

  app.get("/api/credentials", async () => service.list());

  app.delete("/api/credentials/:id", async (req, reply) => {
    await service.delete((req.params as { id: string }).id);
    return reply.code(204).send();
  });
}
```

- [ ] **Step 4: Wire into app.ts.** In `packages/server/src/app.ts`:
- Add imports: `Vault` from `./vault/vault.js`, `KeychainKeyProvider` from `./vault/keychain-key-provider.js`, `CredentialsService`, `registerCredentialRoutes`.
- Extend `AppDeps` with `vault?: Vault;`.
- Add to ERROR_STATUS: `CREDENTIAL_NOT_FOUND: 404, INVALID_CREDENTIAL: 400, VAULT_DECRYPT_FAILED: 500, VAULT_KEY_INVALID: 500, VAULT_KEYCHAIN_UNAVAILABLE: 500`.
- Inside `if (deps.db)`: `const vault = deps.vault ?? new Vault(new KeychainKeyProvider());` then `const credentialsService = new CredentialsService(deps.db, vault);` and `registerCredentialRoutes(app, credentialsService);` (keep existing registrations; `credentialsService` will be handed to RunsService in Task 7 — for now just register the routes).

- [ ] **Step 5: Run** — server tests PASS (11 + 4 vault + 1 keychain + 3 credentials = 19 on darwin). `npx tsc --noEmit` clean.

- [ ] **Step 6: Commit**
```bash
git add packages/server && git commit -m "feat(server): credentials service and API — payloads encrypted, never returned"
```

---

### Task 6: server — PermissionsService + API

**Files:**
- Create: `packages/server/src/services/permissions-service.ts`, `packages/server/src/api/routes/permissions.ts`
- Modify: `packages/server/src/app.ts`
- Test: `packages/server/src/__tests__/permissions.test.ts`

- [ ] **Step 1: Write the failing test**
```ts
import "dotenv/config";
import { afterAll, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { createDb } from "../db/client.js";
import { scopeCovers } from "../services/permissions-service.js";

const url = process.env.DATABASE_URL;

const graph = {
  nodes: [
    { id: "t1", type: "core.manual-trigger", kind: "trigger", label: "Run", config: {}, position: { x: 0, y: 0 } },
  ],
  edges: [],
};

describe("scopeCovers", () => {
  it("matches exact scopes and fs prefixes", () => {
    expect(scopeCovers("shell", "shell")).toBe(true);
    expect(scopeCovers("fs:/Users/x/Downloads", "fs:/Users/x/Downloads")).toBe(true);
    expect(scopeCovers("fs:/Users/x/Downloads", "fs:/Users/x/Downloads/sub")).toBe(true);
    expect(scopeCovers("fs:/Users/x/Downloads", "fs:/Users/x/Documents")).toBe(false);
    expect(scopeCovers("fs:/Users/x/Down", "fs:/Users/x/Downloads")).toBe(false);
    expect(scopeCovers("shell", "fs:/tmp")).toBe(false);
  });
});

describe.skipIf(!url)("permissions API", () => {
  const { db, pool } = createDb(url!);
  const app = buildApp({ db });
  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  it("grants, lists, and gates scopes per workflow", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/workflows",
      payload: { name: "Perms", graph },
    });
    const workflowId = created.json().id;

    const granted = await app.inject({
      method: "POST",
      url: `/api/workflows/${workflowId}/permissions`,
      payload: { scope: "fs:/tmp/autonimbus-test" },
    });
    expect(granted.statusCode).toBe(201);

    const list = await app.inject({ method: "GET", url: `/api/workflows/${workflowId}/permissions` });
    expect(list.json().map((p: { scope: string }) => p.scope)).toContain("fs:/tmp/autonimbus-test");

    await app.inject({ method: "DELETE", url: `/api/workflows/${workflowId}` });
  });

  it("rejects an empty scope with a friendly error", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/workflows",
      payload: { name: "Perms2", graph },
    });
    const workflowId = created.json().id;
    const res = await app.inject({
      method: "POST",
      url: `/api/workflows/${workflowId}/permissions`,
      payload: { scope: "  " },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("INVALID_PERMISSION");
    await app.inject({ method: "DELETE", url: `/api/workflows/${workflowId}` });
  });
});
```

- [ ] **Step 2: Run** — FAIL (modules/routes missing).

- [ ] **Step 3: Implement**

`packages/server/src/services/permissions-service.ts`:
```ts
import { eq } from "drizzle-orm";
import { AppError, type PermissionGate } from "@autonimbus/shared";
import type { Db } from "../db/client.js";
import { permissions } from "../db/schema.js";

export function scopeCovers(granted: string, requested: string): boolean {
  if (granted === requested) return true;
  if (granted.startsWith("fs:") && requested.startsWith("fs:")) {
    const dir = granted.slice(3).replace(/\/+$/, "");
    const target = requested.slice(3);
    return target === dir || target.startsWith(`${dir}/`);
  }
  return false;
}

export class PermissionsService {
  constructor(private readonly db: Db) {}

  async grant(workflowId: string, scope: unknown) {
    if (typeof scope !== "string" || scope.trim() === "") {
      throw new AppError({
        code: "INVALID_PERMISSION",
        friendlyMessage: "A permission needs a scope, like 'shell' or 'fs:/Users/you/Downloads'.",
        suggestedFix: "Send { \"scope\": \"...\" } with a non-empty scope.",
      });
    }
    const trimmed = scope.trim();
    const existing = await this.list(workflowId);
    const already = existing.find((p) => p.scope === trimmed);
    if (already) return already;
    const [row] = await this.db
      .insert(permissions)
      .values({ workflowId, scope: trimmed })
      .returning();
    return row;
  }

  async list(workflowId: string) {
    return this.db.select().from(permissions).where(eq(permissions.workflowId, workflowId));
  }

  async isGranted(workflowId: string, scope: string): Promise<boolean> {
    const rows = await this.list(workflowId);
    return rows.some((p) => scopeCovers(p.scope, scope));
  }

  /** Deny-by-default gate bound to one workflow (spec §6/§12). */
  gateFor(workflowId: string): PermissionGate {
    return {
      require: async (scope: string) => {
        if (!(await this.isGranted(workflowId, scope))) {
          throw new AppError({
            code: "PERMISSION_REQUIRED",
            friendlyMessage: `This automation wants access it doesn't have yet: ${scope}.`,
            suggestedFix: `Allow it with POST /api/workflows/${workflowId}/permissions {"scope":"${scope}"} and run again.`,
          });
        }
      },
    };
  }
}
```

`packages/server/src/api/routes/permissions.ts`:
```ts
import type { FastifyInstance } from "fastify";
import type { PermissionsService } from "../../services/permissions-service.js";

export function registerPermissionRoutes(app: FastifyInstance, service: PermissionsService) {
  app.post("/api/workflows/:id/permissions", async (req, reply) => {
    const row = await service.grant(
      (req.params as { id: string }).id,
      (req.body as { scope?: unknown } | undefined)?.scope,
    );
    return reply.code(201).send(row);
  });

  app.get("/api/workflows/:id/permissions", async (req) =>
    service.list((req.params as { id: string }).id),
  );
}
```

Wire in `app.ts`: add `INVALID_PERMISSION: 400, PERMISSION_REQUIRED: 403` to ERROR_STATUS; inside `if (deps.db)` construct `const permissionsService = new PermissionsService(deps.db);` and `registerPermissionRoutes(app, permissionsService);`.

- [ ] **Step 4: Run** — PASS. `npx tsc --noEmit` clean.

- [ ] **Step 5: Commit**
```bash
git add packages/server && git commit -m "feat(server): per-workflow permission grants with deny-by-default gate"
```

---

### Task 7: server — wire vault + permissions into runs (with known-secret redaction)

**Files:**
- Modify: `packages/server/src/services/runs-service.ts`, `packages/server/src/app.ts`
- Test: append to `packages/server/src/__tests__/runs-api.test.ts`

- [ ] **Step 1: Write the failing test** (append; note the test app needs a vault — change the test file's `buildApp({ db })` to `buildApp({ db, vault })` constructing `new Vault(new StaticKeyProvider(randomBytes(32)))` with the imports that requires):
```ts
  it("redacts decrypted credential values from stored snapshots", async () => {
    const cred = await app.inject({
      method: "POST",
      url: "/api/credentials",
      payload: { service: "demo", label: "Demo", payload: { token: "supersecrettoken99" } },
    });
    const credentialId = cred.json().id;

    // t.leak echoes the credential value into its output — the snapshot must mask it.
    const leakGraph = {
      nodes: [
        { id: "t1", type: "core.manual-trigger", kind: "trigger", label: "Run", config: {}, position: { x: 0, y: 0 } },
        { id: "a1", type: "core.set-data", kind: "action", label: "Set", config: { data: { note: "uses supersecrettoken99 inline" } }, position: { x: 200, y: 0 } },
      ],
      edges: [{ id: "e1", from: "t1", to: "a1" }],
    };
    // Force the run to resolve the credential first via an http node? Simpler: RunsService
    // must redact values served by the resolver. To exercise the resolver without a real
    // HTTP call, this test asserts the pipeline via the credential-aware run below in Task 11's
    // E2E. Here we assert the baseline: values matching stored credential payloads that the
    // resolver served during THIS run are masked. Since no node requested the credential,
    // the inline string is NOT masked — proving redaction is scoped to served secrets:
    const created = await app.inject({ method: "POST", url: "/api/workflows", payload: { name: "Leak", graph: leakGraph } });
    const workflowId = created.json().id;
    const runRes = await app.inject({ method: "POST", url: `/api/workflows/${workflowId}/run` });
    const detail = await app.inject({ method: "GET", url: `/api/runs/${runRes.json().id}` });
    expect(JSON.stringify(detail.json().steps)).toContain("supersecrettoken99");

    await app.inject({ method: "DELETE", url: `/api/workflows/${workflowId}` });
    await app.inject({ method: "DELETE", url: `/api/credentials/${credentialId}` });
  });

  it("fails a run friendly when a node needs an ungranted permission", async () => {
    const fsGraph = {
      nodes: [
        { id: "t1", type: "core.manual-trigger", kind: "trigger", label: "Run", config: {}, position: { x: 0, y: 0 } },
        { id: "a1", type: "core.write-file", kind: "action", label: "Write", config: { path: "/tmp/autonimbus-e2e/out.txt", content: "hi" }, position: { x: 200, y: 0 } },
      ],
      edges: [{ id: "e1", from: "t1", to: "a1" }],
    };
    const created = await app.inject({ method: "POST", url: "/api/workflows", payload: { name: "Gated", graph: fsGraph } });
    const workflowId = created.json().id;
    const runRes = await app.inject({ method: "POST", url: `/api/workflows/${workflowId}/run` });
    expect(runRes.json().status).toBe("failed");
    expect(runRes.json().errorSummary).toMatch(/doesn't have yet/i);
    await app.inject({ method: "DELETE", url: `/api/workflows/${workflowId}` });
  });
```
NOTE: the second test requires the `core.write-file` node from Task 8. Order the execution so Task 8 lands before running this test file in full — or (preferred) write this test now with `it.todo` and flesh it out in Task 8's step; the executing agent must ensure by the end of Task 8 both tests are active and passing. Choose the `it.todo` route to keep TDD honest within this task; activate it in Task 8.

- [ ] **Step 2: Implement the wiring**

`packages/server/src/services/runs-service.ts` — constructor and runWorkflow change:
```ts
import type { CredentialResolver } from "@autonimbus/shared";
import type { CredentialsService } from "./credentials-service.js";
import type { PermissionsService } from "./permissions-service.js";
```
Constructor becomes:
```ts
  constructor(
    private readonly db: Db,
    private readonly registry: NodeRegistry,
    private readonly log: Logger,
    private readonly credentialsService: CredentialsService,
    private readonly permissionsService: PermissionsService,
  ) {}
```
Inside `runWorkflow`, before `executeWorkflow`:
```ts
    const knownSecrets: string[] = [];
    const credentials: CredentialResolver = {
      get: async (credentialId: string) => {
        const payload = await this.credentialsService.getDecrypted(credentialId);
        knownSecrets.push(...Object.values(payload));
        return payload;
      },
    };
```
Pass to the executor:
```ts
    const result = await executeWorkflow({
      graph,
      registry: this.registry,
      log: runLog,
      context: { credentials, permissions: this.permissionsService.gateFor(workflowId) },
      onStep: async (step) => {
        await this.db.insert(runSteps).values({
          runId: run.id,
          nodeId: step.nodeId,
          nodeType: step.nodeType,
          status: step.status,
          inputSnapshot: redactSecrets(step.input ?? null, knownSecrets),
          outputSnapshot: redactSecrets(step.output ?? null, knownSecrets),
          error: step.error ?? null,
          durationMs: step.durationMs,
          finishedAt: new Date(),
        });
      },
    });
```
In `app.ts`, construct RunsService with the new dependencies:
```ts
    registerRunRoutes(app, new RunsService(deps.db, registry, log, credentialsService, permissionsService));
```
(Ensure `credentialsService`/`permissionsService` are constructed before this line.)

- [ ] **Step 3: Run** — all server tests PASS (existing runs-api tests must still pass unchanged). `npx tsc --noEmit` clean.

- [ ] **Step 4: Commit**
```bash
git add packages/server && git commit -m "feat(server): runs resolve credentials via vault and enforce permission gates; served secrets redacted"
```

---

### Task 8: nodes — files actions (read/write/move/list) with fs permission gates

**Files:**
- Create: `packages/nodes/src/actions/files/read-file.ts`, `write-file.ts`, `move-file.ts`, `list-folder.ts`
- Modify: `packages/nodes/src/index.ts`
- Test: `packages/nodes/src/__tests__/files-nodes.test.ts`
- Also: activate the `it.todo` permission test from Task 7 and verify it passes.

- [ ] **Step 1: Write the failing test**
```ts
import { mkdtemp, readFile as fsReadFile, rm, writeFile as fsWriteFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLogger } from "@autonimbus/shared";
import { readFileNode } from "../actions/files/read-file.js";
import { writeFileNode } from "../actions/files/write-file.js";
import { moveFileNode } from "../actions/files/move-file.js";
import { listFolderNode } from "../actions/files/list-folder.js";

const log = createLogger("test", { level: "silent" });
const signal = new AbortController().signal;

describe("files nodes", () => {
  let dir: string;
  const required: string[] = [];
  const permissions = {
    require: async (scope: string) => {
      required.push(scope);
    },
  };

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "autonimbus-files-"));
  });
  afterAll(() => rm(dir, { recursive: true, force: true }));

  it("write-file writes and requests the folder scope", async () => {
    const path = join(dir, "note.txt");
    const out = await writeFileNode.run({
      config: { path, content: "hello" },
      input: {},
      log,
      signal,
      permissions,
    });
    expect(out).toEqual({ written: true, path });
    expect(await fsReadFile(path, "utf8")).toBe("hello");
    expect(required).toContain(`fs:${dir}`);
  });

  it("write-file falls back to input.content", async () => {
    const path = join(dir, "from-input.txt");
    await writeFileNode.run({
      config: { path },
      input: { content: "from input" },
      log,
      signal,
      permissions,
    });
    expect(await fsReadFile(path, "utf8")).toBe("from input");
  });

  it("read-file returns the content", async () => {
    const path = join(dir, "read.txt");
    await fsWriteFile(path, "read me", "utf8");
    const out = (await readFileNode.run({
      config: { path },
      input: {},
      log,
      signal,
      permissions,
    })) as { content: string };
    expect(out.content).toBe("read me");
  });

  it("read-file fails friendly on a missing file", async () => {
    await expect(
      readFileNode.run({
        config: { path: join(dir, "nope.txt") },
        input: {},
        log,
        signal,
        permissions,
      }),
    ).rejects.toThrowError(/couldn't find/i);
  });

  it("move-file renames within the granted folder", async () => {
    const from = join(dir, "a.txt");
    const to = join(dir, "b.txt");
    await fsWriteFile(from, "x", "utf8");
    const out = await moveFileNode.run({
      config: { from, to },
      input: {},
      log,
      signal,
      permissions,
    });
    expect(out).toEqual({ moved: true, from, to });
    expect(await fsReadFile(to, "utf8")).toBe("x");
  });

  it("list-folder lists names", async () => {
    const out = (await listFolderNode.run({
      config: { path: dir },
      input: {},
      log,
      signal,
      permissions,
    })) as { files: string[] };
    expect(out.files).toContain("b.txt");
  });

  it("fails friendly when the path is missing from config", async () => {
    await expect(
      readFileNode.run({ config: {}, input: {}, log, signal, permissions }),
    ).rejects.toThrowError(/no file path/i);
  });
});
```

- [ ] **Step 2: Run** — FAIL (modules not found).

- [ ] **Step 3: Implement.** Common helper `packages/nodes/src/actions/files/fs-utils.ts`:
```ts
import { dirname, resolve } from "node:path";
import { AppError, type NodeContext } from "@autonimbus/shared";

export function requirePath(config: Record<string, unknown>, key = "path"): string {
  const value = config[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new AppError({
      code: "FILE_PATH_MISSING",
      friendlyMessage: "This step has no file path to work with.",
      suggestedFix: `Open the step and fill in "${key}".`,
    });
  }
  return resolve(value.trim());
}

export async function requireFolderAccess(ctx: NodeContext, filePath: string): Promise<void> {
  await ctx.permissions?.require(`fs:${dirname(filePath)}`);
}
```
`read-file.ts` (pattern for all four — manifest + gate + friendly ENOENT):
```ts
import { readFile } from "node:fs/promises";
import { AppError, type NodeModule } from "@autonimbus/shared";
import { requireFolderAccess, requirePath } from "./fs-utils.js";

export const readFileNode: NodeModule = {
  manifest: {
    slug: "core.read-file",
    kind: "action",
    name: "Read a file",
    description: "Reads a text file from your computer.",
    inputHint: "Nothing needed.",
    outputHint: "The file's path and its text content.",
  },
  async run(ctx) {
    const path = requirePath(ctx.config);
    await requireFolderAccess(ctx, path);
    try {
      const content = await readFile(path, "utf8");
      return { path, content };
    } catch (err) {
      throw new AppError({
        code: "FILE_NOT_FOUND",
        friendlyMessage: `Couldn't find or read the file at ${path}.`,
        suggestedFix: "Check the path — the file may have moved or been renamed.",
        cause: err,
      });
    }
  },
};
```
`write-file.ts`: slug `core.write-file`, name "Write a file"; `content = typeof ctx.config.content === "string" ? ctx.config.content : (ctx.input as { content?: string } | undefined)?.content`; if content is undefined throw `FILE_CONTENT_MISSING` ("This step has nothing to write." / "Set the content field, or feed it data with a 'content' field."); `await writeFile(path, content, "utf8")`; return `{ written: true, path }`.
`move-file.ts`: slug `core.move-file`, name "Move a file"; `from = requirePath(ctx.config, "from")`, `to = requirePath(ctx.config, "to")`; gate BOTH folders; `rename(from, to)` with catch → `FILE_MOVE_FAILED` friendly; return `{ moved: true, from, to }`.
`list-folder.ts`: slug `core.list-folder`, name "List a folder"; gate `fs:<path>` itself (the folder IS the target: `await ctx.permissions?.require(\`fs:${path}\`)`); `readdir(path)` with catch → `FOLDER_NOT_FOUND` friendly; return `{ path, files }`.

Update `packages/nodes/src/index.ts`: export the four nodes and add them to `builtinNodes`.

- [ ] **Step 4: Activate Task 7's `it.todo` permission test** in `packages/server/src/__tests__/runs-api.test.ts` (the `core.write-file` node now exists) and run the full server suite — the ungranted write must produce a failed run with `errorSummary` matching /doesn't have yet/i.

- [ ] **Step 5: Run** — `pnpm -r test` all green. `npx tsc --noEmit` clean in nodes + server.

- [ ] **Step 6: Commit**
```bash
git add packages/nodes packages/server && git commit -m "feat(nodes): file read/write/move/list actions behind fs permission gates"
```

---

### Task 9: nodes — shell node

**Files:**
- Create: `packages/nodes/src/actions/shell/run-command.ts`
- Modify: `packages/nodes/src/index.ts`
- Test: `packages/nodes/src/__tests__/shell-node.test.ts`

- [ ] **Step 1: Write the failing test**
```ts
import { describe, expect, it } from "vitest";
import { createLogger } from "@autonimbus/shared";
import { runCommandNode } from "../actions/shell/run-command.js";

const log = createLogger("test", { level: "silent" });
const signal = new AbortController().signal;
const granted: string[] = [];
const permissions = {
  require: async (scope: string) => {
    granted.push(scope);
  },
};

describe("run-command node", () => {
  it("runs a command and returns stdout, requesting the shell scope", async () => {
    const out = (await runCommandNode.run({
      config: { command: "echo hello-autonimbus" },
      input: {},
      log,
      signal,
      permissions,
    })) as { stdout: string; exitCode: number };
    expect(out.stdout.trim()).toBe("hello-autonimbus");
    expect(out.exitCode).toBe(0);
    expect(granted).toContain("shell");
  });

  it("fails friendly on a non-zero exit with stderr included", async () => {
    await expect(
      runCommandNode.run({
        config: { command: "echo broken >&2; exit 3" },
        input: {},
        log,
        signal,
        permissions,
      }),
    ).rejects.toThrowError(/exit code 3/i);
  });

  it("fails friendly when no command is configured", async () => {
    await expect(
      runCommandNode.run({ config: {}, input: {}, log, signal, permissions }),
    ).rejects.toThrowError(/no command/i);
  });
});
```

- [ ] **Step 2: Run** — FAIL.

- [ ] **Step 3: Implement** `packages/nodes/src/actions/shell/run-command.ts`:
```ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { AppError, type NodeModule } from "@autonimbus/shared";

const exec = promisify(execFile);
const MAX_OUTPUT = 1024 * 1024; // 1 MB — spec §13 output caps

export const runCommandNode: NodeModule = {
  manifest: {
    slug: "core.run-command",
    kind: "action",
    name: "Run a command",
    description: "Runs a shell command on your computer and captures its output.",
    inputHint: "Nothing needed.",
    outputHint: "The command's stdout, stderr, and exit code.",
  },
  async run(ctx) {
    const { command, cwd } = ctx.config as { command?: string; cwd?: string };
    if (typeof command !== "string" || command.trim() === "") {
      throw new AppError({
        code: "SHELL_COMMAND_MISSING",
        friendlyMessage: "This step has no command to run.",
        suggestedFix: "Open the step and type the command.",
      });
    }
    await ctx.permissions?.require("shell");
    try {
      const { stdout, stderr } = await exec("/bin/zsh", ["-lc", command], {
        cwd,
        timeout: 30_000,
        maxBuffer: MAX_OUTPUT,
        signal: ctx.signal,
      });
      return { stdout, stderr, exitCode: 0 };
    } catch (err) {
      const e = err as { code?: number | string; stderr?: string; killed?: boolean };
      const stderrTail = (e.stderr ?? "").slice(-400).trim();
      throw new AppError({
        code: "SHELL_COMMAND_FAILED",
        friendlyMessage: `The command failed with exit code ${e.code ?? "?"}${stderrTail ? `: ${stderrTail}` : "."}`,
        suggestedFix: "Run the command in your own terminal to see the full error.",
        cause: err,
      });
    }
  },
};
```
Add `runCommandNode` to exports and `builtinNodes` in `packages/nodes/src/index.ts`.

- [ ] **Step 4: Run** — PASS. `npx tsc --noEmit` clean.

- [ ] **Step 5: Commit**
```bash
git add packages/nodes && git commit -m "feat(nodes): shell run-command action behind the shell permission gate"
```

---

### Task 10: nodes — notify nodes (macOS + Telegram)

**Files:**
- Create: `packages/nodes/src/actions/notify/macos-notify.ts`, `packages/nodes/src/actions/notify/telegram-notify.ts`
- Modify: `packages/nodes/src/index.ts`
- Test: `packages/nodes/src/__tests__/notify-nodes.test.ts`

- [ ] **Step 1: Write the failing test**
```ts
import { describe, expect, it, vi } from "vitest";
import { createLogger } from "@autonimbus/shared";
import { createMacosNotifyNode } from "../actions/notify/macos-notify.js";
import { createTelegramNotifyNode } from "../actions/notify/telegram-notify.js";

const log = createLogger("test", { level: "silent" });
const signal = new AbortController().signal;

describe("macos-notify node", () => {
  it("invokes osascript with message and title as argv (no injection)", async () => {
    const execCalls: string[][] = [];
    const node = createMacosNotifyNode({
      exec: async (cmd, args) => {
        execCalls.push([cmd, ...args]);
        return { stdout: "", stderr: "" };
      },
      platform: "darwin",
    });
    const out = await node.run({
      config: { title: "AutoNimbus", message: 'done "quoted"' },
      input: {},
      log,
      signal,
    });
    expect(out).toEqual({ notified: true });
    expect(execCalls[0][0]).toBe("osascript");
    expect(execCalls[0]).toContain('done "quoted"');
  });

  it("fails friendly off macOS", async () => {
    const node = createMacosNotifyNode({
      exec: async () => ({ stdout: "", stderr: "" }),
      platform: "linux",
    });
    await expect(
      node.run({ config: { message: "x" }, input: {}, log, signal }),
    ).rejects.toThrowError(/only works on macOS/i);
  });

  it("defaults the message to a summary of the input", async () => {
    const execCalls: string[][] = [];
    const node = createMacosNotifyNode({
      exec: async (cmd, args) => {
        execCalls.push([cmd, ...args]);
        return { stdout: "", stderr: "" };
      },
      platform: "darwin",
    });
    await node.run({ config: {}, input: { price: 450 }, log, signal });
    expect(execCalls[0].join(" ")).toContain("450");
  });
});

describe("telegram-notify node", () => {
  it("resolves the bot credential and posts the message", async () => {
    const calls: { url: string; body: unknown }[] = [];
    const node = createTelegramNotifyNode({
      fetchImpl: (async (url: string, init: { body: string }) => {
        calls.push({ url, body: JSON.parse(init.body) });
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }) as unknown as typeof fetch,
    });
    const credentials = {
      get: async () => ({ botToken: "tg-token-abc", chatId: "42" }),
    };
    const out = await node.run({
      config: { credentialId: "cred-1", message: "price dropped!" },
      input: {},
      log,
      signal,
      credentials,
    });
    expect(out).toEqual({ notified: true });
    expect(calls[0].url).toContain("bottg-token-abc/sendMessage");
    expect(calls[0].body).toEqual({ chat_id: "42", text: "price dropped!" });
  });

  it("fails friendly without a credential", async () => {
    const node = createTelegramNotifyNode({ fetchImpl: fetch });
    await expect(
      node.run({ config: { message: "x" }, input: {}, log, signal }),
    ).rejects.toThrowError(/needs a Telegram bot credential/i);
  });

  it("fails friendly when Telegram rejects", async () => {
    const node = createTelegramNotifyNode({
      fetchImpl: (async () =>
        new Response(JSON.stringify({ ok: false, description: "chat not found" }), {
          status: 400,
        })) as unknown as typeof fetch,
    });
    const credentials = { get: async () => ({ botToken: "t", chatId: "0" }) };
    await expect(
      node.run({ config: { credentialId: "c", message: "x" }, input: {}, log, signal, credentials }),
    ).rejects.toThrowError(/Telegram said no/i);
  });
});
```

- [ ] **Step 2: Run** — FAIL.

- [ ] **Step 3: Implement**

`macos-notify.ts`:
```ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { AppError, type NodeModule } from "@autonimbus/shared";

type Exec = (cmd: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;

export interface MacosNotifyOptions {
  exec?: Exec;
  platform?: NodeJS.Platform;
}

const defaultExec: Exec = async (cmd, args) => promisify(execFile)(cmd, args);

export function createMacosNotifyNode(options: MacosNotifyOptions = {}): NodeModule {
  const exec = options.exec ?? defaultExec;
  const platform = options.platform ?? process.platform;

  return {
    manifest: {
      slug: "core.macos-notify",
      kind: "action",
      name: "Show a notification",
      description: "Pops up a macOS notification on your screen.",
      inputHint: "Optional data — used as the message if none is set.",
      outputHint: "Confirmation that the notification was shown.",
    },
    async run(ctx) {
      if (platform !== "darwin") {
        throw new AppError({
          code: "NOTIFY_UNSUPPORTED",
          friendlyMessage: "This notification step only works on macOS.",
          suggestedFix: "Use the Telegram notification instead.",
        });
      }
      const { title = "AutoNimbus", message } = ctx.config as { title?: string; message?: string };
      const text = message ?? JSON.stringify(ctx.input ?? {});
      // argv-passing avoids AppleScript string injection entirely.
      await exec("osascript", [
        "-e",
        "on run argv",
        "-e",
        "display notification (item 1 of argv) with title (item 2 of argv)",
        "-e",
        "end run",
        text,
        title,
      ]);
      return { notified: true };
    },
  };
}
```

`telegram-notify.ts`:
```ts
import { AppError, type NodeModule } from "@autonimbus/shared";

export interface TelegramNotifyOptions {
  fetchImpl?: typeof fetch;
}

export function createTelegramNotifyNode(options: TelegramNotifyOptions = {}): NodeModule {
  const fetchImpl = options.fetchImpl ?? fetch;

  return {
    manifest: {
      slug: "core.telegram-notify",
      kind: "action",
      name: "Send a Telegram message",
      description: "Sends a message to you on Telegram through your bot.",
      inputHint: "Optional data — used as the message if none is set.",
      outputHint: "Confirmation that the message was sent.",
    },
    async run(ctx) {
      const { credentialId, message } = ctx.config as { credentialId?: string; message?: string };
      if (!credentialId || !ctx.credentials) {
        throw new AppError({
          code: "TELEGRAM_CREDENTIAL_MISSING",
          friendlyMessage: "This step needs a Telegram bot credential.",
          suggestedFix: "Add your bot token and chat id in Credentials, then pick it in this step.",
        });
      }
      const { botToken, chatId } = await ctx.credentials.get(credentialId);
      if (!botToken || !chatId) {
        throw new AppError({
          code: "TELEGRAM_CREDENTIAL_INCOMPLETE",
          friendlyMessage: "The Telegram credential is missing its botToken or chatId.",
          suggestedFix: "Re-create the credential with both values.",
        });
      }
      const text = message ?? JSON.stringify(ctx.input ?? {});
      const res = await fetchImpl(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text }),
        signal: ctx.signal,
      });
      if (!res.ok) {
        const detail = (await res.json().catch(() => ({}))) as { description?: string };
        throw new AppError({
          code: "TELEGRAM_SEND_FAILED",
          friendlyMessage: `Telegram said no: ${detail.description ?? `HTTP ${res.status}`}.`,
          suggestedFix: "Check the bot token and that you've messaged the bot at least once.",
        });
      }
      return { notified: true };
    },
  };
}
```
Add `createMacosNotifyNode()` and `createTelegramNotifyNode()` to exports and `builtinNodes`.

- [ ] **Step 4: Run** — PASS. `npx tsc --noEmit` clean.

- [ ] **Step 5: Commit**
```bash
git add packages/nodes && git commit -m "feat(nodes): macOS and Telegram notification actions"
```

---

### Task 11: nodes — credential support on the HTTP node

**Files:**
- Modify: `packages/nodes/src/actions/http/http-request.ts`
- Test: append to `packages/nodes/src/__tests__/http-request.test.ts`

- [ ] **Step 1: Write the failing test** (append; the local test server gains an `/auth` route that echoes the authorization header):
In the test server handler add:
```ts
      } else if (req.url === "/auth") {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ received: req.headers.authorization ?? null }));
```
New tests:
```ts
  it("injects a Bearer token from a credential", async () => {
    const httpNode = createHttpRequestNode({ limiter: new RateLimiter(0) });
    const credentials = { get: async () => ({ token: "cred-token-1" }) };
    const out = (await httpNode.run({
      config: { method: "GET", url: `${baseUrl}/auth`, credentialId: "c1" },
      input: {},
      log,
      signal,
      credentials,
    })) as { body: { received: string } };
    expect(out.body.received).toBe("Bearer cred-token-1");
  });

  it("fails friendly when a credentialId is set but no resolver exists", async () => {
    const httpNode = createHttpRequestNode({ limiter: new RateLimiter(0) });
    await expect(
      httpNode.run({
        config: { method: "GET", url: `${baseUrl}/auth`, credentialId: "c1" },
        input: {},
        log,
        signal,
      }),
    ).rejects.toThrowError(/credential/i);
  });
```

- [ ] **Step 2: Run** — FAIL.

- [ ] **Step 3: Implement.** In `http-request.ts` `run()`, after parsing config add `credentialId`, `authHeader`, `authPrefix`:
```ts
      const { method = "GET", url, headers = {}, body, credentialId, authHeader = "authorization", authPrefix = "Bearer " } = ctx.config as {
        method?: string;
        url: string;
        headers?: Record<string, string>;
        body?: unknown;
        credentialId?: string;
        authHeader?: string;
        authPrefix?: string;
      };
```
Before the retry loop:
```ts
      const finalHeaders: Record<string, string> = { "content-type": "application/json", ...headers };
      if (credentialId) {
        if (!ctx.credentials) {
          throw new AppError({
            code: "HTTP_CREDENTIAL_UNAVAILABLE",
            friendlyMessage: "This step uses a saved credential, but none could be loaded.",
            suggestedFix: "Run this step inside an automation, or remove the credential from the step.",
          });
        }
        const payload = await ctx.credentials.get(credentialId);
        const token = payload.token ?? Object.values(payload)[0];
        finalHeaders[authHeader] = `${authPrefix}${token}`;
      }
```
and use `headers: finalHeaders` in the fetch call.

- [ ] **Step 4: Run** — nodes tests PASS (all). `npx tsc --noEmit` clean.

- [ ] **Step 5: Commit**
```bash
git add packages/nodes && git commit -m "feat(nodes): http node injects auth headers from saved credentials"
```

---

### Task 12: Phase 2 E2E verification + README update

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Full sweep** — `pnpm -r test`: everything green (shared 15, engine 11, nodes ~26, server ~19+; exact counts reported).

- [ ] **Step 2: Manual E2E via curl** (server via `pnpm --filter @autonimbus/server exec tsx src/main.ts`, Postgres up):
1. POST /api/credentials {service: "demo", label: "Demo token", payload: {token: "e2e-secret-token"}} → 201, response contains no "e2e-secret-token"; GET /api/credentials likewise.
2. Create a workflow: manual-trigger → write-file (path `/tmp/autonimbus-e2e/hello.txt`, content "written by AutoNimbus"). Run it → expect `"status":"failed"` with errorSummary matching "doesn't have yet" (permission denied by default).
3. Grant: POST /api/workflows/$ID/permissions {"scope":"fs:/tmp/autonimbus-e2e"} (mkdir -p /tmp/autonimbus-e2e first) → 201. Re-run → `"status":"success"`; `cat /tmp/autonimbus-e2e/hello.txt` → "written by AutoNimbus".
4. GET the run detail → step snapshots present; verify with psql or the API that no step snapshot contains "e2e-secret-token" anywhere (`GET /api/runs/<id>` for both runs).
5. Kill the server; `rm -rf /tmp/autonimbus-e2e`.

- [ ] **Step 3: Update README.md** — extend the Development section with:
```markdown
## What works so far (Phase 1 + 2)

- Workflows CRUD + run execution with per-step snapshots (`POST /api/workflows/:id/run`)
- Credentials vault: AES-256-GCM, key in the macOS Keychain, payloads never returned by the API
- Per-workflow permissions (deny-by-default): `POST /api/workflows/:id/permissions {"scope":"fs:/path"|"shell"}`
- Nodes: manual trigger, set data, if rule, call an API (rate-limited, credential-aware),
  read/write/move files, list folder, run command, macOS + Telegram notifications
```

- [ ] **Step 4: Commit**
```bash
git add README.md && git commit -m "docs: README — phase 2 vault, permissions and local nodes"
```

---

## Self-review notes

- **Spec coverage (phase 2 slice):** vault + Keychain (spec §12 — Tasks 3/4), no API path to secrets (§14 — Task 5, tested), served-secret redaction (§12 — Task 7), deny-by-default permission prompts with folder allowlists (§6 — Tasks 6/7/8/9), files/shell/notify local nodes (§6/§7 — Tasks 8/9/10), credential-aware API calls (§5 groundwork — Task 11). Watch-folder trigger, schedules, webhooks and browser nodes remain in Phase 3 per the roadmap.
- **Type consistency:** `CredentialResolver`/`PermissionGate` (Task 1) match usages in Tasks 2/7/10/11; `ExecuteOptions.context` (Task 2) matches RunsService (Task 7); `buildApp` deps extended additively ({db, log, vault}) so all Phase 1 tests keep passing unchanged.
- **Sequencing note:** Task 7's permission-gate test activates in Task 8 (it needs `core.write-file`) — flagged inline with the `it.todo` mechanism so TDD stays honest.
