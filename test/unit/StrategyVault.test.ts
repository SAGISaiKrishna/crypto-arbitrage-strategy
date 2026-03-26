import { ethers } from "hardhat";
import { expect } from "chai";
import {
  StrategyVault, MockPerpEngine, MockUSDC, MockPriceOracle
} from "../../typechain-types";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { time } from "@nomicfoundation/hardhat-network-helpers";

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
  const ONE_DAY   = 86_400;

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

    // Approve vault to spend users' USDC
    await usdc.connect(alice).approve(await vault.getAddress(), ethers.MaxUint256);
    await usdc.connect(bob).approve(await vault.getAddress(),   ethers.MaxUint256);
  }

  beforeEach(deployAll);

  // ─── Deposit ────────────────────────────────────────────────────────────────

  describe("deposit", () => {
    it("accepts USDC and mints shares", async () => {
      const amount = 10_000n * ONE_USDC;
      await vault.connect(alice).deposit(amount);

      const info = await vault.userInfo(alice.address);
      expect(info.principal).to.equal(amount);
      expect(info.shares).to.be.greaterThan(0n);
    });

    it("transfers USDC from user to vault", async () => {
      const amount     = 10_000n * ONE_USDC;
      const aliceBefore = await usdc.balanceOf(alice.address);
      await vault.connect(alice).deposit(amount);
      const aliceAfter  = await usdc.balanceOf(alice.address);
      expect(aliceBefore - aliceAfter).to.equal(amount);
    });

    it("emits Deposited event", async () => {
      const amount = 5_000n * ONE_USDC;
      await expect(vault.connect(alice).deposit(amount))
        .to.emit(vault, "Deposited");
    });

    it("reverts on zero amount", async () => {
      await expect(
        vault.connect(alice).deposit(0n)
      ).to.be.revertedWith("StrategyVault: zero amount");
    });
  });

  // ─── Withdraw ────────────────────────────────────────────────────────────────

  describe("withdraw", () => {
    it("returns USDC plus lending yield after holding period", async () => {
      const amount = 10_000n * ONE_USDC;
      await vault.connect(alice).deposit(amount);

      await time.increase(ONE_DAY * 365); // fast-forward 1 year

      const aliceBefore = await usdc.balanceOf(alice.address);
      const info        = await vault.userInfo(alice.address);
      await vault.connect(alice).withdraw(info.shares);
      const aliceAfter  = await usdc.balanceOf(alice.address);

      const received = aliceAfter - aliceBefore;
      // Should receive more than deposited due to lending yield
      expect(received).to.be.greaterThan(amount);
    });

    it("reverts when hedge is open", async () => {
      const depositAmount = 20_000n * ONE_USDC;
      await vault.connect(alice).deposit(depositAmount);

      // Owner opens hedge
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

  // ─── openHedge / closeHedge ──────────────────────────────────────────────────

  describe("openHedge", () => {
    beforeEach(async () => {
      // Deposit enough USDC to cover hedge collateral
      await vault.connect(alice).deposit(20_000n * ONE_USDC);
    });

    it("opens hedge when carry score is viable", async () => {
      // carryScore = 500 + 3*365 - 50 = 1545 bps > 200 threshold
      await vault.connect(owner).openHedge(
        10_000n * ONE_USDC,
        2_000n  * ONE_USDC,
        3n
      );
      expect(await vault.hedgeIsOpen()).to.be.true;
    });

    it("reverts when funding rate makes carry score too low", async () => {
      // With funding = -10 bps/day: 500 + (-10*365) - 50 = -3200 bps < 200 threshold
      await expect(
        vault.connect(owner).openHedge(
          10_000n * ONE_USDC,
          2_000n  * ONE_USDC,
          -10n
        )
      ).to.be.revertedWith("StrategyVault: carry score below threshold");
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

  describe("closeHedge", () => {
    beforeEach(async () => {
      await vault.connect(alice).deposit(20_000n * ONE_USDC);
      await vault.connect(owner).openHedge(10_000n * ONE_USDC, 2_000n * ONE_USDC, 3n);
    });

    it("closes hedge and sets hedgeIsOpen to false", async () => {
      await vault.connect(owner).closeHedge();
      expect(await vault.hedgeIsOpen()).to.be.false;
    });

    it("returns USDC proceeds to vault", async () => {
      const balBefore = await usdc.balanceOf(await vault.getAddress());
      await vault.connect(owner).closeHedge();
      const balAfter  = await usdc.balanceOf(await vault.getAddress());
      // Should have more or equal USDC (proceeds include funding + any price movement)
      expect(balAfter).to.be.greaterThanOrEqual(balBefore);
    });

    it("reverts when no hedge is open", async () => {
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

  // ─── View functions ──────────────────────────────────────────────────────────

  describe("isCarryViable", () => {
    it("returns true for favourable funding rate", async () => {
      // 3 bps/day: score = 500 + 1095 - 50 = 1545 > 200
      expect(await vault.isCarryViable(3n)).to.be.true;
    });

    it("returns false for sufficiently negative funding rate", async () => {
      expect(await vault.isCarryViable(-10n)).to.be.false;
    });
  });

  describe("getVaultState", () => {
    it("returns correct state with no deposits", async () => {
      const state = await vault.getVaultState();
      expect(state.totalDeposited).to.equal(0n);
      expect(state.hedgeIsOpen).to.be.false;
    });

    it("reflects deposits in totalDeposited", async () => {
      await vault.connect(alice).deposit(10_000n * ONE_USDC);
      const state = await vault.getVaultState();
      expect(state.totalDeposited).to.equal(10_000n * ONE_USDC);
    });
  });
});
