import { ethers } from "hardhat";
import fs from "fs";

/// @notice Deploy all contracts to a local Hardhat node for development and testing.
///
/// Usage:
///   npx hardhat node                              # terminal 1
///   npx hardhat run scripts/deploy-local.ts --network localhost   # terminal 2
async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("\n=== Deploying to localhost ===");
  console.log(`Deployer: ${deployer.address}`);
  console.log(`Balance:  ${ethers.formatEther(await ethers.provider.getBalance(deployer.address))} ETH\n`);

  // ── 1. MockUSDC ─────────────────────────────────────────────────────────────
  console.log("1/6  Deploying MockUSDC...");
  const USDC  = await ethers.getContractFactory("MockUSDC");
  const usdc  = await USDC.deploy(deployer.address);
  await usdc.waitForDeployment();
  console.log(`     MockUSDC:          ${await usdc.getAddress()}`);

  // Mint additional test USDC for development accounts
  const [, alice, bob] = await ethers.getSigners();
  await usdc.mint(alice.address, 100_000n * 10n ** 6n);
  await usdc.mint(bob.address,   100_000n * 10n ** 6n);
  console.log(`     Minted 100 000 USDC → alice (${alice.address})`);
  console.log(`     Minted 100 000 USDC → bob   (${bob.address})`);

  // ── 2. ArbitrageToken (CARB) ─────────────────────────────────────────────────
  console.log("\n2/6  Deploying ArbitrageToken (CARB)...");
  const Token = await ethers.getContractFactory("ArbitrageToken");
  const token = await Token.deploy(deployer.address);
  await token.waitForDeployment();
  console.log(`     ArbitrageToken:    ${await token.getAddress()}`);

  // ── 3. MockPriceOracle (ETH = $2 000) ────────────────────────────────────────
  console.log("\n3/6  Deploying MockPriceOracle (ETH = $2 000)...");
  const Oracle  = await ethers.getContractFactory("MockPriceOracle");
  const oracle  = await Oracle.deploy(deployer.address, 2_000n * 10n ** 18n);
  await oracle.waitForDeployment();
  console.log(`     MockPriceOracle:   ${await oracle.getAddress()}`);

  // ── 4. MockPerpEngine ────────────────────────────────────────────────────────
  console.log("\n4/6  Deploying MockPerpEngine...");
  const Engine  = await ethers.getContractFactory("MockPerpEngine");
  const engine  = await Engine.deploy(
    deployer.address,
    await usdc.getAddress(),
    await oracle.getAddress()
  );
  await engine.waitForDeployment();
  console.log(`     MockPerpEngine:    ${await engine.getAddress()}`);

  // ── 5. StrategyVault ─────────────────────────────────────────────────────────
  console.log("\n5/6  Deploying StrategyVault...");
  const Vault   = await ethers.getContractFactory("StrategyVault");
  const vault   = await Vault.deploy(
    deployer.address,
    await usdc.getAddress(),
    await engine.getAddress(),
    await oracle.getAddress()
  );
  await vault.waitForDeployment();
  console.log(`     StrategyVault:     ${await vault.getAddress()}`);

  // ── 6. Transfer engine ownership to vault ────────────────────────────────────
  console.log("\n6/6  Transferring MockPerpEngine ownership to StrategyVault...");
  await engine.transferOwnership(await vault.getAddress());
  console.log(`     Done. Engine owner: ${await vault.getAddress()}`);

  // ── Summary ──────────────────────────────────────────────────────────────────
  console.log("\n=== Deployment Complete ===");
  const deployedAddresses = {
    MockUSDC:       await usdc.getAddress(),
    ArbitrageToken: await token.getAddress(),
    MockPriceOracle: await oracle.getAddress(),
    MockPerpEngine: await engine.getAddress(),
    StrategyVault:  await vault.getAddress(),
  };
  console.log(deployedAddresses);

  fs.writeFileSync(
    "deployed-local.json",
    JSON.stringify(deployedAddresses, null, 2)
  );
  fs.writeFileSync(
    "frontend/contracts/addresses.local.json",
    JSON.stringify(deployedAddresses, null, 2)
  );
  console.log("Saved deployment addresses to deployed-local.json");
  console.log("Saved frontend config to frontend/contracts/addresses.local.json");
  console.log("\nRun scripts/interact.ts to walk through the strategy lifecycle.\n");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
