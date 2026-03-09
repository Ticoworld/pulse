import { query } from "@pulse/db";

async function testTrigger() {
  const walletAddress = "8ekCy2jHHUbW2yeNGFWYJT9Hm9FW7SvZcZK66dSZCDiF";
  const signature = "fake-sig-" + Date.now();
  const eventType = "SWAP";
  const tokenMint = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"; // USDC
  const eventKey = `${signature}:${eventType}:${walletAddress}:${tokenMint}`;

  try {
    console.log(`Inserting fake swap for wallet: ${walletAddress}`);

    await query(
      `INSERT INTO raw_events
         (source, event_type, signature, slot, wallet_address, token_mint, amount, ts, raw_payload, event_key)
       VALUES
         ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (event_key) DO NOTHING`,
      [
        "helius-test",
        eventType,
        signature,
        123456789,
        walletAddress,
        tokenMint,
        1000.5,
        new Date(),
        JSON.stringify({ note: "test payload from script" }),
        eventKey,
      ],
    );

    console.log(
      "Fake swap inserted successfully. Wait a few seconds for engine and bot to pick it up!",
    );
  } catch (err) {
    console.error("Failed to insert fake swap:", err);
  }
}

testTrigger();
