# Pulse

Solana trading intelligence platform — TypeScript monorepo.

## Structure

```
apps/
  api/        → Express REST API
  tg-bot/     → Telegram bot

packages/
  common/     → Shared config and types
  db/         → Database client (Prisma / future)

services/
  stream/     → Solana data streaming (future)
  engine/     → Signal engine (future)
  executor/   → Trade execution (future)

infra/
  docker-compose.yml  → Postgres + Redis
```

Phase and deployment notes live in `docs/` (including `docs/phases/` and `docs/deployment/`).

## Setup

```bash
# 1. Copy environment variables
cp .env.example .env

# 2. Install all dependencies
npm install

# 3. Start infrastructure (requires Docker)
docker compose -f infra/docker-compose.yml up -d

# 4. Run the API (port 3000 by default)
npm run dev:api

# 5. Run the Telegram bot
npm run dev:bot
```

## Health check

```bash
curl http://localhost:3000/health
# → { "ok": true, "service": "api" }
```

## Bags (Phase 1 — read-only foundation)

Read-only Bags API client lives in `packages/bags` and uses the official `@bagsfm/bags-sdk`. No engine, Telegram, or schema changes in this phase.

**Env (add to `.env`):**

- `BAGS_API_KEY` — from [dev.bags.fm](https://dev.bags.fm/)
- `SOLANA_RPC_URL` — e.g. `https://api.mainnet-beta.solana.com` or your RPC

**Smoke script:**

```bash
npm run bags:smoke
# Or with a mint: npm run bags:smoke -- CyXBDcVQuHyEDbG661Jf3iHqxyd9wNHhE2SiQdNrBAGS
# Or set BAGS_SMOKE_MINT in .env
```

**Success:** Script prints normalized token creators and lifetime fees for the mint and exits 0. No DB writes.

**Failure:** On missing/invalid API key (401), permissions (403), or rate limit (429), the script prints the error code and message and exits 1. Invalid mint or RPC issues also exit 1.

**Limitations (Phase 1):** In-process rate cap only (soft 800/hour). No ping/health endpoint. Raw endpoint paths and response schemas are not used — SDK is the source. See `docs/BAGS_DOCS_TRUTH.md` for what is confirmed vs unknown.
