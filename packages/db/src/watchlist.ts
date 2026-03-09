import { query } from "./client";

export interface WatchlistWallet {
  id: string;
  wallet_address: string;
  label: string | null;
  is_active: boolean;
  created_at: Date;
}

/**
 * Add or re-activate a wallet in the watchlist.
 * Trims whitespace from the address before storing.
 */
export async function addWatchlistWallet(
  walletAddress: string,
  label?: string,
): Promise<void> {
  const addr = walletAddress.trim();
  if (!addr) throw new Error("wallet address must not be empty");

  await query(
    `INSERT INTO watchlist_wallets (wallet_address, label, is_active)
     VALUES ($1, $2, true)
     ON CONFLICT (wallet_address)
     DO UPDATE SET is_active = true, label = COALESCE(EXCLUDED.label, watchlist_wallets.label)`,
    [addr, label ?? null],
  );
}

/**
 * Soft-disable a wallet (sets is_active = false).
 */
export async function removeWatchlistWallet(
  walletAddress: string,
): Promise<void> {
  await query(
    `UPDATE watchlist_wallets SET is_active = false WHERE wallet_address = $1`,
    [walletAddress.trim()],
  );
}

/**
 * Return all currently active wallets.
 */
export async function listWatchlistWallets(): Promise<WatchlistWallet[]> {
  const result = await query<WatchlistWallet>(
    `SELECT id, wallet_address, label, is_active, created_at
     FROM watchlist_wallets
     WHERE is_active = true
     ORDER BY created_at ASC`,
  );
  return result.rows;
}

/**
 * Return a single active wallet by address, or null if not found / inactive.
 */
export async function getWatchlistWalletByAddress(
  walletAddress: string,
): Promise<WatchlistWallet | null> {
  const result = await query<WatchlistWallet>(
    `SELECT id, wallet_address, label, is_active, created_at
     FROM watchlist_wallets
     WHERE wallet_address = $1 AND is_active = true
     LIMIT 1`,
    [walletAddress.trim()],
  );
  return result.rows[0] ?? null;
}
