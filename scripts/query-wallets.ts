import { Client } from "pg";
import * as path from "path";
import * as dotenv from "dotenv";

dotenv.config({ path: path.join(__dirname, "../.env") });

async function queryWallets() {
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
  });

  try {
    await client.connect();

    const res = await client.query(
      `SELECT wallet_address, COUNT(*) AS cnt
       FROM raw_events
       WHERE wallet_address IS NOT NULL
       GROUP BY wallet_address
       ORDER BY cnt DESC
       LIMIT 20;`,
    );

    console.table(res.rows);
  } catch (error) {
    console.error("Query failed:", error);
  } finally {
    await client.end();
  }
}

queryWallets();
