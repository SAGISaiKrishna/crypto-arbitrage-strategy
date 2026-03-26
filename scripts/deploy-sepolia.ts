import { ethers } from "hardhat";

/// Chainlink ETH/USD price feed on Sepolia testnet.
/// Source: https://docs.chain.link/data-feeds/price-feeds/addresses?network=ethereum&page=1#sepolia-testnet
const CHAINLINK_ETH_USD_SEPOLIA = "0x694AA1769357215DE4FAC081bf1f309aDC325306";

/// @notice Deploy all contracts to Sepolia testnet with Chainlink oracle.
///
/// Prerequisites:
///   1. Fill .env with PRIVATE_KEY, SEPOLIA_RPC_URL, ETHERSCAN_API_KEY
///   2. Fund deployer wallet with Sepolia ETH (https://sepoliafaucet.com)
///
/// Usage:
///   npx hardhat run scripts/deploy-sepolia.ts --network sepolia
///
/// After deployment, run verify-sepolia.ts to verify on Etherscan.
async function main() {
  const [deployer] = await ethers.getSigners();
  const network    = await ethers.provider.getNetwork();

  console.log("\n=== Deploying to Sepolia Testnet ===");
  console.log(`Network:  ${network.name} (chainId: ${network.chainId})`);
  console.log(`Deployer: ${deployer.address}`);
  console.log(`Balance:  ${ethers.formatEther(await ethers.provider.getBalance(deployer.address))} ETH\n`);

  if (network.chainId !== 11155111n) {
    throw new Error("This script is intended for Sepolia only. Use deploy-local.ts for localhost.");
  }

  const deployedAddresses: Record<string, string> = {};

  // ── 1. MockUSDC ─────────────────────────────────────────────────────────────
  console.log("1/6  Deploying MockUSDC...");
  const USDC = await ethers.getContractFactory("MockUSDC");
  const usdc = await USDC.deploy(deployer.address);
  await usdc.waitForDeployment();
  deployedAddresses["MockUSDC"] = await usdc.getAddress();
  console.log(`     ✓  ${deployedAddresses["MockUSDC"]}`);

  // ── 2. ArbitrageToken (CARB) ─────────────────────────────────────────────────
  console.log("\n2/6  Deploying ArbitrageToken (CARB)...");
  const Token = await ethers.getContractFactory("ArbitrageToken");
  const token = await Token.deploy(deployer.address);
  await token.waitForDeployment();
  deployedAddresses["ArbitrageToken"] = await token.getAddress();
  console.log(`     ✓  ${deployedAddresses["ArbitrageToken"]}`);

  // ── 3. ChainlinkPriceOracle ──────────────────────────────────────────────────
  console.log("\n3/6  Deploying ChainlinkPriceOracle...");
  console.log(`     Feed address: ${CHAINLINK_ETH_USD_SEPOLIA}`);
  const Oracle = await ethers.getContractFactory("ChainlinkPriceOracle");
  const oracle = await Oracle.deploy(deployer.address, CHAINLINK_ETH_USD_SEPOLIA);
  await oracle.waitForDeployment();
  deployedAddresses["ChainlinkPriceOracle"] = await oracle.getAddress();
  console.log(`     ✓  ${deployedAddresses["ChainlinkPriceOracle"]}`);

  // Validate oracle is live
  const livePrice = await oracle.getPrice();
  console.log(`     Live ETH price: $${Number(livePrice) / 1e18}`);

  // ── 4. MockPerpEngine ────────────────────────────────────────────────────────
  console.log("\n4/6  Deploying MockPerpEngine...");
  const Engine = await ethers.getContractFactory("MockPerpEngine");
  const engine = await Engine.deploy(
    deployer.address,
    deployedAddresses["MockUSDC"],
    deployedAddresses["ChainlinkPriceOracle"]
  );
  await engine.waitForDeployment();
  deployedAddresses["MockPerpEngine"] = await engine.getAddress();
  console.log(`     ✓  ${deployedAddresses["MockPerpEngine"]}`);

  // ── 5. StrategyVault ─────────────────────────────────────────────────────────
  console.log("\n5/6  Deploying StrategyVault...");
  const Vault = await ethers.getContractFactory("StrategyVault");
  const vault = await Vault.deploy(
    deployer.address,
    deployedAddresses["MockUSDC"],
    deployedAddresses["MockPerpEngine"],
    deployedAddresses["ChainlinkPriceOracle"]
  );
  await vault.waitForDeployment();
  deployedAddresses["StrategyVault"] = await vault.getAddress();
  console.log(`     ✓  ${deployedAddresses["StrategyVault"]}`);

  // ── 6. Transfer engine ownership to vault ────────────────────────────────────
  console.log("\n6/6  Transferring engine ownership to vault...");
  const tx = await engine.transferOwnership(deployedAddresses["StrategyVault"]);
  await tx.wait();
  console.log("     ✓  Done");

  // ── Print deployment summary ─────────────────────────────────────────────────
  console.log("\n╔══════════════════════════════════════════════════════════════╗");
  console.log("║             SEPOLIA DEPLOYMENT COMPLETE                      ║");
  console.log("╠══════════════════════════════════════════════════════════════╣");
  for (const [name, addr] of Object.entries(deployedAddresses)) {
    console.log(`║  ${name.padEnd(24)} ${addr}  ║`);
  }
  console.log("╚══════════════════════════════════════════════════════════════╝");
  console.log("\nNext step: run scripts/verify-sepolia.ts with these addresses.");
  console.log("           Update frontend/contracts/ with deployed ABIs.\n");

  // Write addresses to a file for verify script to pick up
  const fs = await import("fs");
  fs.writeFileSync(
    "deployed-sepolia.json",
    JSON.stringify(deployedAddresses, null, 2)
  );
  console.log("Addresses saved to deployed-sepolia.json\n");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
