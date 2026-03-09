# Phase 9 PM Paste-Back

## Scope delivered

- Added public commands: `/follow <mint>`, `/unfollow <mint>`, `/following`
- Added DB-backed follow storage and signal-delivery dedupe
- Added personalized follower alerts for existing `HIGH_INTEREST_TOKEN` signals
- Kept owner alert flow intact
- No new signal types
- No command-path Bags/Helius fetches

## Schema migration

- `packages/db/src/migrations/017_follow_alerts_phase9.sql`
  - `telegram_user_mint_follows`
  - `telegram_signal_deliveries`
  - unique dedupe index on `(telegram_user_id, signal_id, delivery_kind)`

## DB helpers

- `packages/db/src/telegramFollows.ts`
  - `followMintForTelegramUser`
  - `unfollowMintForTelegramUser`
  - `listFollowedMintsForTelegramUser`
  - `listFollowersForMint`
  - `hasTelegramSignalDelivery`
  - `recordTelegramSignalDelivery`

## Bot changes

- `apps/tg-bot/src/index.ts`
  - wired `/follow`, `/unfollow`, `/following`
  - reused Phase 8 tracked-command path (user upsert + command event logging)
  - added follower fanout on `HIGH_INTEREST_TOKEN`
  - added DB-backed delivery dedupe checks + writes

## Formatter

- `apps/tg-bot/src/formatters.ts`
  - `formatFollowedHighInterestAlert`

## Phase doc

- `FOLLOW_ALERTS_PHASE9.md`

## Proof commands run

```bash
npm run build --workspace=packages/db
npm run typecheck
$env:HTTP_PROXY=''; $env:HTTPS_PROXY=''; $env:ALL_PROXY=''; npx ts-node -r dotenv/config -r tsconfig-paths/register --project tsconfig.json scripts/phase9-follow-alert-proof.ts
$env:HTTP_PROXY=''; $env:HTTPS_PROXY=''; $env:ALL_PROXY=''; npx ts-node -r dotenv/config -r tsconfig-paths/register --project tsconfig.json scripts/phase9-follow-alert-proof.ts
```

## Proof output (key lines)

First run:

- `[proof:/follow] user=1331814679 mint=CyXBDcVQuHyEDbG661Jf3iHqxyd9wNHhE2SiQdNrBAGS created=false`
- `[proof:/following] count=1 mints=CyXBDcVQuHyEDbG661Jf3iHqxyd9wNHhE2SiQdNrBAGS`
- `[proof:delivery] signal=61966f2d-b32f-48f1-ad4e-c8dfd01eda6e inserted=true sent=true error=none`
- `[proof:dedupe] duplicate insert allowed=false (expected false)`
- `[sql:follows] rows=1 data=[{"telegram_user_id":"1331814679","mint":"CyXBDcVQuHyEDbG661Jf3iHqxyd9wNHhE2SiQdNrBAGS","created_at":"2026-03-08T20:58:07.541Z"}]`
- `[sql:deliveries] rows=1 data=[{"telegram_user_id":"1331814679","signal_id":"61966f2d-b32f-48f1-ad4e-c8dfd01eda6e","delivery_kind":"followed_high_interest","delivered_at":"2026-03-08T21:26:12.546Z","success":true,"error_message":null}]`

Second run:

- `[proof:/follow] ... created=false`
- `[proof:delivery] ... already delivered, skipping send`
- `[proof:dedupe] duplicate insert allowed=false (expected false)`
- SQL rows unchanged at 1 follow row and 1 delivery row for that signal/kind
