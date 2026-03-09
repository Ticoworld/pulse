# Pulse

Bags Alpha Intelligence — Telegram-first launch and alpha signals for the Bags ecosystem. TypeScript monorepo.

**What it is:** A bot that surfaces high-signal Bags launch candidates and dev-wallet context via Telegram. Public commands: `/top_candidates`, `/mint`, `/follow`. DB-backed signals and Bags API enrichment; no live trading.

**What it is not:** Production-hardened infra, a web dashboard, or a generic Solana trading bot. Execution is stubbed; observability and migration tooling are minimal.

---

## Repo structure

```
apps/
  api/        → Express API (health only)
  tg-bot/     → Telegram bot (polling; commands + follow alerts)
  landing/    → Single-page marketing site (Vite + React + Tailwind)

packages/
  common/     → Shared config and types
  db/         → Postgres client (raw pg), schema, SQL migrations
  bags/       → Bags API client (read-only, rate-limited)
  bags-enricher/ → Enrichment runner (launch candidates → Bags)

services/
  stream/     → Helius WebSocket + HTTP → raw_events
  engine/     → Polling engine (candidates, signals, scoring)
  executor/   → Execution state machine (Solana tx stubbed)
  bags-enricher/ → Long-running enrichment service

infra/
  docker-compose.yml  → Local Postgres + Redis (Redis unused in code)

docs/
  PHASE0_MASTER_CONTEXT.md  → Product and architecture context
  phases/     → Phase specs (Bags, Telegram, follow alerts, landing)
  deployment/ → Supabase, hosting (Vercel, Railway)
  archive/     → PM signoffs, audits, review artifacts
```

---

## Local development

```bash
# 1. Env
cp .env.example .env
# Set at least: DATABASE_URL, TELEGRAM_BOT_TOKEN, TELEGRAM_OWNER_CHAT_ID, BAGS_API_KEY, HELIUS_API_KEY, SUPABASE_URL, SUPABASE_ANON_KEY

# 2. Install
npm install

# 3. Database (Supabase or local Postgres)
npm run db:migrate
npm run supabase:smoke   # optional; verifies DB and tables

# 4. Run what you need
npm run dev:api          # API on port 3000
npm run dev:bot          # Telegram bot (polling)
npm run dev:landing      # Landing page (Vite, default port 5173)
```

**Health check:** `curl http://localhost:3000/health` → `{ "ok": true, "service": "api" }`

---

## Landing page

- **Dev:** `npm run dev:landing` (Vite dev server, port 5173).
- **Build:** `npm run build --workspace=@pulse/landing`
- **Output:** `apps/landing/dist` (static assets + index.html)
- **Links (Telegram, GitHub):** Edit `apps/landing/src/config.ts` before deploy. All CTAs and footer use that file.

Intended for deployment on **Vercel**. See `docs/deployment/DEPLOYMENT_PHASE10C_HOSTING.md`.

---

## Telegram bot

- **Dev:** `npm run dev:bot` (ts-node, loads `.env` via dotenv)
- **Build:** `npm run build --workspace=@pulse/tg-bot` → outputs to `apps/tg-bot/dist`
- **Start (hosted):** `npm run start --workspace=@pulse/tg-bot` (from repo root) or from `apps/tg-bot`: `npm run build && npm start`

Uses **polling**; must run as a persistent process. Intended for deployment on **Railway**. Required env: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_OWNER_CHAT_ID`, `DATABASE_URL`. See `docs/deployment/DEPLOYMENT_PHASE10C_HOSTING.md` and `.env.example`.

---

## Supabase (DB) and migrations

- **Apply migrations:** `npm run db:migrate`  
  Reads SQL from `packages/db/src/migrations/` in sorted order; tracks applied in `schema_migrations`.
- **Smoke test:** `npm run supabase:smoke`  
  Checks connection and required tables; runs a safe write/read/delete probe.

See `docs/deployment/DEPLOYMENT_PHASE10A_SUPABASE.md` for env vars and first-cutover notes.

---

## Bags API (read-only)

- **Env:** `BAGS_API_KEY`, `SOLANA_RPC_URL` (see `.env.example`)
- **Smoke:** `npm run bags:smoke`  
  Prints token creators and lifetime fees for a mint; exits 0 on success, 1 on auth/rate-limit/error.

See `docs/BAGS_DOCS_TRUTH.md` for API behaviour and limits.

---

## Deployment (summary)

| Component   | Intended host | Build / start and env documented in |
|------------|----------------|----------------------------------------|
| Landing    | Vercel         | `docs/deployment/DEPLOYMENT_PHASE10C_HOSTING.md` |
| Telegram bot | Railway      | Same doc + `.env.example` |

No fake production or traction claims. The bot and landing are suitable for hackathon and demo use; observability, auth, and hardening are not in scope for this phase.
