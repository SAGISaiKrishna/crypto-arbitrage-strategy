import { ethers } from "hardhat";
import { expect } from "chai";
import { MockPerpEngine, MockUSDC, MockPriceOracle } from "../../typechain-types";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { time } from "@nomicfoundation/hardhat-network-helpers";

describe("MockPerpEngine", () => {
  let engine: MockPerpEngine;
  let usdc: MockUSDC;
  let oracle: MockPriceOracle;
  let owner: SignerWithAddress;
  let trader: SignerWithAddress;

  const ETH_PRICE  = 2_000n * 10n ** 18n; // $2 000
  const ONE_USDC   = 10n ** 6n;
  const ONE_DAY    = 86_400;

  const NOTIONAL   = 10_000n * ONE_USDC;  // $10 000
  const COLLATERAL = 2_000n * ONE_USDC;   // $2 000 (20% margin)

  beforeEach(async () => {
    [owner, trader] = await ethers.getSigners();

    // Deploy dependencies
    const USDC = await ethers.getContractFactory("MockUSDC");
    usdc = (await USDC.deploy(owner.address)) as unknown as MockUSDC;

    const Oracle = await ethers.getContractFactory("MockPriceOracle");
    oracle = (await Oracle.deploy(owner.address, ETH_PRICE)) as unknown as MockPriceOracle;

    const Engine = await ethers.getContractFactory("MockPerpEngine");
    engine = (await Engine.deploy(
      owner.address,
      await usdc.getAddress(),
      await oracle.getAddress()
    )) as unknown as MockPerpEngine;

    // Fund trader and approve engine
    await usdc.mint(trader.address, 100_000n * ONE_USDC);
    await usdc.connect(trader).approve(await engine.getAddress(), ethers.MaxUint256);
  });

  // ─── Open Short ─────────────────────────────────────────────────────────────

  describe("openShort", () => {
    it("opens a short position and records correct state", async () => {
      await engine.connect(trader).openShort(NOTIONAL, COLLATERAL);

      const pos = await engine.getPosition(trader.address);
      expect(pos.isOpen).to.be.true;
      expect(pos.notional).to.equal(NOTIONAL);
      expect(pos.collateral).to.equal(COLLATERAL);
      expect(pos.entryPrice).to.equal(ETH_PRICE);
      expect(pos.cumulativeFunding).to.equal(0n);
    });

    it("transfers collateral USDC from trader to engine", async () => {
      const traderBefore = await usdc.balanceOf(trader.address);
      await engine.connect(trader).openShort(NOTIONAL, COLLATERAL);
      const traderAfter = await usdc.balanceOf(trader.address);
      expect(traderBefore - traderAfter).to.equal(COLLATERAL);
    });

    it("emits PositionOpened event", async () => {
      await expect(engine.connect(trader).openShort(NOTIONAL, COLLATERAL))
        .to.emit(engine, "PositionOpened")
        .withArgs(
          trader.address,
          NOTIONAL,
          COLLATERAL,
          ETH_PRICE,
          await time.latest() + 1
        );
    });

    it("reverts if position already open", async () => {
      await engine.connect(trader).openShort(NOTIONAL, COLLATERAL);
      await expect(
        engine.connect(trader).openShort(NOTIONAL, COLLATERAL)
      ).to.be.revertedWith("MockPerpEngine: position already open");
    });

    it("reverts if notional is zero", async () => {
      await expect(
        engine.connect(trader).openShort(0n, COLLATERAL)
      ).to.be.revertedWith("MockPerpEngine: zero notional");
    });
  });

  // ─── Funding ────────────────────────────────────────────────────────────────

  describe("funding accrual", () => {
    it("accrues positive funding after 1 day in contango", async () => {
      await engine.connect(trader).openShort(NOTIONAL, COLLATERAL);
      await time.increase(ONE_DAY);
      await engine.accrueFunding(trader.address);

      const pos = await engine.getPosition(trader.address);
      // 3 bps/day on $10 000 = $3 = 3e6 USDC
      expect(pos.cumulativeFunding).to.equal(3n * ONE_USDC);
    });

    it("accrues negative funding in backwardation", async () => {
      await engine.setDailyFundingRateBps(-2n);
      await engine.connect(trader).openShort(NOTIONAL, COLLATERAL);
      await time.increase(ONE_DAY);
      await engine.accrueFunding(trader.address);

      const pos = await engine.getPosition(trader.address);
      expect(pos.cumulativeFunding).to.equal(-2n * ONE_USDC);
    });
  });

  // ─── Margin & Health ────────────────────────────────────────────────────────

  describe("margin ratio and liquidation", () => {
    it("returns correct initial margin ratio", async () => {
      await engine.connect(trader).openShort(NOTIONAL, COLLATERAL);
      // 2000/10000 = 20% = 2000 bps
      expect(await engine.getMarginRatio(trader.address)).to.equal(2_000n);
    });

    it("is not liquidatable at initial margin", async () => {
      await engine.connect(trader).openShort(NOTIONAL, COLLATERAL);
      expect(await engine.isLiquidatable(trader.address)).to.be.false;
    });

    it("becomes liquidatable when ETH price rises enough", async () => {
      await engine.connect(trader).openShort(NOTIONAL, COLLATERAL);
      // If ETH goes to $3 800, short loses $9 000 on $10 000 notional
      // equity = 2000 - 9000 = negative → liquidatable
      await oracle.setPrice(3_800n * 10n ** 18n);
      expect(await engine.isLiquidatable(trader.address)).to.be.true;
    });
  });

  // ─── Close Short ────────────────────────────────────────────────────────────

  describe("closeShort", () => {
    it("returns collateral + funding when price is unchanged", async () => {
      await engine.connect(trader).openShort(NOTIONAL, COLLATERAL);
      await time.increase(ONE_DAY * 10); // 10 days of funding

      const traderBefore = await usdc.balanceOf(trader.address);
      await engine.connect(trader).closeShort();
      const traderAfter = await usdc.balanceOf(trader.address);

      // Should receive ~2000 + 30 = $2030 USDC (3 bps/day × 10 days × $10 000)
      const received = traderAfter - traderBefore;
      expect(received).to.be.greaterThan(COLLATERAL);
    });

    it("returns less than collateral when ETH price rises (short loses)", async () => {
      await engine.connect(trader).openShort(NOTIONAL, COLLATERAL);
      await oracle.setPrice(2_100n * 10n ** 18n); // +5%, short loses $500

      const traderBefore = await usdc.balanceOf(trader.address);
      await engine.connect(trader).closeShort();
      const traderAfter = await usdc.balanceOf(trader.address);

      expect(traderAfter - traderBefore).to.be.lessThan(COLLATERAL);
    });

    it("clears position after closing", async () => {
      await engine.connect(trader).openShort(NOTIONAL, COLLATERAL);
      await engine.connect(trader).closeShort();
      const pos = await engine.getPosition(trader.address);
      expect(pos.isOpen).to.be.false;
    });

    it("reverts if no position open", async () => {
      await expect(
        engine.connect(trader).closeShort()
      ).to.be.revertedWith("MockPerpEngine: no open position");
    });
  });

  // ─── Admin ──────────────────────────────────────────────────────────────────

  describe("admin functions", () => {
    it("owner can update funding rate", async () => {
      await engine.setDailyFundingRateBps(5n);
      expect(await engine.dailyFundingRateBps()).to.equal(5n);
    });

    it("non-owner cannot update funding rate", async () => {
      await expect(
        engine.connect(trader).setDailyFundingRateBps(5n)
      ).to.be.revertedWithCustomError(engine, "OwnableUnauthorizedAccount");
    });
  });
});
