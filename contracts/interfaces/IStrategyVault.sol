// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IStrategyVault
/// @notice External interface for the delta-neutral carry strategy vault.
interface IStrategyVault {
    // ─── Structs ──────────────────────────────────────────────────────────────

    struct VaultState {
        uint256 totalDeposited;      // Total USDC deposited across all users
        uint256 totalShares;         // Total shares outstanding
        uint256 hedgeCollateral;     // USDC locked as perp margin
        uint256 spotAllocationUsdc;  // Notional USDC equivalent of long spot leg
        bool    hedgeIsOpen;         // Whether a position is active
        int256  spotPricePnL;        // Unrealised P&L on long spot leg (cancels with short)
        int256  shortPricePnL;       // Unrealised P&L on short perp leg (cancels with spot)
        int256  netDeltaPnL;         // spotPricePnL + shortPricePnL (should be ≈ 0)
        int256  fundingIncomeTotal;  // Cumulative funding income received (primary profit)
        int256  netPnL;              // Total net P&L (≈ fundingIncomeTotal when delta-neutral)
        uint256 marginRatioBps;      // Current perp margin ratio
        bool    marginIsHealthy;     // marginRatio > maintenanceMargin
        int256  carryScore;          // Annualised carry score: funding - benchmark - costs (bps)
    }

    // ─── Mutating ─────────────────────────────────────────────────────────────

    function deposit(uint256 usdcAmount) external;
    function withdraw(uint256 shares) external;

    /// @notice Open the two-leg position: long spot allocation + short perp.
    ///         Owner / manager only.
    function openHedge(
        uint256 notional,
        uint256 collateral,
        int256  currentDailyFundingRateBps
    ) external;

    /// @notice Close the active position and return proceeds to vault.
    ///         Owner / manager only.
    function closeHedge() external;

    // ─── View ─────────────────────────────────────────────────────────────────

    function getVaultState() external view returns (VaultState memory);
    function getUserValue(address user) external view returns (uint256 usdcValue);
    function isCarryViable(int256 dailyFundingRateBps) external view returns (bool);
}
