# Phase 4 Bags Signal Signoff (Brutally Honest)

Date: 2026-03-08

## Final status

Phase 4 scope requested in the prompt is implemented and verified:

- Shared pipeline reused (no side-channel notifier).
- New signal type added and emitted from shared enrichment runner.
- DB-backed one-time dedupe per mint added.
- Telegram render branch added for the new signal.
- Docs file added.
- Typecheck passes.
- Real emitted signal row captured in DB.
- Bot log confirms signal was sent.

## Important caveat (not Phase 4 scope, but real)

There is a separate existing Telegram formatting failure in the execution-order notification path:

- Error: `400 Bad Request: can't parse entities`
- Triggered while sending `EXIT CONFIRMED`.
- This is not from the new Bags signal branch, but it is still a real runtime issue in the bot.

## Files changed for Phase 4

- `C:\Users\timot\Desktop\2026\SERVER\pulse\packages\bags-enricher\src\runner.ts`
- `C:\Users\timot\Desktop\2026\SERVER\pulse\packages\db\src\migrations\015_bags_enrichment_resolved_signal.sql`
- `C:\Users\timot\Desktop\2026\SERVER\pulse\apps\tg-bot\src\index.ts`
- `C:\Users\timot\Desktop\2026\SERVER\pulse\BAGS_SIGNAL_PHASE4.md`

## Where key logic lives

- Signal type literal:
  - `packages/bags-enricher/src/runner.ts`
  - `const BAGS_ENRICHMENT_RESOLVED_SIGNAL = "BAGS_ENRICHMENT_RESOLVED"`
- Emission gate + insert location:
  - `packages/bags-enricher/src/runner.ts`
  - `shouldEmitBagsResolved` block and `insertSignal(...)`
- Telegram render branch:
  - `apps/tg-bot/src/index.ts`
  - `else if (signal.type === "BAGS_ENRICHMENT_RESOLVED")`
- DB dedupe rule:
  - `packages/db/src/migrations/015_bags_enrichment_resolved_signal.sql`
  - partial unique index on `signals(token_mint)` for type `BAGS_ENRICHMENT_RESOLVED`

## Evidence captured

### 1. Compile check

Command:

```bash
npm run typecheck
```

Result: all workspaces pass `tsc --noEmit`.

### 2. Real enrichment run emitted the signal

Command:

```bash
npm run bags:enrich -- -- --mint CyXBDcVQuHyEDbG661Jf3iHqxyd9wNHhE2SiQdNrBAGS --force
```

Observed output included:

- `[bags-enrich] emitted signal type=BAGS_ENRICHMENT_RESOLVED mint=CyXBDcVQuHyEDbG661Jf3iHqxyd9wNHhE2SiQdNrBAGS`
- `[bags-enrich] done mint=... status=resolved`

### 3. Signal row and dedupe proof

DB proof snapshot:

- `INDEX_EXISTS=true`
- `SIGNAL_COUNT=1`
- `SIGNAL_ROW.id=9f85d0e6-ec4a-44aa-9142-988988cf7bde`
- `SIGNAL_ROW.type=BAGS_ENRICHMENT_RESOLVED`
- `SIGNAL_ROW.token_mint=CyXBDcVQuHyEDbG661Jf3iHqxyd9wNHhE2SiQdNrBAGS`
- `SIGNAL_ROW.is_sent=true`

Enrichment row snapshot:

- `enrichment_status=resolved`
- `primary_creator_display_name=PublicFundApp`
- `primary_creator_provider=twitter`
- `fees_lamports=369655050567`

### 4. Telegram proof

Bot output included:

- `[tg-bot] sent alert for signal 9f85d0e6-ec4a-44aa-9142-988988cf7bde`

This confirms the new signal was consumed by existing unsent-signal polling and delivered.

## PM-facing summary

Phase 4 is functionally complete for its requested scope: one new Bags-native alert surface (`BAGS_ENRICHMENT_RESOLVED`) now emits once per mint from shared enrichment logic and renders in Telegram through the existing signal pipeline. DB dedupe is enforced with a partial unique index and runtime transition gating. Typecheck passes and runtime evidence shows one real emitted row and successful bot send. A separate pre-existing Telegram markdown issue exists in execution-order messages and should be tracked independently.
