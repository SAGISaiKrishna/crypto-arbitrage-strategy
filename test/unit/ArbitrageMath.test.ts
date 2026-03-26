import { ethers } from "hardhat";
import { expect } from "chai";
import { ArbitrageMathHarness } from "../../typechain-types";

// ─── Constants ────────────────────────────────────────────────────────────────
const USDC_DEC  = 6n;
const PRICE_DEC = 18n;
const ONE_USDC  = 10n ** USDC_DEC;         // 1 USDC
const ONE_DAY   = 86_400n;                 // seconds

describe("ArbitrageMath", () => {
  let math: ArbitrageMathHarness;

  before(async () => {
    const Factory = await ethers.getContractFactory("ArbitrageMathHarness");
    math = (await Factory.deploy()) as unknown as ArbitrageMathHarness;
    await math.waitForDeployment();
  });

  // ─── Short Price PnL ────────────────────────────────────────────────────────

  describe("calcShortPricePnL", () => {
    it("returns profit when ETH price falls (short wins)", async () => {
      // $10 000 notional, entry $2 000, current $1 800 → +$1 000 profit
      const notional     = 10_000n * ONE_USDC;
      const entryPrice   = 2_000n * 10n ** PRICE_DEC;
      const currentPrice = 1_800n * 10n ** PRICE_DEC;

      const pnl = await math.calcShortPricePnL(notional, entryPrice, currentPrice);
      // notional * (2000 - 1800) / 2000 = 10000 * 200/2000 = 1000 USDC
      expect(pnl).to.equal(1_000n * ONE_USDC);
    });

    it("returns loss when ETH price rises (short loses)", async () => {
      const notional     = 10_000n * ONE_USDC;
      const entryPrice   = 2_000n * 10n ** PRICE_DEC;
      const currentPrice = 2_200n * 10n ** PRICE_DEC;

      const pnl = await math.calcShortPricePnL(notional, entryPrice, currentPrice);
      // notional * (2200 - 2000) / 2000 = 10000 * 200/2000 = -1000 USDC
      expect(pnl).to.equal(-1_000n * ONE_USDC);
    });

    it("returns zero when price is unchanged", async () => {
      const notional = 10_000n * ONE_USDC;
      const price    = 2_000n * 10n ** PRICE_DEC;
      expect(await math.calcShortPricePnL(notional, price, price)).to.equal(0n);
    });
  });

  // ─── Funding Payment ────────────────────────────────────────────────────────

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

  // ─── Lending Yield ──────────────────────────────────────────────────────────

  describe("calcLendingYield", () => {
    it("accrues correct yield over 365 days at 5% APY", async () => {
      const principal = 10_000n * ONE_USDC;  // $10 000
      const apyBps    = 500n;                 // 5 %
      const elapsed   = 365n * ONE_DAY;       // full year

      const yield_ = await math.calcLendingYield(principal, apyBps, elapsed);
      // 10 000 * 5% = 500 USDC
      expect(yield_).to.equal(500n * ONE_USDC);
    });

    it("yields proportionally less for partial year", async () => {
      const principal = 10_000n * ONE_USDC;
      const apyBps    = 500n;
      const elapsed   = (365n * ONE_DAY) / 2n; // 182.5 days

      const yield_ = await math.calcLendingYield(principal, apyBps, elapsed);
      expect(yield_).to.be.approximately(250n * ONE_USDC, ONE_USDC);
    });

    it("returns zero for zero elapsed time", async () => {
      expect(
        await math.calcLendingYield(10_000n * ONE_USDC, 500n, 0n)
      ).to.equal(0n);
    });
  });

  // ─── Margin Ratio ───────────────────────────────────────────────────────────

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
        -(500n * ONE_USDC), // $500 loss
        10_000n * ONE_USDC
      );
      // (2000 - 500) / 10000 = 15% = 1500 bps
      expect(ratio).to.equal(1_500n);
    });

    it("returns 0 when equity is zero or negative", async () => {
      const ratio = await math.calcMarginRatio(
        500n * ONE_USDC,
        -(500n * ONE_USDC), // equity = 0
        10_000n * ONE_USDC
      );
      expect(ratio).to.equal(0n);
    });
  });

  // ─── Carry Score ────────────────────────────────────────────────────────────

  describe("calcCarryScore", () => {
    it("returns positive score in favourable conditions", async () => {
      // 500 lending + 3*365 funding - 50 cost = 500 + 1095 - 50 = 1545 bps
      const score = await math.calcCarryScore(500n, 3n, 50n);
      expect(score).to.equal(1_545n);
    });

    it("returns negative score in backwardation with high costs", async () => {
      const score = await math.calcCarryScore(200n, -5n, 300n);
      // 200 + (-5*365) - 300 = 200 - 1825 - 300 = -1925
      expect(score).to.equal(-1_925n);
    });
  });

  // ─── isCarryViable ──────────────────────────────────────────────────────────

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

  // ─── Break-Even ─────────────────────────────────────────────────────────────

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

// Chai approximate helper (within `delta`)
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Chai {
    interface Assertion {
      approximately(expected: bigint, delta: bigint): void;
    }
  }
}
