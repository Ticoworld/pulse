/**
 * @pulse/bags — read-only Bags API foundation for the monorepo.
 * Single client, in-process rate guard, docs-backed methods only.
 * No engine/Telegram/schema integration in this package.
 */

export {
  BagsClient,
  getBagsClient,
  type BagsClientConfig,
} from "./client";
export { BagsRateGuard, type RateGuardConfig } from "./rateGuard";
export type {
  BagsTokenCreator,
  BagsTokenCreatorsResult,
  BagsTokenLifetimeFeesResult,
  BagsClientError,
} from "./types";
export { isBagsClientError, isBagsLocalSoftCap, isBagsRateLimit } from "./types";
