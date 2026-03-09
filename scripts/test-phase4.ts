/**
 * Synthetic test for Phase 4: Dev Tracking v1 + Funder Heuristic
 */
import { Client } from "pg";
import dotenv from "dotenv";
import path from "path";

dotenv.config({ path: path.join(__dirname, "../.env") });

async function runTest() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  const funderWallet = "MASTER_FUND_" + Date.now();
  const deployerWallet = "DEPLOYER_" + Date.now();
  const testMint = "MINT_PH4_F_" + Date.now();

  const fundSig = "sig_fund_" + Date.now();
  const mintSig = "sig_mint_" + Date.now();
  const swapSig = "sig_swap_" + Date.now();

  console.log("--- Phase 4: Dev Tracking + Funder Heuristic Test ---");

  // 1. Inject TRANSFER (Funding)
  console.log("1. Injecting TRANSFER (Funding: Master -> Deployer)...");
  const key0 = `${fundSig}:TRANSFER::${deployerWallet}`;
  await client.query(
    `INSERT INTO raw_events (event_key, source, event_type, signature, slot, wallet_address, amount, ts, raw_payload)
     VALUES ($1, 'helius', 'TRANSFER', $2, 699990, $3, 1000000000, NOW(), $4)`,
    [
      key0,
      fundSig,
      deployerWallet,
      JSON.stringify({
        signature: fundSig,
        type: "TRANSFER",
        nativeTransfers: [
          {
            fromUserAccount: funderWallet,
            toUserAccount: deployerWallet,
            amount: 1000000000,
          },
        ],
      }),
    ],
  );

  // 2. Inject TOKEN_MINT (triggers NEW_MINT_SEEN + Dev Link with Funder)
  console.log("2. Injecting TOKEN_MINT...");
  const key1 = `${mintSig}:TOKEN_MINT::${testMint}`;
  await client.query(
    `INSERT INTO raw_events (event_key, source, event_type, signature, slot, token_mint, wallet_address, ts, raw_payload)
     VALUES ($1, 'helius', 'TOKEN_MINT', $2, 700000, $3, $4, NOW(), '{}'::jsonb)`,
    [key1, mintSig, testMint, deployerWallet],
  );

  console.log("   Waiting for engine to process...");
  await new Promise((r) => setTimeout(r, 6000));

  // Verify Dev Link
  const resLink = await client.query(
    "SELECT * FROM launch_dev_links WHERE mint = $1",
    [testMint],
  );
  console.log("   Link Status:", resLink.rows[0] ? "CREATED" : "MISSING");
  if (resLink.rows[0]) {
    console.log("   Probable Dev:", resLink.rows[0].probable_dev_wallet); // Should be funderWallet
    console.log("   Deployer:", resLink.rows[0].deployer_wallet);
    console.log("   Funder:", resLink.rows[0].funder_wallet);
    console.log("   Method:", resLink.rows[0].method); // Should be 'funder'
    console.log("   Confidence:", resLink.rows[0].confidence); // Should be 'high'
  }

  // 3. Insert SWAP (triggers LIQUIDITY_LIVE + Profile Update for MASTER)
  console.log("\n3. Injecting SWAP (to trigger LIQUIDITY_LIVE)...");
  const key2 = `${swapSig}:SWAP::${testMint}`;
  await client.query(
    `INSERT INTO raw_events (event_key, source, event_type, signature, slot, token_mint, amount, ts, raw_payload)
     VALUES ($1, 'helius', 'SWAP', $2, 700010, $3, 1000, NOW(), '{}'::jsonb)`,
    [key2, swapSig, testMint],
  );

  console.log("   Waiting for engine...");
  await new Promise((r) => setTimeout(r, 6000));

  const resProf = await client.query(
    "SELECT * FROM dev_profiles WHERE dev_wallet = $1",
    [funderWallet],
  );
  if (resProf.rows[0]) {
    console.log("   Dev Profile found for Funder:", funderWallet);
    console.log("   Launch Count:", resProf.rows[0].launch_count); // Should be 1
    console.log(
      "   Liquidity Live Count:",
      resProf.rows[0].liquidity_live_count,
    ); // Should be 1
  }

  console.log("\n✅ Test complete.");
  await client.end();
}

runTest().catch(console.error);
