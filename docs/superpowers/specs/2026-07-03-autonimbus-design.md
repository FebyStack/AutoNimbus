# AutoNimbus — Design Spec

**Date:** 2026-07-03
**Status:** Approved by Febriel
**Audience for v1:** Personal tool (single user, macOS)

## 1. What it is

A local-first, AI-agent-driven automation platform that runs entirely on the user's Mac. It keeps n8n's best ideas (visual canvas, run-one-step testing, HTTP-to-anything, replayable run data) and removes its worst (jargon, JSON-wrangling, steep learning curve, confusing credential setup). Like OpenClaw, it has real access to the computer and browser — it reads the DOM through a bundled local Chrome via Playwright, so scraping and web automation cost zero API credits.

### Design principles (refinements over n8n)

- **Plain English everywhere.** No "webhook trigger," no "parse JSON." Nodes are named by what they do: *When something happens*, *Get data from a website*, *Send me a message*.
- **The agent is a builder, not a chatbot.** The user describes the outcome; Nimbus (the Claude agent) plans the nodes, builds them on the canvas, test-runs them, and can write brand-new node types when none exists.
- **Data you can see.** Between every two nodes the user sees actual sample data rendered as tables/cards, never raw JSON (raw view behind a toggle).
- **Free where possible.** DOM reading, file access, schedules, and shell steps run locally at no cost. Claude is spent only on planning/building and on steps that genuinely need intelligence — and those can route to Ollama when good enough.

### Research basis

- n8n strengths kept: visual editor, curl import on the HTTP node, single-step testing, replay of past run data, scheduling/webhooks, AI-step nodes. ([n8n features](https://n8n.io/features/), [n8n docs](https://docs.n8n.io/))
- n8n pain points addressed: non-technical users report 20+ hours of learning with nothing working; jargon gap ("webhook trigger", "parse the JSON response"); docs written for developers; manual AI-agent setup; JSON/API knowledge required. (Sources: [Tom Crawshaw on n8n's learning curve](https://www.linkedin.com/posts/tomcrawshaw_n8ns-learning-curve-is-brutal-ive-lost-activity-7387473016118693888-tTBF), [Lindy n8n review](https://www.lindy.ai/blog/n8n-review), [G2 n8n reviews](https://www.g2.com/products/n8n/reviews))
- OpenClaw model borrowed: local-first data sovereignty, full computer access with granular permissions, local browser automation, AI that extends itself by building its own capabilities. ([openclaw.ai](https://openclaw.ai/))

## 2. Architecture

Fresh Node.js/TypeScript pnpm monorepo (approach chosen over forking n8n — no inherited complexity, no Sustainable Use license constraints — and over a Python split-stack). One command to start (`pnpm dev`), UI served at `localhost:4680`.

One Node.js process runs server + engine + scheduler. Playwright drives a local headless (or headful, watchable) Chrome. Everything persists in a local **PostgreSQL** database (connection string in `.env`; a `docker compose up db` file ships with the repo for one-command setup, or point it at an existing local Postgres). Logs and run artifacts live on disk under `data/`.

### 2.1 System overview & data flow

```
┌─────────────────────────── Browser (localhost:4680) ───────────────────────────┐
│  web: canvas (React Flow) · inspector · palette · wizard · Nimbus chat · runs  │
└──────────────┬────────────────────────────────────────────┬────────────────────┘
               │ REST (CRUD, run commands)                  │ WebSocket (live run
               ▼                                            ▼  status, chat stream)
┌──────────────────────────── Node.js process ───────────────────────────────────┐
│  server (Fastify)  ── owns ──  db (PostgreSQL) · vault (encrypted credentials) │
│      │                                                                          │
│      ├── engine: executor (walks graph) · runtime (loads nodes, timeouts,      │
│      │           sandboxing) · scheduler (cron → enqueue runs)                  │
│      │       └── nodes: triggers / actions / rules  ──► Playwright Chrome,     │
│      │                                                  fs, shell, HTTP, AI    │
│      └── agent (Nimbus): Claude Agent SDK session + tools that call the same   │
│                          server services (buildWorkflow, createNodeType,       │
│                          writeSetupGuide, fixRun) · model router (Claude/Ollama)│
└─────────────────────────────────────────────────────────────────────────────────┘
```

Dependency direction is strict and one-way: `web → server → engine → nodes`, with `shared` (types, errors, logger) imported by everyone and nothing importing `web`. The agent is a peer of the engine and mutates workflows only through the same services the REST API uses — so anything Nimbus builds is reproducible by hand, and anything debuggable by hand is debuggable when Nimbus did it.

### 2.2 Folder structure (debug-friendly by design)

Every package has the same internal shape (`src/` by feature, colocated `__tests__/`), so you always know where to look. Runtime state is isolated in `data/` (gitignored), never mixed with code.

```
autonimbus/
├── pnpm-workspace.yaml · package.json · tsconfig.base.json · .env.example
├── docs/
│   └── superpowers/specs/            # design specs & plans
├── docker-compose.yml                # local PostgreSQL (one command: docker compose up db)
├── data/                             # runtime state — gitignored
│   ├── logs/                         # daily-rotated structured logs (JSON lines)
│   └── artifacts/<runId>/            # per-run screenshots, downloads, HTML dumps
├── packages/
│   ├── shared/                       # imported by all packages, imports nothing
│   │   └── src/
│   │       ├── types/                # WorkflowGraph, NodeManifest, RunStatus, events
│   │       ├── errors/               # AppError hierarchy (code + friendly message + fix)
│   │       └── logger/               # pino wrapper; child loggers scoped by runId/nodeId
│   ├── engine/
│   │   └── src/
│   │       ├── executor/             # graph walker, branch/rule evaluation, step runner
│   │       ├── runtime/              # node loading + hot-reload, per-step timeout, sandbox
│   │       ├── scheduler/            # plain-English → cron, next-run computation
│   │       └── __tests__/
│   ├── nodes/
│   │   └── src/
│   │       ├── triggers/             # schedule, webhook, file-watch, page-change, manual
│   │       ├── actions/
│   │       │   ├── browser/          # Playwright family (open, extract, fill, click, shot)
│   │       │   ├── http/             # API call node + curl import
│   │       │   ├── files/            # read/write/move/watch
│   │       │   ├── shell/            # run command (permission-gated)
│   │       │   ├── notify/           # macOS notification, email, Telegram
│   │       │   └── ai/               # summarize/classify/extract (model-routed)
│   │       ├── rules/                # if / filter / repeat
│   │       ├── community/            # agent- and user-created nodes (hot-loaded)
│   │       └── __tests__/            # contract tests + fixture pages for browser nodes
│   ├── agent/
│   │   └── src/
│   │       ├── nimbus/               # Claude Agent SDK session lifecycle, subscription auth
│   │       ├── tools/                # buildWorkflow, createNodeType, writeSetupGuide, fixRun
│   │       ├── routing/              # Auto router: Ollama if simple + installed, else Claude
│   │       └── __tests__/
│   ├── server/
│   │   └── src/
│   │       ├── api/routes/           # workflows, runs, credentials, node-types, agent, guides
│   │       ├── ws/                   # run-status + chat streaming channels
│   │       ├── services/             # business logic shared by REST routes and agent tools
│   │       ├── db/                   # Drizzle ORM schema + versioned migrations/
│   │       ├── vault/                # AES-256-GCM credential encryption (key in macOS Keychain)
│   │       └── __tests__/
│   └── web/
│       └── src/
│           ├── app/                  # shell, routing, providers
│           ├── canvas/               # React Flow custom nodes/edges/toolbar/minimap
│           ├── inspector/            # right-panel node settings
│           ├── palette/              # node library sidebar
│           ├── chat/                 # Nimbus panel + inline space-bar summon
│           ├── wizard/               # guided API setup flow
│           ├── runs/                 # run history, step data viewer, replay
│           ├── stores/               # Zustand state (one store per feature)
│           └── styles/               # design tokens, Figma-grade theme
└── e2e/                              # Playwright end-to-end: build → run → fix smoke test
```

### 2.3 Database schema (PostgreSQL, Drizzle ORM, versioned migrations)

| Table | Purpose | Key columns |
|---|---|---|
| `workflows` | One row per automation | `id`, `name`, `description`, `graph` (JSON: nodes + edges + positions), `status` (draft/active/paused), `created_at`, `updated_at` |
| `runs` | One row per execution | `id`, `workflow_id`, `trigger_kind`, `status` (running/success/failed/cancelled), `started_at`, `finished_at`, `error_summary` |
| `run_steps` | One row per node execution — the debugging backbone | `id`, `run_id`, `node_id`, `node_type`, `status`, `input_snapshot` (JSON), `output_snapshot` (JSON), `error` (JSON: code, friendly_message, suggested_fix, stack), `model_used`, `duration_ms` |
| `node_types` | Registry of every node, built-in or generated | `id` (slug), `kind` (trigger/action/rule), `source` (builtin/agent/user), `manifest` (JSON), `file_path`, `version`, `enabled` |
| `credentials` | Encrypted service keys | `id`, `service`, `label`, `encrypted_payload`, `created_at`, `last_verified_at` |
| `setup_guides` | Wizard content | `service`, `steps` (JSON), `source` (builtin/generated), `generated_at` |
| `schedules` | Cron state per workflow | `id`, `workflow_id`, `cron_expr`, `plain_text`, `next_run_at`, `enabled` |
| `webhooks` | Incoming webhook endpoints | `id`, `workflow_id`, `path_token`, `secret` |
| `permissions` | Remembered grants | `id`, `workflow_id`, `scope` (e.g. `fs:/Users/x/Downloads`, `shell`, `browser`), `granted_at` |
| `chat_messages` | Nimbus conversation history | `id`, `workflow_id` (nullable), `role`, `content`, `created_at` |
| `settings` | App config | `key`, `value` |

Snapshots in `run_steps` are what powers both the replay-while-editing feature and "Let Nimbus fix it" (the agent reads the exact input that broke the node). Large payloads (screenshots, files) go to `data/artifacts/<runId>/` with only the path stored in the row.

### 2.4 Debuggability conventions

- **Correlation IDs end to end.** Every run gets a `runId`; every log line, WebSocket event, DB row, and artifact folder carries it (plus `nodeId` at step level). One grep — or one query on `run_steps` — reconstructs any failure.
- **Structured logs.** Pino JSON lines to `data/logs/`, daily-rotated, with child loggers per package (`engine`, `nodes.browser`, `agent`, …) so noise is filterable by source.
- **Errors normalized at boundaries.** Every package throws `AppError { code, friendlyMessage, suggestedFix, cause }`; raw errors are wrapped, never swallowed. The UI's plain-English error (section 9) is the same object the logs and Nimbus see — one source of truth.
- **Failure artifacts.** Browser nodes auto-capture a screenshot + HTML dump into the run's artifact folder on failure, so "why did the selector miss" is answerable after the fact.
- **Strict boundaries, easy bisection.** One-way dependencies and per-package tests mean a bug is localizable by layer: wrong data shape → `nodes`, wrong sequencing → `engine`, wrong persistence → `server`, wrong display → `web`.

## 3. Node model

Only three node kinds are exposed to the user:

1. **Trigger** — *When…* (schedule, webhook, file appears, page changes, manual "Run now")
2. **Action** — *Do…* (open a website and grab X, call an API, move a file, run a script, send a notification, ask AI to summarize/decide)
3. **Rule** — *If/Filter/Repeat…* (plain-English conditions: "if price is below 500")

Each node is a TypeScript module with a manifest: name, plain-English description, inputs/outputs described as human sentences (not schemas), a `run()` function, and optional `setupGuide` steps. Because manifests are simple, the agent can generate a new node file from a conversation, hot-load it, and it appears in the palette immediately.

Data between nodes is plain JSON internally, but the UI always renders it as tables/cards, and field mapping is click-to-pick (click the column you want, not `{{ $json.body.items[0].price }}`). An expression language exists behind an "advanced" toggle.

## 4. Nimbus, the AI agent

Built on the Claude Agent SDK authenticating through the user's existing Claude subscription (same auth as Claude Code — no API key, no per-token billing). Appears as a chat panel beside the canvas. Capabilities:

- **Plan:** turn "check Cebu Pacific prices every morning and email me under ₱3,000" into a proposed node chain, previewed before touching the canvas.
- **Build:** create/connect/configure nodes, test-run each step, and show the sample data.
- **Create node types:** when no node fits, write a new node module, test it, install it.
- **Guide API setup:** launch the step-by-step wizard (section 5) when a step needs a key.
- **Fix:** on a failed run, read the error + run data and propose the repair in plain English.

**Hybrid model routing:** building/planning/fixing always uses Claude. At-runtime AI steps (summarize, classify, extract) have a per-node model picker defaulting to *Auto*: use local Ollama if installed and the task is simple; use Claude otherwise. Zero-credit runs when possible.

## 5. Guided API setup wizard

Credential setup becomes a wizard:

1. The user (or agent) names the service — "I want Gmail" — or pastes any docs URL or curl command.
2. AutoNimbus shows numbered, screenshot-style steps for that service: where to click to create the key, what to copy. Guides for known services ship built-in; for unknown services, Nimbus reads the docs URL and writes the guide on the spot.
3. The user pastes the key into one field; it is encrypted into the local vault.
4. The wizard immediately fires a test call and shows the live data: "It works, here's what your data looks like."

The HTTP/API node also imports curl commands directly (kept from n8n).

## 6. Local computer & browser access

- **Browser:** a *Read a website* node family backed by Playwright — open URL, wait, extract (the agent writes selectors by inspecting the DOM), fill forms, click, screenshot. Runs headful on request so the user can watch. No scraping API, no credits.
- **Files & shell:** watch folder, read/write/move files, run shell command — each gated by a permission prompt on first use per workflow ("This automation wants to move files in Downloads — allow?"), remembered afterward. Scoped by folder allowlist.

## 7. Triggers, schedules, notifications

- Schedules written in plain English ("every weekday at 8am"), parsed to cron internally; the UI shows the next 3 run times.
- Incoming webhooks get a copyable local URL (optional tunnel is a later feature).
- Outbound notifications in v1: macOS desktop notification, email (SMTP/Gmail via wizard), and Telegram.

## 8. Execution engine & storage

Sequential-with-branches executor: runs node by node, streams status to the canvas live over WebSocket, stores every run's input/output snapshots in PostgreSQL (`jsonb`) so any past run's data can be replayed while editing. Single-user, no queue mode. Each node run is time-limited; errors are contained per node.

## 9. Error handling

Every failure produces three things: *what happened* in one human sentence ("Gmail said your key doesn't have permission to send"), *the likely fix* ("Re-run the setup wizard and tick the 'send email' scope"), and a **"Let Nimbus fix it"** button. Raw stack traces live behind a details toggle. Failed scheduled runs notify the user instead of failing silently.

## 10. Testing strategy

- Engine and node runtime: unit tests (Vitest), TDD.
- Each built-in node: contract tests against mocked services; Playwright nodes tested against local fixture pages.
- Agent behaviors: golden-path integration tests ("given this request, produces a valid workflow graph").
- End-to-end: a scripted build → run → fix smoke test through the real UI.

## 11. UI/UX: Figma-grade canvas experience

The editor should feel like Figma, not an admin dashboard:

- **Infinite canvas** with smooth trackpad pan/zoom (pinch to zoom, two-finger pan), zoom-to-fit, zoom-to-selection, optional minimap. Target 60fps interactions.
- **Layout mirrors Figma:** left sidebar with two tabs — **Automations** (like pages/layers) and **Node palette** (like assets); a contextual **right-side inspector** for the selected node's settings (no modal dialogs); a **floating bottom-center toolbar** (select, add node, hand/pan, run).
- **Direct manipulation:** drag from a node's edge to draw a connection with smart snapping, alignment guides, marquee multi-select, copy/paste/duplicate, full undo/redo (⌘Z) across canvas and settings.
- **Keyboard-first:** ⌘K command palette ("add gmail node", "run automation", "ask Nimbus"); Figma-style shortcuts (V select, H hand, +/- zoom).
- **Visual language:** rounded node cards with icon + plain-English title + one-line status, subtle shadows, quiet grid dots, green/red node glow during live runs, animated dots along connections while data flows.
- **Nimbus chat** docks as a collapsible right panel and can be summoned inline: press space on empty canvas and type what you want — Nimbus drafts nodes in place.

Implementation: React Flow with a custom theme, custom edges/handles, and interaction polish as an explicit workstream with its own tasks in the implementation plan.

## 12. Out of scope for v1

Multi-user/auth, cloud sync, node marketplace, mobile, queue/scale mode, Windows/Linux polish (project structure must not block adding these later).
