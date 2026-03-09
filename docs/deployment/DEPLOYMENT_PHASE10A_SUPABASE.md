# Phase 10A: Supabase cutover readiness

**Scope:** Database migration and Supabase connectivity. No bot hosting, no landing page, no premium gating.

---

## Required env vars

For Supabase-backed runs:

| Variable | Required | Notes |
|----------|----------|--------|
| `DATABASE_URL` | Yes | Supabase pooler connection string (Postgres URI). From Project Settings → Database → Connection string (URI). Replace `[YOUR-PASSWORD]` with your DB password. |
| `SUPABASE_URL` | Yes | Project URL, e.g. `https://<project-ref>.supabase.co`. From Project Settings → General. |
| `SUPABASE_ANON_KEY` | Yes | Anon/public key. From Project Settings → API. |
| `SUPABASE_SERVICE_ROLE_KEY` | No | Service role key if you need server-side bypass of RLS. Optional for current app (app uses direct Postgres via `DATABASE_URL`). |

All other existing vars (Telegram, Helius, Bags, Engine, Executor) unchanged.

---

## How to run migration apply

From repo root, with `DATABASE_URL` set (e.g. in `.env`):

```bash
npx ts-node -r dotenv/config -r tsconfig-paths/register --project tsconfig.json scripts/apply-db-migrations.ts
```

- Reads SQL from `packages/db/src/migrations/` in **sorted filename order**.
- Tracks applied files in `schema_migrations`; skips already-applied.
- Fails on first migration error; no partial state assumed.
- **First run:** ensures `schema_migrations` exists, then runs 001 → 017 (or 018 if added) in order.

---

## How to run Supabase smoke

After migrations are applied:

```bash
npx ts-node -r dotenv/config -r tsconfig-paths/register --project tsconfig.json scripts/supabase-smoke.ts
```

- Verifies `DATABASE_URL` is set and connection works.
- Checks that these tables exist: `signals`, `launch_candidates`, `bags_token_enrichments`, `bags_token_creators`, `telegram_users`, `telegram_command_events`, `telegram_user_mint_follows`, `telegram_signal_deliveries`.
- Runs one safe write/read/delete using a **session-scoped temp table** (no app data touched).
- Exit 0 = success; non-zero = failure (connection, missing table, or probe error).

---

## Local-only assumptions (audit results)

| File / location | Hit | Verdict |
|-----------------|-----|--------|
| `.env.example` | `DATABASE_URL=postgresql://...localhost:5432...`, `REDIS_URL=redis://localhost:6379` | **Harmless.** Example only; override with real `DATABASE_URL` (Supabase pooler) and optional Redis. |
| `README.md` | `docker compose ...`, `curl http://localhost:3000/health` | **Harmless.** Docs for local dev; health URL is app port, not DB. |
| `ARCHITECTURE_AUDIT.md` | Mentions Docker, Redis | **Harmless.** Documentation. |
| Application code (`packages/db`, `apps/*`, `services/*`, `scripts/*`) | **None.** All use `process.env.DATABASE_URL`; no hardcoded host/port. | **No change needed.** |

**Summary:** No code assumes local Postgres. Only docs and `.env.example` mention localhost; cutover = set `DATABASE_URL` (and optional Supabase vars) in `.env`.

---

## What will likely break on first cutover

1. **Connection string format:** Supabase pooler uses port **6543** (transaction mode) or **5432** (session mode). Use the URI from the dashboard; ensure SSL if required (e.g. `?sslmode=require`).
2. **Existing data:** Local Docker data is **not** migrated by the migration script. The script only applies schema (DDL). Seed or backfill is out of scope for 10A; treat Supabase as a clean schema.
3. **Extensions:** If any migration or app code relies on Postgres extensions not enabled in Supabase, they will fail. Current migrations use only standard SQL and `gen_random_uuid()` (built-in); no custom extensions required.
4. **RLS (Row Level Security):** Supabase can enable RLS on tables. Current app uses a single `DATABASE_URL` (pooler); if that role is not a service role, RLS policies may block reads/writes. Use the connection string that has sufficient privileges (e.g. postgres user or a role with full access to the schema).

---

## Local data intentionally not migrated

- **Decision:** Schema + clean cutover. No script copies data from local Docker to Supabase.
- **Reason:** Fastest honest path; avoids dirty local dev data and schema drift.
- **If you need data:** Export from local (e.g. `pg_dump` data only) and load into Supabase manually; not part of 10A.

---

## Commands to test (paste-back)

1. **Apply migrations**  
   ```bash
   npm run db:migrate
   ```
   Or: `npx ts-node -r dotenv/config -r tsconfig-paths/register --project tsconfig.json scripts/apply-db-migrations.ts`

2. **Run Supabase smoke**  
   ```bash
   npm run supabase:smoke
   ```
   Or: `npx ts-node -r dotenv/config -r tsconfig-paths/register --project tsconfig.json scripts/supabase-smoke.ts`

---

## Migration apply output (example)

```
[apply] 001_raw_events.sql
[done]  001_raw_events.sql
...
[apply] 017_follow_alerts_phase9.sql
[done]  017_follow_alerts_phase9.sql
Migrations complete.
```

---

## Supabase smoke output (example)

```
[supabase-smoke] connected
[supabase-smoke] table ok: signals
[supabase-smoke] table ok: launch_candidates
[supabase-smoke] table ok: bags_token_enrichments
[supabase-smoke] table ok: bags_token_creators
[supabase-smoke] table ok: telegram_users
[supabase-smoke] table ok: telegram_command_events
[supabase-smoke] table ok: telegram_user_mint_follows
[supabase-smoke] table ok: telegram_signal_deliveries
[supabase-smoke] write/read/delete probe ok
[supabase-smoke] success
```
