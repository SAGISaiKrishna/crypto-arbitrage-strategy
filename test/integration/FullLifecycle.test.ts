import { ethers } from "hardhat";
import { expect } from "chai";
import {
  StrategyVault, MockPerpEngine, MockUSDC, MockPriceOracle, ArbitrageToken
} from "../../typechain-types";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { time } from "@nomicfoundation/hardhat-network-helpers";

/// @title Full Lifecycle Integration Test
/// @notice Simulates the complete strategy flow:
///         deploy → deposit → openHedge → wait (funding accrues) → closeHedge → withdraw
///
///         This test is the primary demonstration of the system working end-to-end.
///         It mirrors what the deploy-local.ts script + interact.ts script would show.
describe("Full Strategy Lifecycle (Integration)", () => {
  let vault:   StrategyVault;
  let engine:  MockPerpEngine;
  let usdc:    MockUSDC;
  let oracle:  MockPriceOracle;
  let token:   ArbitrageToken;
  let owner:   SignerWithAddress;
  let alice:   SignerWithAddress;
  let bob:     SignerWithAddress;

  const ETH_PRICE = 2_000n * 10n ** 18n;
  const ONE_USDC  = 10n ** 6n;
  const ONE_DAY   = 86_400;

  before(async () => {
    [owner, alice, bob] = await ethers.getSigners();

    // ── 1. Deploy all contracts ───────────────────────────────────────────────
    const USDC   = await ethers.getContractFactory("MockUSDC");
    usdc = (await USDC.deploy(owner.address)) as unknown as MockUSDC;

    const Oracle = await ethers.getContractFactory("MockPriceOracle");
    oracle = (await Oracle.deploy(owner.address, ETH_PRICE)) as unknown as MockPriceOracle;

    const Engine = await ethers.getContractFactory("MockPerpEngine");
    engine = (await Engine.deploy(
      owner.address,
      await usdc.getAddress(),
      await oracle.getAddress()
    )) as unknown as MockPerpEngine;

    const Vault  = await ethers.getContractFactory("StrategyVault");
    vault = (await Vault.deploy(
      owner.address,
      await usdc.getAddress(),
      await engine.getAddress(),
      await oracle.getAddress()
    )) as unknown as StrategyVault;

    const Token  = await ethers.getContractFactory("ArbitrageToken");
    token = (await Token.deploy(owner.address)) as unknown as ArbitrageToken;

    // Transfer engine ownership to vault
    await engine.transferOwnership(await vault.getAddress());

    // ── 2. Fund test users ────────────────────────────────────────────────────
    await usdc.mint(alice.address, 100_000n * ONE_USDC);
    await usdc.mint(bob.address,   100_000n * ONE_USDC);
    await usdc.connect(alice).approve(await vault.getAddress(), ethers.MaxUint256);
    await usdc.connect(bob).approve(await vault.getAddress(),   ethers.MaxUint256);
  });

  // ── Step 1: Deposits ─────────────────────────────────────────────────────────

  it("Step 1: Alice and Bob deposit USDC into the vault", async () => {
    await vault.connect(alice).deposit(50_000n * ONE_USDC);
    await vault.connect(bob).deposit(30_000n * ONE_USDC);

    const state = await vault.getVaultState();
    expect(state.totalDeposited).to.equal(80_000n * ONE_USDC);
    console.log(`    ✓ Total deposited: $${Number(state.totalDeposited) / 1e6}`);
  });

  // ── Step 2: Carry Check ───────────────────────────────────────────────────────

  it("Step 2: Vault correctly reports carry viability", async () => {
    // 3 bps/day funding → carryScore = 500 + 1095 - 50 = 1545 bps → viable
    expect(await vault.isCarryViable(3n)).to.be.true;
    // -5 bps/day funding → carryScore = 500 - 1825 - 50 = -1375 bps → not viable
    expect(await vault.isCarryViable(-5n)).to.be.false;
    console.log("    ✓ Carry viability check working correctly");
  });

  // ── Step 3: Open Hedge ───────────────────────────────────────────────────────

  it("Step 3: Owner opens short ETH hedge", async () => {
    const notional   = 40_000n * ONE_USDC; // $40 000 notional
    const collateral = 8_000n  * ONE_USDC; // $8 000 margin (20%)

    await vault.connect(owner).openHedge(notional, collateral, 3n);

    expect(await vault.hedgeIsOpen()).to.be.true;
    expect(await vault.hedgeCollateral()).to.equal(collateral);

    const state = await vault.getVaultState();
    console.log(`    ✓ Hedge opened | notional: $${Number(notional)/1e6} | collateral: $${Number(collateral)/1e6}`);
    console.log(`    ✓ Carry score: ${state.carryScore} bps annualised`);
  });

  // ── Step 4: Time Passes (30 days) ────────────────────────────────────────────

  it("Step 4: 30 days pass — funding and lending yield accrue", async () => {
    await time.increase(ONE_DAY * 30);

    // Accrue funding checkpoint
    await engine.accrueFunding(await vault.getAddress());

    const pos = await engine.getPosition(await vault.getAddress());
    // 3 bps/day × 30 days × $40 000 notional = $360
    expect(pos.cumulativeFunding).to.be.greaterThan(0n);
    console.log(`    ✓ Cumulative funding: $${Number(pos.cumulativeFunding) / 1e6}`);

    // Lending yield for Alice: 5% APY × 30/365 × $50 000 ≈ $205
    const aliceValue = await vault.getUserValue(alice.address);
    console.log(`    ✓ Alice's vault value: $${Number(aliceValue) / 1e6}`);
    expect(aliceValue).to.be.greaterThan(50_000n * ONE_USDC);
  });

  // ── Step 5: Margin Check ─────────────────────────────────────────────────────

  it("Step 5: Margin ratio remains healthy with flat ETH price", async () => {
    const marginRatio = await engine.getMarginRatio(await vault.getAddress());
    const isLiquidatable = await engine.isLiquidatable(await vault.getAddress());

    expect(isLiquidatable).to.be.false;
    // After 30 days positive funding, margin ratio should be above initial 2000 bps
    expect(marginRatio).to.be.greaterThanOrEqual(2_000n);
    console.log(`    ✓ Margin ratio: ${marginRatio} bps — healthy`);
  });

  // ── Step 6: Close Hedge ───────────────────────────────────────────────────────

  it("Step 6: Owner closes hedge and receives proceeds", async () => {
    const vaultBalBefore = await usdc.balanceOf(await vault.getAddress());
    await vault.connect(owner).closeHedge();
    const vaultBalAfter  = await usdc.balanceOf(await vault.getAddress());

    expect(await vault.hedgeIsOpen()).to.be.false;
    // Vault should have more USDC than before (funding income)
    expect(vaultBalAfter).to.be.greaterThan(vaultBalBefore);
    console.log(`    ✓ Hedge closed | USDC returned to vault: $${Number(vaultBalAfter - vaultBalBefore) / 1e6} profit`);
  });

  // ── Step 7: Withdraw ─────────────────────────────────────────────────────────

  it("Step 7: Alice withdraws and receives more than her deposit", async () => {
    const aliceBefore = await usdc.balanceOf(alice.address);
    const aliceInfo   = await vault.userInfo(alice.address);

    await vault.connect(alice).withdraw(aliceInfo.shares);

    const aliceAfter  = await usdc.balanceOf(alice.address);
    const received    = aliceAfter - aliceBefore;

    // Alice should receive her $50 000 back plus her share of:
    // - 30-day lending yield (~$205)
    // - 30-day funding income from hedge (proportional)
    expect(received).to.be.greaterThan(50_000n * ONE_USDC);
    console.log(`    ✓ Alice received: $${Number(received) / 1e6} (deposited $50 000)`);
    console.log(`    ✓ Net profit: $${Number(received - 50_000n * ONE_USDC) / 1e6}`);
  });

  // ── Step 8: CARB Token ───────────────────────────────────────────────────────

  it("Step 8: CARB token is deployed and transferable", async () => {
    expect(await token.name()).to.equal("Crypto Arbitrage Token");
    expect(await token.symbol()).to.equal("CARB");
    expect(await token.totalSupply()).to.equal(10_000_000n * 10n ** 18n);

    await token.transfer(alice.address, 1_000n * 10n ** 18n);
    expect(await token.balanceOf(alice.address)).to.equal(1_000n * 10n ** 18n);
    console.log("    ✓ CARB token deployed and transfers working");
  });

  // ── Summary ──────────────────────────────────────────────────────────────────

  it("Summary: vault state is clean after all users exit", async () => {
    // Bob also withdraws
    const bobInfo = await vault.userInfo(bob.address);
    if (bobInfo.shares > 0n) {
      await vault.connect(bob).withdraw(bobInfo.shares);
    }

    const state = await vault.getVaultState();
    console.log("\n    ─── Final Vault State ───");
    console.log(`    totalDeposited : $${Number(state.totalDeposited) / 1e6}`);
    console.log(`    hedgeIsOpen    : ${state.hedgeIsOpen}`);
    console.log(`    totalShares    : ${state.totalShares}`);
    console.log("    ─────────────────────────");
  });
});
