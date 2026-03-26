import { ethers } from "hardhat";

/// @notice Interactive walkthrough of the full strategy lifecycle.
///         Prints formatted output suitable for screenshots in the submission.
///
/// Assumes deploy-local.ts has already been run.
/// Update the addresses below after running deploy-local.ts.
///
/// Usage:
///   npx hardhat run scripts/interact.ts --network localhost
const ADDRESSES = {
  MockUSDC:        "0x...",  // TODO: fill after deploy-local.ts
  ArbitrageToken:  "0x...",  // TODO: fill after deploy-local.ts
  MockPriceOracle: "0x...",  // TODO: fill after deploy-local.ts
  MockPerpEngine:  "0x...",  // TODO: fill after deploy-local.ts
  StrategyVault:   "0x...",  // TODO: fill after deploy-local.ts
};

async function main() {
  const [owner, alice, bob] = await ethers.getSigners();
  const ONE_USDC = 10n ** 6n;

  console.log("\n╔══════════════════════════════════════════════════════════════╗");
  console.log("║   Crypto Arbitrage Strategy — Interactive Demo               ║");
  console.log("╚══════════════════════════════════════════════════════════════╝\n");

  // Attach to deployed contracts
  const usdc   = await ethers.getContractAt("MockUSDC",       ADDRESSES.MockUSDC);
  const oracle = await ethers.getContractAt("MockPriceOracle",ADDRESSES.MockPriceOracle);
  const engine = await ethers.getContractAt("MockPerpEngine", ADDRESSES.MockPerpEngine);
  const vault  = await ethers.getContractAt("StrategyVault",  ADDRESSES.StrategyVault);

  // ── Step 1: Check initial state ───────────────────────────────────────────────
  console.log("── 1. Initial State ─────────────────────────────────────────────");
  const ethPrice = await oracle.getPrice();
  console.log(`   ETH/USD oracle price : $${Number(ethPrice) / 1e18}`);
  console.log(`   Alice USDC balance   : $${Number(await usdc.balanceOf(alice.address)) / 1e6}`);

  // ── Step 2: Alice deposits ────────────────────────────────────────────────────
  console.log("\n── 2. Alice Deposits $20 000 USDC ───────────────────────────────");
  await usdc.connect(alice).approve(ADDRESSES.StrategyVault, ethers.MaxUint256);
  const tx1 = await vault.connect(alice).deposit(20_000n * ONE_USDC);
  await tx1.wait();
  console.log(`   TX hash: ${tx1.hash}`);
  console.log(`   Vault totalDeposited: $${Number((await vault.getVaultState()).totalDeposited) / 1e6}`);

  // ── Step 3: Check carry viability ────────────────────────────────────────────
  console.log("\n── 3. isCarryViable check ───────────────────────────────────────");
  const viable3  = await vault.isCarryViable(3n);  // 3 bps/day contango
  const viable_5 = await vault.isCarryViable(-5n); // -5 bps backwardation
  console.log(`   Funding +3 bps/day (contango)     : viable = ${viable3}`);
  console.log(`   Funding -5 bps/day (backwardation): viable = ${viable_5}`);

  // ── Step 4: Open hedge ────────────────────────────────────────────────────────
  console.log("\n── 4. openHedge (owner) ─────────────────────────────────────────");
  const tx2 = await vault.connect(owner).openHedge(
    10_000n * ONE_USDC,
    2_000n  * ONE_USDC,
    3n
  );
  await tx2.wait();
  console.log(`   TX hash: ${tx2.hash}`);
  console.log(`   hedgeIsOpen: ${await vault.hedgeIsOpen()}`);
  console.log(`   hedgeCollateral: $${Number(await vault.hedgeCollateral()) / 1e6}`);

  // ── Step 5: Read unrealised PnL ───────────────────────────────────────────────
  console.log("\n── 5. getUnrealizedPnL (before any time passes) ─────────────────");
  const pnl = await engine.getUnrealizedPnL(ADDRESSES.StrategyVault);
  console.log(`   Unrealised PnL: $${Number(pnl) / 1e6}`);
  console.log(`   Margin ratio  : ${await engine.getMarginRatio(ADDRESSES.StrategyVault)} bps`);

  // ── Step 6: Simulate price change ─────────────────────────────────────────────
  console.log("\n── 6. Oracle price update (ETH → $2 200) ────────────────────────");
  await oracle.setPrice(2_200n * 10n ** 18n);
  const pnlAfterRise = await engine.getUnrealizedPnL(ADDRESSES.StrategyVault);
  console.log(`   Unrealised PnL after ETH rise: $${Number(pnlAfterRise) / 1e6}`);
  console.log(`   (Short loses when ETH rises — demonstrates directional risk)`);

  // Reset price for clean close
  await oracle.setPrice(2_000n * 10n ** 18n);
  console.log("   Oracle price reset to $2 000");

  // ── Step 7: Close hedge ───────────────────────────────────────────────────────
  console.log("\n── 7. closeHedge (owner) ────────────────────────────────────────");
  const tx3 = await vault.connect(owner).closeHedge();
  await tx3.wait();
  console.log(`   TX hash: ${tx3.hash}`);
  console.log(`   hedgeIsOpen: ${await vault.hedgeIsOpen()}`);

  // ── Step 8: Alice's value + withdraw ─────────────────────────────────────────
  console.log("\n── 8. Alice's value and withdrawal ──────────────────────────────");
  const aliceValue = await vault.getUserValue(alice.address);
  console.log(`   Alice vault value : $${Number(aliceValue) / 1e6}`);

  const aliceInfo  = await vault.userInfo(alice.address);
  const tx4 = await vault.connect(alice).withdraw(aliceInfo.shares);
  await tx4.wait();
  console.log(`   Withdraw TX hash  : ${tx4.hash}`);
  console.log(`   Alice final USDC  : $${Number(await usdc.balanceOf(alice.address)) / 1e6}`);

  // ── Step 9: getVaultState ─────────────────────────────────────────────────────
  console.log("\n── 9. Final vault state (getVaultState) ─────────────────────────");
  const state = await vault.getVaultState();
  console.log("   VaultState:", {
    totalDeposited: `$${Number(state.totalDeposited) / 1e6}`,
    hedgeIsOpen:    state.hedgeIsOpen,
    carryScore:     `${state.carryScore} bps`,
    marginRatioBps: `${state.marginRatioBps} bps`,
  });

  console.log("\n── Demo complete. ────────────────────────────────────────────────\n");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
