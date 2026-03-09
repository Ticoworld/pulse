# Phase 5 Bags Scoring Signoff

Date: 2026-03-08

## Scope verdict

Phase 5 requested scope is implemented:

- existing candidate scoring path now applies a narrow Bags overlay
- Bags bonus is explicit, explainable, and capped
- HIGH_INTEREST emission payload now includes Bags scoring context
- Telegram HIGH_INTEREST rendering now shows concise Bags context
- no second scoring system and no extra signal type were added

## Files changed

- `C:\Users\timot\Desktop\2026\SERVER\pulse\services\engine\src\candidateEngine.ts`
- `C:\Users\timot\Desktop\2026\SERVER\pulse\apps\tg-bot\src\index.ts`
- `C:\Users\timot\Desktop\2026\SERVER\pulse\BAGS_SCORING_PHASE5.md`

## Commands run

1. Compile check:

```bash
npm run typecheck
```

Result: all workspaces pass.

2. Runtime proof query:

```bash
node -e \"...query candidate_signals + HIGH_INTEREST payload + bags_token_enrichments for mint CyXBDcVQuHyEDbG661Jf3iHqxyd9wNHhE2SiQdNrBAGS...\"
```

Observed:

- `CANDIDATE_SIGNAL.score = 62`
- `metadata.base_score = 60`
- `metadata.bags_bonus = 2`
- `metadata.final_score = 62`
- `HIGH_INTEREST.payload.bags_bonus = 2`
- `HIGH_INTEREST.payload.bags_reasons` populated

## Scoring diff (clear)

Previous:

- score from liquidity/alpha/dev/wallet/actor only
- threshold check used that score directly

Now:

- compute `baseScore` using existing logic
- compute Bags components only when enrichment is resolved + meaningful
- cap Bags bonus with:
  - `min(20% of threshold, 2)`
  - threshold is `60`, so cap is `2`
- final score:
  - `finalScore = baseScore + bagsBonus`
- persist explanation fields:
  - `base_score`, `bags_bonus`, `bags_bonus_cap`, `bags_bonus_components`, `bags_reasons`, `final_score`

## HIGH_INTEREST payload change

Payload now includes:

- `base_score`
- `bags_bonus`
- `bags_bonus_cap`
- `bags_reasons`
- `primary_creator_display_name`
- `primary_creator_provider`
- `fees_lamports`

## Telegram HIGH_INTEREST render change

HIGH_INTEREST message now includes a Bags section:

- Bags bonus
- Bags reasons
- Creator + provider (if present)
- Fees in lamports (if present)

## Proof snippet (current DB state)

Candidate row (`candidate_signals`):

```json
{
  "mint": "CyXBDcVQuHyEDbG661Jf3iHqxyd9wNHhE2SiQdNrBAGS",
  "score": 62,
  "metadata": {
    "base_score": 60,
    "bags_bonus": 2,
    "final_score": 62,
    "bags_reasons": [
      "resolved_context",
      "creator_identity_present",
      "fees_nonzero",
      "bonus_capped"
    ]
  }
}
```

HIGH_INTEREST payload snippet:

```json
{
  "score": 62,
  "base_score": 60,
  "bags_bonus": 2,
  "bags_reasons": [
    "resolved_context",
    "creator_identity_present",
    "fees_nonzero",
    "bonus_capped"
  ],
  "primary_creator_display_name": "PublicFundApp",
  "primary_creator_provider": "twitter",
  "fees_lamports": 369655050567
}
```
