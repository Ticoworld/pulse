import { query } from "./client";

export interface DevProfile {
  id: string;
  dev_wallet: string;
  launch_count: number;
  liquidity_live_count: number;
  last_seen_at: Date | null;
  avg_time_to_liquidity_seconds: number | null;
  metadata: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
}

export interface LaunchDevLink {
  id: string;
  mint: string;
  deployer_wallet: string | null;
  funder_wallet: string | null;
  probable_dev_wallet: string | null;
  confidence: string;
  method: string;
  linked_at: Date;
  metadata: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
}

export async function upsertDevProfile(devWallet: string): Promise<void> {
  await query(
    `INSERT INTO dev_profiles (dev_wallet)
     VALUES ($1)
     ON CONFLICT (dev_wallet) DO NOTHING`,
    [devWallet],
  );
}

export async function incrementDevLaunchCount(
  devWallet: string,
): Promise<void> {
  await query(
    `UPDATE dev_profiles
     SET launch_count = launch_count + 1,
         last_seen_at = NOW(),
         updated_at = NOW()
     WHERE dev_wallet = $1`,
    [devWallet],
  );
}

export async function incrementDevLiquidityLiveCount(
  devWallet: string,
): Promise<void> {
  await query(
    `UPDATE dev_profiles
     SET liquidity_live_count = liquidity_live_count + 1,
         last_seen_at = NOW(),
         updated_at = NOW()
     WHERE dev_wallet = $1`,
    [devWallet],
  );
}

export async function updateDevLastSeen(
  devWallet: string,
  ts: Date,
): Promise<void> {
  await query(
    `UPDATE dev_profiles
     SET last_seen_at = $1,
         updated_at = NOW()
     WHERE dev_wallet = $2`,
    [ts, devWallet],
  );
}

export async function getDevProfile(
  devWallet: string,
): Promise<DevProfile | null> {
  const res = await query<DevProfile>(
    `SELECT * FROM dev_profiles WHERE dev_wallet = $1`,
    [devWallet],
  );
  return res.rows[0] ?? null;
}

export async function listTopDevProfiles(
  limit: number = 10,
): Promise<DevProfile[]> {
  const res = await query<DevProfile>(
    `SELECT * FROM dev_profiles ORDER BY launch_count DESC LIMIT $1`,
    [limit],
  );
  return res.rows;
}

export async function upsertLaunchDevLink(
  link: Partial<LaunchDevLink> & { mint: string },
): Promise<void> {
  await query(
    `INSERT INTO launch_dev_links (
       mint, deployer_wallet, funder_wallet, probable_dev_wallet, confidence, method, metadata
     ) VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (mint) DO UPDATE SET
       deployer_wallet = EXCLUDED.deployer_wallet,
       funder_wallet = EXCLUDED.funder_wallet,
       probable_dev_wallet = EXCLUDED.probable_dev_wallet,
       confidence = EXCLUDED.confidence,
       method = EXCLUDED.method,
       metadata = launch_dev_links.metadata || EXCLUDED.metadata,
       updated_at = NOW()`,
    [
      link.mint,
      link.deployer_wallet ?? null,
      link.funder_wallet ?? null,
      link.probable_dev_wallet ?? null,
      link.confidence ?? "low",
      link.method ?? "unknown",
      JSON.stringify(link.metadata ?? {}),
    ],
  );
}

export async function getLaunchDevLinkByMint(
  mint: string,
): Promise<LaunchDevLink | null> {
  const res = await query<LaunchDevLink>(
    `SELECT * FROM launch_dev_links WHERE mint = $1`,
    [mint],
  );
  return res.rows[0] ?? null;
}

export async function listLaunchesByProbableDev(
  devWallet: string,
  limit: number = 20,
): Promise<LaunchDevLink[]> {
  const res = await query<LaunchDevLink>(
    `SELECT * FROM launch_dev_links WHERE probable_dev_wallet = $1 ORDER BY linked_at DESC LIMIT $2`,
    [devWallet, limit],
  );
  return res.rows;
}
