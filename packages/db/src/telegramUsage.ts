import { query } from "./client";

export interface TelegramUserUpsert {
  telegramUserId: number;
  username?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  lastCommand?: string | null;
  isOwner?: boolean;
}

export interface TelegramCommandEventInsert {
  telegramUserId: number;
  command: string;
  commandArgs?: string | null;
  success?: boolean;
  errorMessage?: string | null;
}

export interface TelegramUsageMetrics {
  uniqueUsers: number;
  totalCommandEvents: number;
}

export interface TelegramTopCommandUsage {
  command: string;
  count: number;
}

interface UsageMetricsRow {
  unique_users: string;
  total_events: string;
}

interface TopCommandRow {
  command: string;
  count: string;
}

interface CooldownRow {
  remaining_seconds: number;
}

export async function upsertTelegramUser(data: TelegramUserUpsert): Promise<void> {
  await query(
    `INSERT INTO telegram_users (
       telegram_user_id,
       username,
       first_name,
       last_name,
       last_command,
       command_count,
       is_owner,
       first_seen_at,
       last_seen_at,
       created_at,
       updated_at
     ) VALUES ($1, $2, $3, $4, $5, 1, $6, NOW(), NOW(), NOW(), NOW())
     ON CONFLICT (telegram_user_id) DO UPDATE SET
       username = EXCLUDED.username,
       first_name = EXCLUDED.first_name,
       last_name = EXCLUDED.last_name,
       last_seen_at = NOW(),
       last_command = EXCLUDED.last_command,
       command_count = telegram_users.command_count + 1,
       is_owner = (telegram_users.is_owner OR EXCLUDED.is_owner),
       updated_at = NOW()`,
    [
      data.telegramUserId,
      data.username ?? null,
      data.firstName ?? null,
      data.lastName ?? null,
      data.lastCommand ?? null,
      data.isOwner ?? false,
    ],
  );
}

export async function recordTelegramCommandEvent(
  event: TelegramCommandEventInsert,
): Promise<void> {
  await query(
    `INSERT INTO telegram_command_events (
       telegram_user_id,
       command,
       command_args,
       success,
       error_message
     ) VALUES ($1, $2, $3, $4, $5)`,
    [
      event.telegramUserId,
      event.command,
      event.commandArgs ?? null,
      event.success ?? true,
      event.errorMessage ?? null,
    ],
  );
}

export async function getTelegramUsageMetrics(
  sinceHours = 24,
): Promise<TelegramUsageMetrics> {
  const result = await query<UsageMetricsRow>(
    `SELECT
       COUNT(DISTINCT telegram_user_id)::bigint AS unique_users,
       COUNT(*)::bigint AS total_events
     FROM telegram_command_events
     WHERE used_at >= NOW() - ($1::text || ' hours')::interval`,
    [sinceHours],
  );
  const row = result.rows[0];
  return {
    uniqueUsers: Number(row?.unique_users ?? 0),
    totalCommandEvents: Number(row?.total_events ?? 0),
  };
}

export async function listTopTelegramCommands(
  sinceHours = 24,
  limit = 10,
): Promise<TelegramTopCommandUsage[]> {
  const result = await query<TopCommandRow>(
    `SELECT
       command,
       COUNT(*)::bigint AS count
     FROM telegram_command_events
     WHERE used_at >= NOW() - ($1::text || ' hours')::interval
     GROUP BY command
     ORDER BY count DESC, command ASC
     LIMIT $2`,
    [sinceHours, limit],
  );
  return result.rows.map((row) => ({
    command: row.command,
    count: Number(row.count),
  }));
}

export async function getTelegramCommandCooldownRemainingSeconds(
  telegramUserId: number,
  commands: string[],
  cooldownSeconds: number,
): Promise<number> {
  if (commands.length === 0 || cooldownSeconds <= 0) {
    return 0;
  }

  const result = await query<CooldownRow>(
    `SELECT
       CASE
         WHEN MAX(used_at) IS NULL THEN 0
         ELSE GREATEST(
           0,
           CEIL($3::numeric - EXTRACT(EPOCH FROM (NOW() - MAX(used_at))))
         )
       END::int AS remaining_seconds
     FROM telegram_command_events
     WHERE telegram_user_id = $1
       AND command = ANY($2::text[])
       AND success = true`,
    [telegramUserId, commands, cooldownSeconds],
  );
  return Number(result.rows[0]?.remaining_seconds ?? 0);
}
