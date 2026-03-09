import { Client } from "pg";
import * as path from "path";
import * as dotenv from "dotenv";

dotenv.config({ path: path.join(__dirname, "../.env") });

async function verifyInserts() {
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
  });

  try {
    await client.connect();

    const res = await client.query(
      `SELECT seq, id, event_type, signature, SUBSTRING(event_key, 1, 30) AS event_key 
       FROM raw_events 
       ORDER BY seq DESC 
       LIMIT 10;`,
    );

    console.log(`Found ${res.rowCount} recent events:`);
    console.table(res.rows);
  } catch (error) {
    console.error("Verification failed:", error);
  } finally {
    await client.end();
  }
}

verifyInserts();
