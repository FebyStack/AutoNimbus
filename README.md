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
