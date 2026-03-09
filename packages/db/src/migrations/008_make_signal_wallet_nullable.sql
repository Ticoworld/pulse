/**
 * Make wallet_address nullable in the signals table.
 *
 * Apply:
 *   psql $DATABASE_URL -f packages/db/src/migrations/008_make_signal_wallet_nullable.sql
 */

ALTER TABLE signals ALTER COLUMN wallet_address DROP NOT NULL;
