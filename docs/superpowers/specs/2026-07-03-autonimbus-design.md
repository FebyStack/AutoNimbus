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

```
autonimbus/
├── packages/
│   ├── engine/     # workflow executor, node runtime, scheduler
│   ├── nodes/      # built-in node library + user/agent-created nodes
│   ├── agent/      # Nimbus: Claude Agent SDK + Ollama routing
│   ├── server/     # Fastify API + WebSocket (live run updates), SQLite
│   └── web/        # React + React Flow canvas, wizard UI, chat panel
└── data/           # SQLite db, encrypted credentials, run logs
```

One Node.js process runs server + engine + scheduler. Playwright drives a local headless (or headful, watchable) Chrome. Everything persists in SQLite under `data/`.

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

Sequential-with-branches executor: runs node by node, streams status to the canvas live over WebSocket, stores every run's input/output snapshots in SQLite so any past run's data can be replayed while editing. Single-user, no queue mode. Each node run is time-limited; errors are contained per node.

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
