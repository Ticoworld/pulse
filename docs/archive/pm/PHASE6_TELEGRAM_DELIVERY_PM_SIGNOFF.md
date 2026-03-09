# Phase 6 Telegram Delivery Hardening Signoff

Date: 2026-03-08

## Scope verdict

Phase 6 requested scope is implemented:

- one centralized Telegram send helper now handles owner alert sends
- alert message construction is extracted into pure formatter functions
- execution-order branches no longer use unsafe Markdown interpolation
- `EXIT CONFIRMED` now sends plain text and cannot trigger Markdown parse errors
- HIGH_INTEREST and Bags context remain present and concise
- formatter smoke script added for local reviewability
- Phase 6 doc added with strategy and runbook

## Files changed

- `C:\Users\timot\Desktop\2026\SERVER\pulse\apps\tg-bot\src\alertSender.ts`
- `C:\Users\timot\Desktop\2026\SERVER\pulse\apps\tg-bot\src\formatters.ts`
- `C:\Users\timot\Desktop\2026\SERVER\pulse\apps\tg-bot\src\index.ts`
- `C:\Users\timot\Desktop\2026\SERVER\pulse\scripts\tg-format-smoke.ts`
- `C:\Users\timot\Desktop\2026\SERVER\pulse\TELEGRAM_DELIVERY_HARDENING_PHASE6.md`

## Key implementation notes

### 1. Centralized send helper

`apps/tg-bot/src/alertSender.ts`

- `createOwnerAlertSender(...)` is now the single owner-alert send path
- supports explicit `format: "plain" | "markdown"`
- centralizes Telegram send options
- logs concise, redacted failures via existing-style redaction helpers

### 2. Extracted formatter module

`apps/tg-bot/src/formatters.ts`

Pure formatters now cover:

- HIGH_INTEREST_TOKEN
- BAGS_ENRICHMENT_RESOLVED
- BUY SUBMITTED / CONFIRMED / FAILED
- EXIT SUBMITTED / CONFIRMED / FAILED

Plus existing signal branches (`ALPHA_WALLET_BUY`, `NEW_MINT_SEEN`, `LIQUIDITY_LIVE`, fallback).

### 3. Updated bot wiring

`apps/tg-bot/src/index.ts`

- all signal alerts go through formatter + centralized sender
- all execution-order alerts go through formatter + centralized sender
- notification rows are marked sent only after successful send
- `polling_error` logs are redacted and concise

### 4. Execution-order parse safety

Execution-order notifications are plain text:

- BUY SUBMITTED / CONFIRMED / FAILED
- EXIT SUBMITTED / CONFIRMED / FAILED

This removes parse-entity failures caused by unescaped Markdown in dynamic fields.

## Commands run

1. Typecheck:

```bash
npm run typecheck
```

2. Formatter smoke run:

```bash
npx ts-node -r tsconfig-paths/register --project tsconfig.json scripts/tg-format-smoke.ts
```

3. Bot run (manual runtime):

```bash
npm run dev:bot
```

## Verification evidence

### Typecheck

`npm run typecheck` passed across all workspaces.

### Smoke output

Smoke script printed major alert types including unsafe characters in reasons/names/signatures, all formatted as plain text and printable without Markdown parsing.

### Runtime evidence (EXIT CONFIRMED path)

Confirmed exit row notification timestamp moved during bot run:

- exit id: `a80103a5-b4ca-46e8-8753-2c7dcac2b6b4`
- status: `confirmed`
- `confirmed_notified_at`: `2026-03-08T18:33:30.437Z`

This indicates the EXIT CONFIRMED notification branch executed and marked notified under the hardened path.

## Caveats

- This phase hardens delivery formatting and send-path structure only.
- It does not change signal generation, scoring, enrichment behavior, or trading logic.
