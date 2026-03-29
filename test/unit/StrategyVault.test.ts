import { ethers } from "hardhat";
import { expect } from "chai";
import {
  StrategyVault, MockPerpEngine, MockUSDC, MockPriceOracle
} from "../../typechain-types";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

describe("StrategyVault", () => {
  let vault: StrategyVault;
  let engine: MockPerpEngine;
  let usdc: MockUSDC;
  let oracle: MockPriceOracle;
  let owner: SignerWithAddress;
  let alice: SignerWithAddress;
  let bob: SignerWithAddress;

  const ETH_PRICE = 2_000n * 10n ** 18n;
  const ONE_USDC  = 10n ** 6n;

  async function deployAll() {
    [owner, alice, bob] = await ethers.getSigners();

    const USDC   = await ethers.getContractFactory("MockUSDC");
    usdc         = (await USDC.deploy(owner.address)) as unknown as MockUSDC;

    const Oracle = await ethers.getContractFactory("MockPriceOracle");
    oracle       = (await Oracle.deploy(owner.address, ETH_PRICE)) as unknown as MockPriceOracle;

    const Engine = await ethers.getContractFactory("MockPerpEngine");
    engine       = (await Engine.deploy(
      owner.address,
      await usdc.getAddress(),
      await oracle.getAddress()
    )) as unknown as MockPerpEngine;

    const Vault  = await ethers.getContractFactory("StrategyVault");
    vault        = (await Vault.deploy(
      owner.address,
      await usdc.getAddress(),
      await engine.getAddress(),
      await oracle.getAddress()
    )) as unknown as StrategyVault;

    // Transfer engine ownership to vault so vault can call openShort
    await engine.transferOwnership(await vault.getAddress());

    // Fund users
    await usdc.mint(alice.address, 50_000n * ONE_USDC);
    await usdc.mint(bob.address,   50_000n * ONE_USDC);

    await usdc.connect(alice).approve(await vault.getAddress(), ethers.MaxUint256);
    await usdc.connect(bob).approve(await vault.getAddress(),   ethers.MaxUint256);
  }

  beforeEach(deployAll);

  // ─── Deposit ──────────────────────────────────────────────────────────────

  describe("deposit", () => {
    it("accepts USDC and mints shares", async () => {
      const amount = 10_000n * ONE_USDC;
      await vault.connect(alice).deposit(amount);

      const info = await vault.userInfo(alice.address);
      expect(info.principal).to.equal(amount);
      expect(info.shares).to.be.greaterThan(0n);
    });

    it("transfers USDC from user to vault", async () => {
      const amount      = 10_000n * ONE_USDC;
      const aliceBefore = await usdc.balanceOf(alice.address);
      await vault.connect(alice).deposit(amount);
      const aliceAfter  = await usdc.balanceOf(alice.address);
      expect(aliceBefore - aliceAfter).to.equal(amount);
    });

    it("emits Deposited event", async () => {
      await expect(vault.connect(alice).deposit(5_000n * ONE_USDC))
        .to.emit(vault, "Deposited");
    });

    it("reverts on zero amount", async () => {
      await expect(
        vault.connect(alice).deposit(0n)
      ).to.be.revertedWith("StrategyVault: zero amount");
    });
  });

  // ─── Withdraw ─────────────────────────────────────────────────────────────

  describe("withdraw", () => {
    it("returns deposited USDC when no position is open", async () => {
      const amount = 10_000n * ONE_USDC;
      await vault.connect(alice).deposit(amount);

      const aliceBefore = await usdc.balanceOf(alice.address);
      const info        = await vault.userInfo(alice.address);
      await vault.connect(alice).withdraw(info.shares);
      const aliceAfter  = await usdc.balanceOf(alice.address);

      // Gets back exactly what she put in (no yield without open position)
      expect(aliceAfter - aliceBefore).to.equal(amount);
    });

    it("reverts when a position is open", async () => {
      await vault.connect(alice).deposit(20_000n * ONE_USDC);
      await vault.connect(owner).openHedge(
        10_000n * ONE_USDC,
        2_000n  * ONE_USDC,
        3n
      );

      const info = await vault.userInfo(alice.address);
      await expect(
        vault.connect(alice).withdraw(info.shares)
      ).to.be.revertedWith("StrategyVault: hedge is open, close first");
    });
  });

  // ─── openHedge ────────────────────────────────────────────────────────────

  describe("openHedge", () => {
    beforeEach(async () => {
      await vault.connect(alice).deposit(20_000n * ONE_USDC);
    });

    it("opens position when carry score is viable", async () => {
      // benchmark=200, funding=3 bps/day, cost=50 → score = 1095-200-50 = 845
      // threshold at 5x leverage = 50 + 5*75 = 425; 845 > 425 ✓
      await vault.connect(owner).openHedge(
        10_000n * ONE_USDC,
        2_000n  * ONE_USDC,
        3n
      );
      expect(await vault.hedgeIsOpen()).to.be.true;
    });

    it("records spot allocation equal to notional", async () => {
      await vault.connect(owner).openHedge(
        10_000n * ONE_USDC,
        2_000n  * ONE_USDC,
        3n
      );
      expect(await vault.spotAllocationUsdc()).to.equal(10_000n * ONE_USDC);
    });

    it("records entry price from oracle", async () => {
      await vault.connect(owner).openHedge(
        10_000n * ONE_USDC,
        2_000n  * ONE_USDC,
        3n
      );
      expect(await vault.hedgeEntryPrice()).to.equal(ETH_PRICE);
    });

    it("reverts when funding rate makes carry score too low", async () => {
      // benchmark=200, funding=-10 bps/day, cost=50 → score = -3650-250 = -3900 < threshold
      await expect(
        vault.connect(owner).openHedge(
          10_000n * ONE_USDC,
          2_000n  * ONE_USDC,
          -10n
        )
      ).to.be.revertedWith("StrategyVault: carry score below dynamic threshold");
    });

    it("reverts when called by non-owner", async () => {
      await expect(
        vault.connect(alice).openHedge(10_000n * ONE_USDC, 2_000n * ONE_USDC, 3n)
      ).to.be.revertedWithCustomError(vault, "OwnableUnauthorizedAccount");
    });

    it("emits HedgeOpened event", async () => {
      await expect(
        vault.connect(owner).openHedge(10_000n * ONE_USDC, 2_000n * ONE_USDC, 3n)
      ).to.emit(vault, "HedgeOpened");
    });
  });

  // ─── closeHedge ───────────────────────────────────────────────────────────

  describe("closeHedge", () => {
    beforeEach(async () => {
      await vault.connect(alice).deposit(20_000n * ONE_USDC);
      await vault.connect(owner).openHedge(10_000n * ONE_USDC, 2_000n * ONE_USDC, 3n);
    });

    it("closes position and clears state", async () => {
      await vault.connect(owner).closeHedge();
      expect(await vault.hedgeIsOpen()).to.be.false;
      expect(await vault.spotAllocationUsdc()).to.equal(0n);
      expect(await vault.hedgeEntryPrice()).to.equal(0n);
    });

    it("returns USDC proceeds to vault", async () => {
      const balBefore = await usdc.balanceOf(await vault.getAddress());
      await vault.connect(owner).closeHedge();
      const balAfter  = await usdc.balanceOf(await vault.getAddress());
      expect(balAfter).to.be.greaterThanOrEqual(balBefore);
    });

    it("reverts when no position is open", async () => {
      await vault.connect(owner).closeHedge();
      await expect(
        vault.connect(owner).closeHedge()
      ).to.be.revertedWith("StrategyVault: no open hedge");
    });

    it("reverts when called by non-owner", async () => {
      await expect(
        vault.connect(alice).closeHedge()
      ).to.be.revertedWithCustomError(vault, "OwnableUnauthorizedAccount");
    });
  });

  // ─── getVaultState ────────────────────────────────────────────────────────

  describe("getVaultState", () => {
    it("returns correct state with no deposits", async () => {
      const state = await vault.getVaultState();
      expect(state.totalDeposited).to.equal(0n);
      expect(state.hedgeIsOpen).to.be.false;
      expect(state.spotAllocationUsdc).to.equal(0n);
    });

    it("reflects deposits in totalDeposited", async () => {
      await vault.connect(alice).deposit(10_000n * ONE_USDC);
      const state = await vault.getVaultState();
      expect(state.totalDeposited).to.equal(10_000n * ONE_USDC);
    });

    it("reports netDeltaPnL ≈ 0 when price is unchanged (delta-neutral)", async () => {
      await vault.connect(alice).deposit(20_000n * ONE_USDC);
      await vault.connect(owner).openHedge(10_000n * ONE_USDC, 2_000n * ONE_USDC, 3n);

      // ETH price unchanged at entry price → spot PnL + short PnL = 0
      const state = await vault.getVaultState();
      expect(state.netDeltaPnL).to.equal(0n);
    });
  });

  // ─── isCarryViable ────────────────────────────────────────────────────────

  describe("isCarryViable", () => {
    it("returns true when funding exceeds benchmark and costs", async () => {
      // benchmark=200, funding=3 bps/day, cost=50 → score = 845 > 0
      expect(await vault.isCarryViable(3n)).to.be.true;
    });

    it("returns false for negative funding rate", async () => {
      // benchmark=200, funding=-10 bps/day, cost=50 → score = -3900 < 0
      expect(await vault.isCarryViable(-10n)).to.be.false;
    });
  });
});
