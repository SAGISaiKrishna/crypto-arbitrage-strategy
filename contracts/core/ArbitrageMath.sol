// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title ArbitrageMath
/// @notice Pure math library for the carry/arbitrage strategy.
///         All financial formulas live here so they can be tested independently
///         and the vault / perp engine contracts stay readable.
///
///         Unit convention (must be consistent across callers):
///           - USDC amounts    : uint256 / int256,  6 decimals  (1 USDC = 1e6)
///           - ETH/USD prices  : uint256,           18 decimals ($2 000 = 2_000e18)
///           - Rates           : basis points (bps) where 1 bps = 0.01%
///           - Time            : seconds (block.timestamp)
library ArbitrageMath {

    // ─── Short Position P&L ───────────────────────────────────────────────────

    /// @notice Unrealised P&L on a short ETH perpetual position.
    /// @dev    Positive when ETH price falls (short profits), negative when it rises.
    ///
    ///         Formula: notional × (entryPrice − currentPrice) / entryPrice
    ///
    /// @param notional      Position size in USDC, 6 decimals
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
            // Price rose → short loses
            uint256 loss = (notional * (currentPrice - entryPrice)) / entryPrice;
            pnl = -int256(loss);
        } else {
            // Price fell → short profits
            uint256 profit = (notional * (entryPrice - currentPrice)) / entryPrice;
            pnl = int256(profit);
        }
    }

    // ─── Funding ──────────────────────────────────────────────────────────────

    /// @notice Funding payment accrued on a short position over `elapsedSeconds`.
    /// @dev    Positive = shorts receive from longs (contango / normal market).
    ///         Negative = shorts pay to longs (backwardation / inverted market).
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

    // ─── Lending Yield ────────────────────────────────────────────────────────

    /// @notice Lending yield accrued on idle USDC over `elapsedSeconds`.
    /// @dev    Models Aave-style simple interest. Always non-negative.
    ///
    ///         Formula: principal × lendingAPYBps × elapsedSeconds
    ///                  ──────────────────────────────────────────
    ///                           10 000 × 365 days
    ///
    /// @param principal        USDC amount earning yield, 6 decimals
    /// @param lendingAPYBps    Annual percentage yield in bps (500 = 5 %)
    /// @param elapsedSeconds   Seconds since deposit
    /// @return yieldAmount     USDC yield, 6 decimals
    function calcLendingYield(
        uint256 principal,
        uint256 lendingAPYBps,
        uint256 elapsedSeconds
    ) internal pure returns (uint256 yieldAmount) {
        yieldAmount =
            (principal * lendingAPYBps * elapsedSeconds) /
            (10_000 * 365 days);
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

    // ─── Carry / Viability ────────────────────────────────────────────────────

    /// @notice Annualised carry score in basis points.
    ///         Positive score means the trade is expected to be profitable.
    ///
    ///         Formula: lendingAPYBps + (dailyFundingRateBps × 365) − costBps
    ///
    ///         Where:
    ///           lendingAPYBps       = annual lending yield (e.g. 500 = 5 %)
    ///           dailyFundingRateBps = daily funding (e.g. 3 = 0.03 %/day → 1 095 bps/year)
    ///           costBps             = estimated annual execution cost
    ///
    /// @param lendingAPYBps         Annual lending yield in bps
    /// @param dailyFundingRateBps   Signed daily funding in bps
    /// @param costBps               Annual cost estimate in bps
    /// @return score                Signed annualised carry score in bps
    function calcCarryScore(
        uint256 lendingAPYBps,
        int256  dailyFundingRateBps,
        uint256 costBps
    ) internal pure returns (int256 score) {
        int256 annualizedFunding = dailyFundingRateBps * 365;
        score = int256(lendingAPYBps) + annualizedFunding - int256(costBps);
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
