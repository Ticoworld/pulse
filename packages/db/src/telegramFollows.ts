import { query } from "./client";

export interface TelegramMintFollow {
  telegram_user_id: string;
  mint: string;
  created_at: Date;
}

interface TelegramFollowerRow {
  telegram_user_id: string;
}

interface DeliveryExistsRow {
  exists: boolean;
}

export interface TelegramSignalDeliveryInsert {
  telegramUserId: number;
  signalId: string;
  deliveryKind: string;
  success?: boolean;
  errorMessage?: string | null;
}

export async function followMintForTelegramUser(
  telegramUserId: number,
  mint: string,
): Promise<{ created: boolean }> {
  const result = await query(
    `INSERT INTO telegram_user_mint_follows (telegram_user_id, mint)
     VALUES ($1, $2)
     ON CONFLICT (telegram_user_id, mint) DO NOTHING`,
    [telegramUserId, mint],
  );
  return { created: (result.rowCount ?? 0) > 0 };
}

export async function unfollowMintForTelegramUser(
  telegramUserId: number,
  mint: string,
): Promise<{ removed: boolean }> {
  const result = await query(
    `DELETE FROM telegram_user_mint_follows
     WHERE telegram_user_id = $1
       AND mint = $2`,
    [telegramUserId, mint],
  );
  return { removed: (result.rowCount ?? 0) > 0 };
}

export async function listFollowedMintsForTelegramUser(
  telegramUserId: number,
): Promise<TelegramMintFollow[]> {
  const result = await query<TelegramMintFollow>(
    `SELECT telegram_user_id, mint, created_at
     FROM telegram_user_mint_follows
     WHERE telegram_user_id = $1
     ORDER BY created_at ASC`,
    [telegramUserId],
  );
  return result.rows;
}

export async function listFollowersForMint(mint: string): Promise<number[]> {
  const result = await query<TelegramFollowerRow>(
    `SELECT telegram_user_id
     FROM telegram_user_mint_follows
     WHERE mint = $1
     ORDER BY telegram_user_id ASC`,
    [mint],
  );
  return result.rows.map((row) => Number(row.telegram_user_id));
}

export async function hasTelegramSignalDelivery(
  telegramUserId: number,
  signalId: string,
  deliveryKind: string,
): Promise<boolean> {
  const result = await query<DeliveryExistsRow>(
    `SELECT EXISTS (
       SELECT 1
       FROM telegram_signal_deliveries
       WHERE telegram_user_id = $1
         AND signal_id = $2
         AND delivery_kind = $3
     ) AS exists`,
    [telegramUserId, signalId, deliveryKind],
  );
  return result.rows[0]?.exists === true;
}

export async function recordTelegramSignalDelivery(
  input: TelegramSignalDeliveryInsert,
): Promise<{ inserted: boolean }> {
  const result = await query(
    `INSERT INTO telegram_signal_deliveries (
       telegram_user_id,
       signal_id,
       delivery_kind,
       success,
       error_message
     ) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (telegram_user_id, signal_id, delivery_kind) DO NOTHING`,
    [
      input.telegramUserId,
      input.signalId,
      input.deliveryKind,
      input.success ?? true,
      input.errorMessage ?? null,
    ],
  );
  return { inserted: (result.rowCount ?? 0) > 0 };
}
