import { run } from "hardhat";
import * as fs from "fs";

const CHAINLINK_ETH_USD_SEPOLIA = "0x694AA1769357215DE4FAC081bf1f309aDC325306";

/// @notice Verify all deployed contracts on Etherscan (Sepolia).
///         Reads addresses from deployed-sepolia.json written by deploy-sepolia.ts.
///
/// Usage:
///   npx hardhat run scripts/verify-sepolia.ts --network sepolia
async function main() {
  if (!fs.existsSync("deployed-sepolia.json")) {
    throw new Error("deployed-sepolia.json not found. Run deploy-sepolia.ts first.");
  }

  const addresses = JSON.parse(fs.readFileSync("deployed-sepolia.json", "utf8"));
  console.log("\n=== Verifying contracts on Etherscan (Sepolia) ===\n");

  // ── MockUSDC ─────────────────────────────────────────────────────────────────
  console.log("1/5  Verifying MockUSDC...");
  await verify(addresses["MockUSDC"], [addresses["MockUSDC"]]);
  // Note: constructor arg is deployer address — set this to your actual deployer below
  // TODO: replace with actual deployer address if needed

  // ── ArbitrageToken ───────────────────────────────────────────────────────────
  console.log("2/5  Verifying ArbitrageToken (CARB)...");
  await verify(addresses["ArbitrageToken"], [addresses["ArbitrageToken"]]);

  // ── ChainlinkPriceOracle ─────────────────────────────────────────────────────
  console.log("3/5  Verifying ChainlinkPriceOracle...");
  await verify(addresses["ChainlinkPriceOracle"], [
    addresses["ChainlinkPriceOracle"], // deployer
    CHAINLINK_ETH_USD_SEPOLIA
  ]);

  // ── MockPerpEngine ───────────────────────────────────────────────────────────
  console.log("4/5  Verifying MockPerpEngine...");
  await verify(addresses["MockPerpEngine"], [
    addresses["StrategyVault"],           // owner (vault)
    addresses["MockUSDC"],
    addresses["ChainlinkPriceOracle"]
  ]);

  // ── StrategyVault ────────────────────────────────────────────────────────────
  console.log("5/5  Verifying StrategyVault...");
  await verify(addresses["StrategyVault"], [
    addresses["StrategyVault"],           // owner (self / deployer)
    addresses["MockUSDC"],
    addresses["MockPerpEngine"],
    addresses["ChainlinkPriceOracle"]
  ]);

  console.log("\n=== All verifications submitted ===");
  console.log("Check https://sepolia.etherscan.io for status.\n");
}

async function verify(address: string, constructorArgs: unknown[]) {
  try {
    await run("verify:verify", {
      address,
      constructorArguments: constructorArgs,
    });
    console.log(`     ✓  ${address}`);
  } catch (err: unknown) {
    if (err instanceof Error && err.message.includes("Already Verified")) {
      console.log(`     ↩  Already verified: ${address}`);
    } else {
      console.error(`     ✗  Failed: ${address}`, err);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
