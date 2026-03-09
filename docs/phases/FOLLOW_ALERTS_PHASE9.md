# Follow Alerts Phase 9

## What this phase does

Phase 9 adds the first retention loop for public users:

- users can follow mints
- existing `HIGH_INTEREST_TOKEN` signals trigger additional personalized alerts
- follower deliveries are deduped in DB per user + signal + delivery kind

No new signal types are introduced.

## What this phase does not do

- no premium gating
- no subscriptions or billing
- no token gating
- no scoring rewrite
- no Bags enrichment changes
- no web UI
- no new infrastructure layer

## Follow tables

Migration: `packages/db/src/migrations/017_follow_alerts_phase9.sql`

- `telegram_user_mint_follows`
  - `(telegram_user_id, mint)` primary key
  - stores which users follow which mints

- `telegram_signal_deliveries`
  - tracks per-user signal delivery attempts
  - includes delivery kind, success flag, and optional error message
  - unique index on `(telegram_user_id, signal_id, delivery_kind)` for dedupe

## Delivery dedupe rule

Delivery kind used in this phase:

- `followed_high_interest`

For each `HIGH_INTEREST_TOKEN` signal and each follower of that mint:

1. check `hasTelegramSignalDelivery(user, signal, "followed_high_interest")`
2. if already present, skip
3. otherwise send alert and record delivery row
4. DB unique index prevents duplicate inserts for same user + signal + kind

## Cooldown policy for follow commands

Cooldown (30s) remains applied only to heavy public read commands:

- `/top_candidates`
- `/mint`

Follow management commands are exempt in this phase:

- `/follow`
- `/unfollow`
- `/following`

This keeps retention interactions responsive while preserving protection on expensive read commands.

## Command-path constraints

`/follow`, `/unfollow`, and `/following` are DB-backed only.
No direct Bags or Helius API calls are made in command handlers.

## Why this is retention, not monetization

This phase increases return usage by giving users personalized signal follow-through after onboarding:

- first use: user follows a mint
- return trigger: bot delivers a followed-mint `HIGH_INTEREST` alert
- repeat behavior: users come back to inspect and manage follows

This is a traction/retention step before any premium gating.
