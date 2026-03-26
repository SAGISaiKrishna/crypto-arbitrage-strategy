import { run, ethers } from "hardhat";
import * as fs from "fs";

// ─────────────────────────────────────────────────────────────────────────────
// IMPORTANT: Constructor argument correctness for Etherscan verification
//
// Etherscan verifies contracts by re-encoding the constructor arguments that
// were passed at deployment time and comparing the result against the deployed
// bytecode. The arguments here MUST match what was passed in deploy-sepolia.ts
// exactly — not the current owner, but the ORIGINAL constructor argument.
//
// For every contract in this project the first constructor argument is
// `initialOwner`, which was set to `deployer.address` at deployment time.
// Ownership of MockPerpEngine is later transferred to StrategyVault, but that
// does NOT change the constructor argument — verification still requires the
// original deployer address.
//
// The deployer address is read from the signer at runtime (same wallet that
// ran deploy-sepolia.ts) so this script must be run from the same wallet.
// ─────────────────────────────────────────────────────────────────────────────

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

  // The deployer address is the wallet signing this transaction — it must be
  // the same wallet that ran deploy-sepolia.ts.
  const [deployer] = await ethers.getSigners();
  const deployerAddress = deployer.address;

  console.log("\n=== Verifying contracts on Etherscan (Sepolia) ===");
  console.log(`    Deployer address: ${deployerAddress}\n`);

  // ── MockUSDC ─────────────────────────────────────────────────────────────────
  // constructor(address initialOwner)
  console.log("1/5  Verifying MockUSDC...");
  await verify(addresses["MockUSDC"], [deployerAddress]);

  // ── ArbitrageToken ───────────────────────────────────────────────────────────
  // constructor(address initialOwner)
  console.log("2/5  Verifying ArbitrageToken (CARB)...");
  await verify(addresses["ArbitrageToken"], [deployerAddress]);

  // ── ChainlinkPriceOracle ─────────────────────────────────────────────────────
  // constructor(address initialOwner, address feedAddress)
  console.log("3/5  Verifying ChainlinkPriceOracle...");
  await verify(addresses["ChainlinkPriceOracle"], [
    deployerAddress,
    CHAINLINK_ETH_USD_SEPOLIA,
  ]);

  // ── MockPerpEngine ───────────────────────────────────────────────────────────
  // constructor(address initialOwner, address collateralToken_, address oracle_)
  // Note: ownership is transferred to StrategyVault after deployment, but the
  // constructor arg for verification is always the ORIGINAL initialOwner (deployer).
  console.log("4/5  Verifying MockPerpEngine...");
  await verify(addresses["MockPerpEngine"], [
    deployerAddress,
    addresses["MockUSDC"],
    addresses["ChainlinkPriceOracle"],
  ]);

  // ── StrategyVault ────────────────────────────────────────────────────────────
  // constructor(address initialOwner, address usdc_, address perpEngine_, address oracle_)
  console.log("5/5  Verifying StrategyVault...");
  await verify(addresses["StrategyVault"], [
    deployerAddress,
    addresses["MockUSDC"],
    addresses["MockPerpEngine"],
    addresses["ChainlinkPriceOracle"],
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
