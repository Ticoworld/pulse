# Bags Signal Phase 4

## What this signal means

`BAGS_ENRICHMENT_RESOLVED` means a mint already tracked in `launch_candidates` moved into a meaningful resolved Bags enrichment state and now has actionable Bags context attached.

## What this signal does not mean

- It is not a buy or trade signal.
- It is not a wallet-score or candidate-score rewrite.
- It is not a full Bags scoring model.
- It does not imply anything about claim flows, partner keys, or execution.

## Emission rule

The shared enrichment runner emits `BAGS_ENRICHMENT_RESOLVED` only when all are true:

1. Mint is in `launch_candidates`.
2. Current enrichment status is `resolved`.
3. Previous enrichment status for that mint was not `resolved`.
4. Resolved row has meaningful context:
   - `primary_creator_wallet` or `primary_creator_display_name`, or
   - `fees_lamports` is non-null.
5. Candidate is inside the same `sinceHours` freshness boundary already used by enrichment selection.

No signal is emitted for partial rows, error rows, or resolved rows without meaningful creator/fees context.

## Dedupe rule

- DB-backed dedupe uses a partial unique index on `signals(token_mint)` where `type = 'BAGS_ENRICHMENT_RESOLVED'`.
- Runner also uses a resolved transition gate (`previous != resolved` and `current = resolved`) so normal refresh cycles do not re-emit.
- Result: one signal per mint for Phase 4.

## Telegram rendering summary

Telegram reuses the existing `listUnsentSignals -> send -> markSignalSent` pipeline.
For `BAGS_ENRICHMENT_RESOLVED`, the bot sends a concise "Bags-resolved context" message containing:

- Mint
- Enrichment status
- Creator identity (if present)
- Fees in lamports (if present)

No buy language and no command changes were added.

## Why this is not full Bags scoring

Phase 4 only creates the first visible Bags-native alert surface from resolved enrichment.
It intentionally does not change the broad candidate scoring model, wallet scoring model, or execution behavior.
