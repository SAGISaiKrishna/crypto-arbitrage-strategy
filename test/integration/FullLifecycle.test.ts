import { ethers } from "hardhat";
import { expect } from "chai";
import {
  StrategyVault, MockPerpEngine, MockUSDC, MockPriceOracle, ArbitrageToken
} from "../../typechain-types";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { time } from "@nomicfoundation/hardhat-network-helpers";

/// @title Full Lifecycle Integration Test
/// @notice Demonstrates the complete delta-neutral carry strategy on-chain:
///
///         deploy → deposit → openHedge (spot + short perp)
///         → wait (funding accrues) → closeHedge → withdraw
///
///         Strategy: Long ETH spot allocation + Short ETH perpetual futures
///         Income:   Perpetual funding rate (received by shorts in contango)
///         Delta:    Approximately zero (price moves cancel between legs)
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

    // ── Deploy all contracts ──────────────────────────────────────────────────
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

    // Seed the engine with a USDC reserve so it can pay out funding income on close.
    // In a real exchange this would be the insurance fund / counterparty collateral.
    await usdc.mint(await engine.getAddress(), 10_000n * ONE_USDC);

    // ── Fund test users ────────────────────────────────────────────────────────
    await usdc.mint(alice.address, 100_000n * ONE_USDC);
    await usdc.mint(bob.address,   100_000n * ONE_USDC);
    await usdc.connect(alice).approve(await vault.getAddress(), ethers.MaxUint256);
    await usdc.connect(bob).approve(await vault.getAddress(),   ethers.MaxUint256);
  });

  // ── Step 1: Deposits ───────────────────────────────────────────────────────

  it("Step 1: Alice and Bob deposit USDC into the vault", async () => {
    await vault.connect(alice).deposit(50_000n * ONE_USDC);
    await vault.connect(bob).deposit(30_000n * ONE_USDC);

    const state = await vault.getVaultState();
    expect(state.totalDeposited).to.equal(80_000n * ONE_USDC);
    console.log(`    ✓ Total deposited: $${Number(state.totalDeposited) / 1e6}`);
  });

  // ── Step 2: Carry Check ────────────────────────────────────────────────────

  it("Step 2: Vault correctly reports carry viability", async () => {
    // benchmark=200, funding=3 bps/day, cost=50 → score = 845 bps → viable
    expect(await vault.isCarryViable(3n)).to.be.true;
    // benchmark=200, funding=-5 bps/day, cost=50 → score = -2075 bps → not viable
    expect(await vault.isCarryViable(-5n)).to.be.false;
    console.log("    ✓ Carry viability check working correctly");
  });

  // ── Step 3: Open Position ──────────────────────────────────────────────────

  it("Step 3: Owner opens delta-neutral position (long spot + short perp)", async () => {
    const notional   = 40_000n * ONE_USDC; // $40 000 notional (= spot allocation = perp notional)
    const collateral = 8_000n  * ONE_USDC; // $8 000 margin (20% of notional = 5x leverage)

    await vault.connect(owner).openHedge(notional, collateral, 3n);

    expect(await vault.hedgeIsOpen()).to.be.true;
    expect(await vault.hedgeCollateral()).to.equal(collateral);
    expect(await vault.spotAllocationUsdc()).to.equal(notional);

    const state = await vault.getVaultState();
    console.log(`    ✓ Position opened | notional: $${Number(notional)/1e6} | collateral: $${Number(collateral)/1e6}`);
    console.log(`    ✓ Carry score: ${state.carryScore} bps annualised`);
    console.log(`    ✓ Spot allocation: $${Number(await vault.spotAllocationUsdc())/1e6}`);
  });

  // ── Step 4: Delta-Neutral Check ────────────────────────────────────────────

  it("Step 4: Price legs cancel — net delta PnL is approximately zero", async () => {
    // With ETH price unchanged, spot PnL + short PnL = 0
    const state = await vault.getVaultState();
    expect(state.netDeltaPnL).to.equal(0n);
    console.log(`    ✓ Net delta PnL: ${state.netDeltaPnL} (delta-neutral confirmed at unchanged price)`);
    console.log(`    ✓ Spot leg PnL:  ${state.spotPricePnL}`);
    console.log(`    ✓ Short leg PnL: ${state.shortPricePnL}`);
  });

  // ── Step 5: Time Passes (30 days) ──────────────────────────────────────────

  it("Step 5: 30 days pass — funding income accrues", async () => {
    await time.increase(ONE_DAY * 30);

    // Accrue funding checkpoint
    await engine.accrueFunding(await vault.getAddress());

    const pos = await engine.getPosition(await vault.getAddress());
    // 3 bps/day × 30 days × $40 000 notional = $360
    expect(pos.cumulativeFunding).to.be.greaterThan(0n);
    console.log(`    ✓ Cumulative funding income: $${Number(pos.cumulativeFunding) / 1e6}`);

    // User value: proportional share of vault
    const aliceValue = await vault.getUserValue(alice.address);
    console.log(`    ✓ Alice's vault value: $${Number(aliceValue) / 1e6}`);
  });

  // ── Step 6: Margin Check ───────────────────────────────────────────────────

  it("Step 6: Margin ratio remains healthy with flat ETH price", async () => {
    const marginRatio    = await engine.getMarginRatio(await vault.getAddress());
    const isLiquidatable = await engine.isLiquidatable(await vault.getAddress());

    expect(isLiquidatable).to.be.false;
    expect(marginRatio).to.be.greaterThanOrEqual(2_000n);
    console.log(`    ✓ Margin ratio: ${marginRatio} bps — healthy`);
  });

  // ── Step 7: Close Position ─────────────────────────────────────────────────

  it("Step 7: Owner closes position and receives proceeds including funding", async () => {
    const vaultBalBefore = await usdc.balanceOf(await vault.getAddress());
    await vault.connect(owner).closeHedge();
    const vaultBalAfter  = await usdc.balanceOf(await vault.getAddress());

    expect(await vault.hedgeIsOpen()).to.be.false;
    expect(await vault.spotAllocationUsdc()).to.equal(0n);
    // Vault should have more USDC than before (funding income returned with collateral)
    expect(vaultBalAfter).to.be.greaterThan(vaultBalBefore);
    console.log(`    ✓ Position closed | USDC profit returned: $${Number(vaultBalAfter - vaultBalBefore) / 1e6}`);
  });

  // ── Step 8: Withdraw ───────────────────────────────────────────────────────

  it("Step 8: Alice withdraws and receives more than her deposit (funding income)", async () => {
    const aliceBefore = await usdc.balanceOf(alice.address);
    const aliceInfo   = await vault.userInfo(alice.address);

    await vault.connect(alice).withdraw(aliceInfo.shares);

    const aliceAfter = await usdc.balanceOf(alice.address);
    const received   = aliceAfter - aliceBefore;

    // Alice's share = 50/80 = 62.5% of $360 funding ≈ $225 profit
    expect(received).to.be.greaterThan(50_000n * ONE_USDC);
    console.log(`    ✓ Alice received: $${Number(received) / 1e6} (deposited $50 000)`);
    console.log(`    ✓ Net funding carry: $${Number(received - 50_000n * ONE_USDC) / 1e6}`);
  });

  // ── Step 9: CARB Token ─────────────────────────────────────────────────────

  it("Step 9: CARB token is deployed and transferable", async () => {
    expect(await token.name()).to.equal("Crypto Arbitrage Token");
    expect(await token.symbol()).to.equal("CARB");
    expect(await token.totalSupply()).to.equal(10_000_000n * 10n ** 18n);

    await token.transfer(alice.address, 1_000n * 10n ** 18n);
    expect(await token.balanceOf(alice.address)).to.equal(1_000n * 10n ** 18n);
    console.log("    ✓ CARB token deployed and transfers working");
  });

  // ── Summary ────────────────────────────────────────────────────────────────

  it("Summary: vault state is clean after all users exit", async () => {
    const bobInfo = await vault.userInfo(bob.address);
    if (bobInfo.shares > 0n) {
      await vault.connect(bob).withdraw(bobInfo.shares);
    }

    const state = await vault.getVaultState();
    console.log("\n    ─── Final Vault State ───");
    console.log(`    totalDeposited   : $${Number(state.totalDeposited) / 1e6}`);
    console.log(`    hedgeIsOpen      : ${state.hedgeIsOpen}`);
    console.log(`    totalShares      : ${state.totalShares}`);
    console.log(`    spotAllocation   : $${Number(state.spotAllocationUsdc) / 1e6}`);
    console.log("    ─────────────────────────");
  });
});
