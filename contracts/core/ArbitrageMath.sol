// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title ArbitrageMath
/// @notice Pure math library for the delta-neutral ETH carry strategy.
///         All financial formulas live here so they can be tested independently.
///
///         Strategy context:
///           The vault holds a LONG ETH spot exposure (via USDC allocation)
///           and a SHORT ETH perpetual futures position. These two legs
///           approximately cancel each other's price risk (delta-neutral).
///           The net income is the perpetual funding rate, less a benchmark
///           opportunity cost (e.g. stablecoin yield / T-bill rate).
///
///         Unit convention (must be consistent across callers):
///           - USDC amounts    : uint256 / int256,  6 decimals  (1 USDC = 1e6)
///           - ETH/USD prices  : uint256,           18 decimals ($2 000 = 2_000e18)
///           - Rates           : basis points (bps) where 1 bps = 0.01%
///           - Time            : seconds (block.timestamp)
library ArbitrageMath {

    // ─── Spot Leg P&L ─────────────────────────────────────────────────────────

    /// @notice Unrealised P&L on a long ETH spot allocation.
    /// @dev    Positive when ETH price rises (long profits), negative when it falls.
    ///         In the delta-neutral strategy this cancels with the short perp P&L.
    ///
    ///         Formula: allocation × (currentPrice − entryPrice) / entryPrice
    ///
    /// @param spotAllocation  USDC value of ETH spot exposure, 6 decimals
    /// @param entryPrice      ETH/USD at position open, 18 decimals
    /// @param currentPrice    Current ETH/USD, 18 decimals
    /// @return pnl            Signed USDC value, 6 decimals
    function calcSpotPnL(
        uint256 spotAllocation,
        uint256 entryPrice,
        uint256 currentPrice
    ) internal pure returns (int256 pnl) {
        require(entryPrice > 0, "ArbitrageMath: zero entry price");
        if (currentPrice >= entryPrice) {
            uint256 profit = (spotAllocation * (currentPrice - entryPrice)) / entryPrice;
            pnl = int256(profit);
        } else {
            uint256 loss = (spotAllocation * (entryPrice - currentPrice)) / entryPrice;
            pnl = -int256(loss);
        }
    }

    // ─── Short Perp Leg P&L ───────────────────────────────────────────────────

    /// @notice Unrealised P&L on the short ETH perpetual position (price component only).
    /// @dev    Positive when ETH price falls (short profits), negative when it rises.
    ///         Combined with calcSpotPnL, the net delta is approximately zero.
    ///
    ///         Formula: notional × (entryPrice − currentPrice) / entryPrice
    ///
    /// @param notional      Short position notional in USDC, 6 decimals
    /// @param entryPrice    ETH/USD at position open, 18 decimals
    /// @param currentPrice  Current ETH/USD, 18 decimals
    /// @return pnl          Signed USDC value, 6 decimals
    function calcShortPricePnL(
        uint256 notional,
        uint256 entryPrice,
        uint256 currentPrice
    ) internal pure returns (int256 pnl) {
        require(entryPrice > 0, "ArbitrageMath: zero entry price");
        if (currentPrice >= entryPrice) {
            uint256 loss = (notional * (currentPrice - entryPrice)) / entryPrice;
            pnl = -int256(loss);
        } else {
            uint256 profit = (notional * (entryPrice - currentPrice)) / entryPrice;
            pnl = int256(profit);
        }
    }

    // ─── Funding Income ───────────────────────────────────────────────────────

    /// @notice Funding payment accrued on the short position over `elapsedSeconds`.
    /// @dev    Positive = shorts receive from longs (contango, funding rate > 0).
    ///         Negative = shorts pay to longs (backwardation, funding rate < 0).
    ///         This is the primary income source of the delta-neutral strategy.
    ///
    ///         Formula: notional × dailyFundingRateBps × elapsedSeconds
    ///                  ─────────────────────────────────────────────────
    ///                           10 000 × 86 400
    ///
    /// @param notional              Position notional, USDC 6 decimals
    /// @param dailyFundingRateBps   Signed daily rate in bps (e.g. 3 = 0.03 %/day)
    /// @param elapsedSeconds        Seconds since last funding checkpoint
    /// @return payment              Signed USDC, 6 decimals
    function calcFundingPayment(
        uint256 notional,
        int256  dailyFundingRateBps,
        uint256 elapsedSeconds
    ) internal pure returns (int256 payment) {
        payment =
            (int256(notional) * dailyFundingRateBps * int256(elapsedSeconds)) /
            (10_000 * 86_400);
    }

    // ─── Margin & Health ──────────────────────────────────────────────────────

    /// @notice Margin ratio = (collateral + unrealisedPnL) / notional, in bps.
    /// @dev    Returns 0 when equity is zero or negative (critically undercollateralised).
    ///         Returns type(uint256).max when notional is 0 (no position open).
    ///
    /// @param collateral      Margin posted, USDC 6 decimals
    /// @param unrealizedPnL   Signed unrealised P&L, USDC 6 decimals
    /// @param notional        Position notional, USDC 6 decimals
    /// @return ratioBps       Margin ratio in basis points
    function calcMarginRatio(
        uint256 collateral,
        int256  unrealizedPnL,
        uint256 notional
    ) internal pure returns (uint256 ratioBps) {
        if (notional == 0) return type(uint256).max;
        int256 equity = int256(collateral) + unrealizedPnL;
        if (equity <= 0) return 0;
        ratioBps = (uint256(equity) * 10_000) / notional;
    }

    /// @notice Health factor scaled to 1e18.
    ///         > 1e18 = safe,  < 1e18 = liquidatable.
    ///
    /// @param marginRatioBps        Current margin ratio in bps
    /// @param maintenanceMarginBps  Minimum required margin ratio in bps
    function calcHealthFactor(
        uint256 marginRatioBps,
        uint256 maintenanceMarginBps
    ) internal pure returns (uint256 healthFactor) {
        if (maintenanceMarginBps == 0) return type(uint256).max;
        healthFactor = (marginRatioBps * 1e18) / maintenanceMarginBps;
    }

    // ─── Carry Score ──────────────────────────────────────────────────────────

    /// @notice Annualised carry score in basis points.
    ///         Measures how much the funding rate exceeds the benchmark opportunity cost.
    ///         Positive means it is worth entering the position.
    ///
    ///         Formula: (dailyFundingRateBps × 365) − benchmarkRateBps − costBps
    ///
    ///         Where:
    ///           dailyFundingRateBps = daily funding (e.g. 3 = 0.03 %/day → 1 095 bps/year)
    ///           benchmarkRateBps    = baseline return foregone (e.g. 200 = 2 % stablecoin yield)
    ///           costBps             = estimated round-trip execution cost
    ///
    /// @param benchmarkRateBps      Annual benchmark rate in bps (e.g. 200 = 2%)
    /// @param dailyFundingRateBps   Signed daily funding in bps
    /// @param costBps               Annual cost estimate in bps
    /// @return score                Signed annualised carry score in bps
    function calcCarryScore(
        uint256 benchmarkRateBps,
        int256  dailyFundingRateBps,
        uint256 costBps
    ) internal pure returns (int256 score) {
        int256 annualizedFunding = dailyFundingRateBps * 365;
        score = annualizedFunding - int256(benchmarkRateBps) - int256(costBps);
    }

    /// @notice Returns true if the carry score exceeds the minimum threshold.
    function isCarryViable(
        int256 carryScore,
        int256 minThresholdBps
    ) internal pure returns (bool viable) {
        viable = carryScore > minThresholdBps;
    }

    // ─── Break-Even ───────────────────────────────────────────────────────────

    /// @notice Estimate how many days until cumulative net yield covers entry cost.
    /// @param entryCostUSDC     One-time cost to open the position (6 decimals)
    /// @param dailyNetYieldUSDC Expected daily net yield (6 decimals), must be > 0
    /// @return days_            Break-even in days; type(uint256).max if yield ≤ 0
    function calcBreakEvenDays(
        uint256 entryCostUSDC,
        uint256 dailyNetYieldUSDC
    ) internal pure returns (uint256 days_) {
        if (dailyNetYieldUSDC == 0) return type(uint256).max;
        days_ = entryCostUSDC / dailyNetYieldUSDC;
    }
}
