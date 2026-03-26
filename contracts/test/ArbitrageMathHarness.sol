// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "../core/ArbitrageMath.sol";

/// @title ArbitrageMathHarness
/// @notice Thin wrapper that exposes ArbitrageMath library functions as public
///         contract functions so they can be called from TypeScript tests.
///         This file lives in contracts/test/ and is NEVER deployed to mainnet.
contract ArbitrageMathHarness {
    function calcShortPricePnL(
        uint256 notional,
        uint256 entryPrice,
        uint256 currentPrice
    ) external pure returns (int256) {
        return ArbitrageMath.calcShortPricePnL(notional, entryPrice, currentPrice);
    }

    function calcFundingPayment(
        uint256 notional,
        int256  dailyFundingRateBps,
        uint256 elapsedSeconds
    ) external pure returns (int256) {
        return ArbitrageMath.calcFundingPayment(notional, dailyFundingRateBps, elapsedSeconds);
    }

    function calcLendingYield(
        uint256 principal,
        uint256 lendingAPYBps,
        uint256 elapsedSeconds
    ) external pure returns (uint256) {
        return ArbitrageMath.calcLendingYield(principal, lendingAPYBps, elapsedSeconds);
    }

    function calcMarginRatio(
        uint256 collateral,
        int256  unrealizedPnL,
        uint256 notional
    ) external pure returns (uint256) {
        return ArbitrageMath.calcMarginRatio(collateral, unrealizedPnL, notional);
    }

    function calcHealthFactor(
        uint256 marginRatioBps,
        uint256 maintenanceMarginBps
    ) external pure returns (uint256) {
        return ArbitrageMath.calcHealthFactor(marginRatioBps, maintenanceMarginBps);
    }

    function calcCarryScore(
        uint256 lendingAPYBps,
        int256  dailyFundingRateBps,
        uint256 costBps
    ) external pure returns (int256) {
        return ArbitrageMath.calcCarryScore(lendingAPYBps, dailyFundingRateBps, costBps);
    }

    function isCarryViable(
        int256 carryScore,
        int256 minThresholdBps
    ) external pure returns (bool) {
        return ArbitrageMath.isCarryViable(carryScore, minThresholdBps);
    }

    function calcBreakEvenDays(
        uint256 entryCostUSDC,
        uint256 dailyNetYieldUSDC
    ) external pure returns (uint256) {
        return ArbitrageMath.calcBreakEvenDays(entryCostUSDC, dailyNetYieldUSDC);
    }
}
