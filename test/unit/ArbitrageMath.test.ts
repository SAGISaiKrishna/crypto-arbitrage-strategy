import { ethers } from "hardhat";
import { expect } from "chai";
import { ArbitrageMathHarness } from "../../typechain-types";

const USDC_DEC  = 6n;
const PRICE_DEC = 18n;
const ONE_USDC  = 10n ** USDC_DEC;
const ONE_DAY   = 86_400n;

describe("ArbitrageMath", () => {
  let math: ArbitrageMathHarness;

  before(async () => {
    const Factory = await ethers.getContractFactory("ArbitrageMathHarness");
    math = (await Factory.deploy()) as unknown as ArbitrageMathHarness;
    await math.waitForDeployment();
  });

  // ─── Spot Leg P&L ─────────────────────────────────────────────────────────
  // Long spot: profits when ETH rises, loses when ETH falls.
  // In the delta-neutral pair, this cancels with calcShortPricePnL.

  describe("calcSpotPnL", () => {
    it("returns profit when ETH price rises (long wins)", async () => {
      // $10 000 allocation, entry $2 000, current $2 200 → +$1 000 profit
      const allocation   = 10_000n * ONE_USDC;
      const entryPrice   = 2_000n * 10n ** PRICE_DEC;
      const currentPrice = 2_200n * 10n ** PRICE_DEC;

      const pnl = await math.calcSpotPnL(allocation, entryPrice, currentPrice);
      // 10000 * (2200 - 2000) / 2000 = 10000 * 200/2000 = 1000 USDC
      expect(pnl).to.equal(1_000n * ONE_USDC);
    });

    it("returns loss when ETH price falls (long loses)", async () => {
      const allocation   = 10_000n * ONE_USDC;
      const entryPrice   = 2_000n * 10n ** PRICE_DEC;
      const currentPrice = 1_800n * 10n ** PRICE_DEC;

      const pnl = await math.calcSpotPnL(allocation, entryPrice, currentPrice);
      expect(pnl).to.equal(-1_000n * ONE_USDC);
    });

    it("returns zero when price is unchanged", async () => {
      const price = 2_000n * 10n ** PRICE_DEC;
      expect(await math.calcSpotPnL(10_000n * ONE_USDC, price, price)).to.equal(0n);
    });

    it("spot PnL exactly cancels short PnL at equal notional (delta-neutral)", async () => {
      const notional     = 10_000n * ONE_USDC;
      const entryPrice   = 2_000n * 10n ** PRICE_DEC;
      const currentPrice = 2_500n * 10n ** PRICE_DEC;

      const spotPnl  = await math.calcSpotPnL(notional, entryPrice, currentPrice);
      const shortPnl = await math.calcShortPricePnL(notional, entryPrice, currentPrice);
      // Net delta = 0
      expect(spotPnl + shortPnl).to.equal(0n);
    });
  });

  // ─── Short Perp Leg P&L ───────────────────────────────────────────────────

  describe("calcShortPricePnL", () => {
    it("returns profit when ETH price falls (short wins)", async () => {
      const notional     = 10_000n * ONE_USDC;
      const entryPrice   = 2_000n * 10n ** PRICE_DEC;
      const currentPrice = 1_800n * 10n ** PRICE_DEC;

      const pnl = await math.calcShortPricePnL(notional, entryPrice, currentPrice);
      expect(pnl).to.equal(1_000n * ONE_USDC);
    });

    it("returns loss when ETH price rises (short loses)", async () => {
      const notional     = 10_000n * ONE_USDC;
      const entryPrice   = 2_000n * 10n ** PRICE_DEC;
      const currentPrice = 2_200n * 10n ** PRICE_DEC;

      const pnl = await math.calcShortPricePnL(notional, entryPrice, currentPrice);
      expect(pnl).to.equal(-1_000n * ONE_USDC);
    });

    it("returns zero when price is unchanged", async () => {
      const price = 2_000n * 10n ** PRICE_DEC;
      expect(await math.calcShortPricePnL(10_000n * ONE_USDC, price, price)).to.equal(0n);
    });
  });

  // ─── Funding Payment ──────────────────────────────────────────────────────

  describe("calcFundingPayment", () => {
    it("returns positive funding in contango (daily rate 3 bps for 1 day)", async () => {
      const notional = 10_000n * ONE_USDC; // $10 000
      // 3 bps/day on $10 000 = $3
      const payment = await math.calcFundingPayment(notional, 3n, ONE_DAY);
      expect(payment).to.equal(3n * ONE_USDC);
    });

    it("returns negative funding in backwardation", async () => {
      const notional = 10_000n * ONE_USDC;
      const payment  = await math.calcFundingPayment(notional, -2n, ONE_DAY);
      expect(payment).to.equal(-2n * ONE_USDC);
    });

    it("returns zero for zero elapsed time", async () => {
      const payment = await math.calcFundingPayment(10_000n * ONE_USDC, 3n, 0n);
      expect(payment).to.equal(0n);
    });
  });

  // ─── Margin Ratio ─────────────────────────────────────────────────────────

  describe("calcMarginRatio", () => {
    it("returns correct ratio with no PnL", async () => {
      // 2000 collateral / 10000 notional = 20% = 2000 bps
      const ratio = await math.calcMarginRatio(
        2_000n * ONE_USDC, 0n, 10_000n * ONE_USDC
      );
      expect(ratio).to.equal(2_000n);
    });

    it("decreases when unrealised loss reduces equity", async () => {
      const ratio = await math.calcMarginRatio(
        2_000n * ONE_USDC,
        -(500n * ONE_USDC),
        10_000n * ONE_USDC
      );
      // (2000 - 500) / 10000 = 15% = 1500 bps
      expect(ratio).to.equal(1_500n);
    });

    it("returns 0 when equity is zero or negative", async () => {
      const ratio = await math.calcMarginRatio(
        500n * ONE_USDC,
        -(500n * ONE_USDC),
        10_000n * ONE_USDC
      );
      expect(ratio).to.equal(0n);
    });
  });

  // ─── Carry Score ──────────────────────────────────────────────────────────
  // Formula: (dailyFunding × 365) − benchmarkRate − costs

  describe("calcCarryScore", () => {
    it("returns positive score when funding exceeds benchmark and costs", async () => {
      // benchmark=200, funding=3 bps/day, cost=50
      // score = 3*365 - 200 - 50 = 1095 - 250 = 845 bps
      const score = await math.calcCarryScore(200n, 3n, 50n);
      expect(score).to.equal(845n);
    });

    it("returns negative score in backwardation", async () => {
      // benchmark=200, funding=-5 bps/day, cost=300
      // score = -5*365 - 200 - 300 = -1825 - 500 = -2325
      const score = await math.calcCarryScore(200n, -5n, 300n);
      expect(score).to.equal(-2_325n);
    });

    it("score is zero when funding exactly covers benchmark and costs", async () => {
      // benchmark=200, cost=50: need funding × 365 = 250 → funding = ~0.685 bps/day
      // At 1 bps/day: 1*365 - 200 - 50 = 365 - 250 = 115 (positive)
      const score = await math.calcCarryScore(200n, 1n, 165n);
      expect(score).to.equal(0n); // 365 - 200 - 165 = 0
    });
  });

  // ─── isCarryViable ────────────────────────────────────────────────────────

  describe("isCarryViable", () => {
    it("returns true when score exceeds threshold", async () => {
      expect(await math.isCarryViable(500n, 200n)).to.be.true;
    });

    it("returns false when score is below threshold", async () => {
      expect(await math.isCarryViable(100n, 200n)).to.be.false;
    });

    it("returns false when score equals threshold (strict inequality)", async () => {
      expect(await math.isCarryViable(200n, 200n)).to.be.false;
    });
  });

  // ─── Break-Even ───────────────────────────────────────────────────────────

  describe("calcBreakEvenDays", () => {
    it("calculates correct break-even days", async () => {
      // Entry cost $100, daily yield $10 → 10 days
      const days = await math.calcBreakEvenDays(
        100n * ONE_USDC,
        10n  * ONE_USDC
      );
      expect(days).to.equal(10n);
    });

    it("returns max uint256 when daily yield is zero", async () => {
      const days = await math.calcBreakEvenDays(100n * ONE_USDC, 0n);
      expect(days).to.equal(ethers.MaxUint256);
    });
  });
});

