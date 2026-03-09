# Bags docs truth file

Single source of what we treat as confirmed vs unknown for the Bags integration.  
**Raw endpoint paths and response schemas are not the source of truth for this phase** — we use the official TypeScript SDK.

---

## Confirmed from official docs

- **Auth:** API key must be sent in the `x-api-key` header. Docs show curl and fetch examples with this header.
- **Rate limit:** 1,000 requests per hour per user and per IP. Applies across all API keys (all keys share the same limit). Sliding hourly windows.
- **Rate-limit headers:** Response headers include `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`. 429 responses include JSON with `limit`, `remaining`, `resetTime`.
- **Error semantics:** 401 = missing or invalid API key; 403 = insufficient permissions; 429 = rate limit exceeded. Docs confirm these with example payloads.
- **Base URL:** Public API base is `https://public-api-v2.bags.fm` (from docs examples). SDK uses this internally; we do not call raw endpoints in this phase.

---

## Confirmed from SDK-oriented guides

- **Package:** `@bagsfm/bags-sdk` (this repo uses `^1.0.0`; docs may show older examples). TypeScript/Node setup guide: install `@bagsfm/bags-sdk dotenv @solana/web3.js bs58`.
- **Env:** `BAGS_API_KEY`, `SOLANA_RPC_URL`. Optional `PRIVATE_KEY` for guides that perform transactions; we do not use it in read-only phase.
- **SDK init:** `new BagsSDK(BAGS_API_KEY, connection, "processed")` where `connection = new Connection(SOLANA_RPC_URL)`.
- **Get Token Creators:** `sdk.state.getTokenCreators(new PublicKey(tokenMint))` returns an array of creator objects. Each has: `wallet`, `isCreator`, `providerUsername` or `username`, `provider`, `pfp`, `royaltyBps`. Primary creator is the one with `isCreator: true`.
- **Get Token Lifetime Fees:** `sdk.state.getTokenLifetimeFees(new PublicKey(tokenMint))` returns a number (lamports). Convert to SOL with `LAMPORTS_PER_SOL` from `@solana/web3.js`.
- **Docs list these guides:** Get Token Creators, Get Token Lifetime Fees, Trade Tokens, Launch a Token, Create Partner Key, Claim Partner Fees, Claim Fees from Token Positions, Get Token Claim Events. We implement only the two read-only getters in this phase.

---

## Confirmed error semantics

- 401: missing or invalid API key.
- 403: insufficient permissions.
- 429: rate limit exceeded; response body includes limit/remaining/resetTime.

Whether the SDK surfaces these as thrown errors with a `status` property or as a different shape is not fully confirmed; we map common message patterns and any `status` we find into our typed `BagsClientError`.

---

## Confirmed rate-limit semantics

- 1,000 requests/hour per user and per IP.
- Limit applies across all API keys.
- Sliding hourly windows.
- We do not rely on reading `X-RateLimit-*` from the SDK in this phase (SDK may not expose response headers). We use an in-process soft cap (e.g. 800/hour) to stay under the limit.

---

## What is still unknown / not yet implemented

- Exact shape of errors thrown by `@bagsfm/bags-sdk` (e.g. whether `status` or `response` is present). We infer from message and document in this file.
- Whether the SDK returns 429 body fields (`limit`, `remaining`, `resetTime`) in a structured way when rate-limited.
- Raw HTTP endpoint paths and request/response schemas for each workflow (we use SDK only in this phase).
- Whether a “ping” or health endpoint exists and is documented; we did not implement one unless a docs-backed path appears.
- Exact TypeScript types exported by the SDK for creators (we use a minimal `SdkCreator` interface based on docs and normalize to our own type).

---

## Error type distinction (do not collapse)

- **BAGS_LOCAL_SOFT_CAP:** Returned when the in-process rate guard refuses the call (soft cap reached). This is **not** a Bags API response. No HTTP status. Message states it is a local in-process safety stop, not a Bags 429. Use `isBagsLocalSoftCap()` to detect.
- **BAGS_RATE_LIMIT:** Only when the Bags API actually returns 429 (rate limit exceeded). Has `status: 429` and optional `limit`, `remaining`, `resetTime`. Use `isBagsRateLimit()` to detect. Future phases must not treat local soft-cap refusal as Bags 429.

## What this repo will use first

- `getTokenCreators(mint)` — normalized to `BagsTokenCreatorsResult` (creators array, primaryCreator).
- `getTokenLifetimeFees(mint)` — normalized to `BagsTokenLifetimeFeesResult` (feesLamports, feesSol).
- Single shared client in `@pulse/bags` with env validation at startup. Env (e.g. dotenv) is loaded by app/script entrypoints, not by the shared package.
- In-process rate-budget guard (soft cap 800/hour), no Redis, no distributed limit. Guard refusal returns `BAGS_LOCAL_SOFT_CAP`, not `BAGS_RATE_LIMIT`.

---

## What this repo is deliberately not doing yet

- No engine integration. No schema changes. No Telegram changes.
- No partner key, fee claim, token launch, or trading flows.
- No raw HTTP client; SDK only.
- No use of `PRIVATE_KEY` or any write/transaction operations.
- No dotenv import inside `@pulse/bags`; entrypoints load env.
