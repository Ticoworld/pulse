# Telegram Delivery Hardening Phase 6

## What was failing before

Execution-order notifications were using inline Markdown with raw interpolated fields.
This caused runtime Telegram parse failures like:

- `400 Bad Request: can't parse entities`

The known failure path was `EXIT CONFIRMED`, but the same risk existed in other execution-order branches.

## Formatter strategy

Phase 6 introduces:

- a centralized owner-alert send helper (`apps/tg-bot/src/alertSender.ts`)
- a dedicated formatter module (`apps/tg-bot/src/formatters.ts`)

All signal and execution alert branches now build messages via pure formatter functions, then send through one helper.

## Markdown vs plain text decisions

Execution-order alerts are now plain text:

- BUY SUBMITTED / CONFIRMED / FAILED
- EXIT SUBMITTED / CONFIRMED / FAILED

Signal alerts are also plain text in this phase for safety and consistency:

- HIGH_INTEREST_TOKEN
- BAGS_ENRICHMENT_RESOLVED
- ALPHA_WALLET_BUY
- NEW_MINT_SEEN
- LIQUIDITY_LIVE

Reason:

- these paths contain dynamic fields (reason, names, labels, signatures) that can break Markdown entity parsing
- plain text removes parser risk entirely while preserving alert content

## Execution-order fix

`EXIT CONFIRMED` no longer sends Markdown content.
It is formatted as plain text and sent through the shared helper, so special characters in reason/signature cannot trigger parse-entities errors.

## HIGH_INTEREST and Bags rendering

Phase 5 Bags context is preserved in HIGH_INTEREST output:

- Bags bonus
- Bags reasons
- creator display/provider
- fees

Rendering remains concise and does not use over-claiming language.

## Smoke script

Script:

- `scripts/tg-format-smoke.ts`

Purpose:

- prints sample message outputs for major alert types
- includes special characters that previously broke Markdown
- does not send real Telegram messages

Run:

```bash
npx ts-node -r tsconfig-paths/register --project tsconfig.json scripts/tg-format-smoke.ts
```
