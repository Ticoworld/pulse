# Bags Scoring Phase 5

## Where the Bags bonus applies

The Bags bonus is applied only inside the existing candidate score path (`recomputeCandidate`) and therefore affects `HIGH_INTEREST_TOKEN` through the same existing flow.

The bonus is considered only when all are true:

- mint has a `bags_token_enrichments` row
- `enrichment_status = 'resolved'`
- resolved row has meaningful context:
  - `primary_creator_wallet` or `primary_creator_display_name`, or
  - `fees_lamports` is non-null

## Exact cap rule used

- Existing HIGH_INTEREST threshold is `60`
- Bags cap rule is:
  - `min(20% of threshold, 2)`
  - `min(12, 2) = 2`
- Effective max Bags bonus in this phase: `2`

## Why the cap is conservative

- It prevents Bags context from dominating core launch/alpha/dev signals.
- It limits score inflation and avoids accidental alert spam.
- It keeps Bags influence explicit and reviewable while preserving the existing scoring backbone.

## What Bags data can and cannot imply

Allowed observable signals:

- resolved Bags enrichment context exists
- creator identity exists
- fees are present and non-zero

Not allowed assumptions:

- provider identity (for example twitter) implies quality
- higher fees imply better trade
- creator identity implies safety

## HIGH_INTEREST rendering change

`HIGH_INTEREST_TOKEN` payload now includes:

- `base_score`
- `bags_bonus`
- `bags_bonus_cap`
- `bags_reasons`
- `primary_creator_display_name`
- `primary_creator_provider`
- `fees_lamports`

Telegram HIGH_INTEREST rendering now shows concise Bags context:

- Bags bonus
- Bags reasons
- Creator display/provider (if present)
- Fees in lamports (if present)
