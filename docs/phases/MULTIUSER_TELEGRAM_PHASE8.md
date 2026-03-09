# Multi-user Telegram Phase 8

## Scope

Phase 8 turns Telegram from owner-only ops tooling into a minimal public read-only product layer:

- Public commands: `/start`, `/help`, `/top_candidates`, `/mint <address>`
- Owner-only admin commands remain owner-only:
  - `/watchlist_add`
  - `/watchlist_remove`
  - `/watchlist_list`
- Public command paths are DB-backed only (no direct Bags/Helius fetches on request path)
- Usage is tracked in DB
- Per-user cooldown is enforced for public read commands

## Public vs owner-only commands

- Public:
  - `/start`
  - `/help`
  - `/top_candidates [limit]`
  - `/mint <address>`
- Owner-only:
  - `/watchlist_add <wallet> [label]`
  - `/watchlist_remove <wallet>`
  - `/watchlist_list`

Non-owner use of owner-only commands returns: `This command is owner-only.`

## Cooldown rule

- Default cooldown: **30 seconds per user**
- Applies to:
  - `/top_candidates`
  - `/mint`
- Exempt:
  - `/start`
  - `/help`
- Cooldown check is DB-backed using recent successful command events.
- Cooldown response:
  - `Too many requests. Try again in Xs.`

## Usage tracking schema

Migration: `packages/db/src/migrations/016_telegram_usage_tracking.sql`

Tables:

- `telegram_users`
  - `telegram_user_id` bigint primary key
  - profile columns (`username`, `first_name`, `last_name`)
  - command counters and timestamps (`first_seen_at`, `last_seen_at`, `last_command`, `command_count`)
  - owner flag (`is_owner`)
  - lifecycle timestamps (`created_at`, `updated_at`)

- `telegram_command_events`
  - `id` uuid primary key default `gen_random_uuid()`
  - `telegram_user_id` bigint fk to `telegram_users`
  - command metadata (`command`, `command_args`)
  - usage status (`used_at`, `success`, `error_message`)

Indexes are limited to practical reporting/rate-limit access patterns:

- `(used_at DESC)`
- `(telegram_user_id, used_at DESC)`
- `(command, used_at DESC)`

## Command-path behavior

- Every incoming command:
  - upserts `telegram_users`
  - records one row in `telegram_command_events` with honest success/failure
- `/top_candidates`:
  - uses existing Phase 7 digest query (`candidate_signals` + optional resolved Bags enrichment)
  - still filters by `HIGH_INTEREST_THRESHOLD`
- `/mint`:
  - DB-backed summary only
  - uses `candidate_signals`, resolved `bags_token_enrichments`, and `HIGH_INTEREST_TOKEN` existence from `signals`
  - returns plain compact summary; if not found, says so directly

## DAU proof in this phase

This phase defines DAU/usage proof as DB-observable metrics from command events:

- unique users in last 24h
- total command events in last 24h
- top commands in last 24h

Helper script:

```bash
npx ts-node -r dotenv/config -r tsconfig-paths/register --project tsconfig.json scripts/telegram-usage-proof.ts
```

## What the bot still is not

- No premium or subscription gating
- No token-gated features
- No web app/UI
- No live trading changes
- No new signal types
- No scoring rewrite
- No auto-push digest scheduling
- No Redis/queue infrastructure additions

## Why public command paths are DB-backed only

- Predictable latency and reliability under user load
- No request-path exposure to Bags API limits or external fetch failures
- Keeps read endpoints honest to persisted system state
- Prevents accidental drift between on-demand command output and stored signals/enrichment state
