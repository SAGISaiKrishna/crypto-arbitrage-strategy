// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IStrategyVault
/// @notice External interface for the main strategy vault.
interface IStrategyVault {
    // ─── Structs ──────────────────────────────────────────────────────────────

    struct VaultState {
        uint256 totalDeposited;      // Total USDC deposited across all users
        uint256 totalShares;         // Total shares outstanding
        uint256 hedgeCollateral;     // USDC currently locked in the perp engine
        bool    hedgeIsOpen;         // Whether a hedge position is active
        int256  lendingYieldAccrued; // Lending yield accrued vault-wide (USDC, 6 dec)
        int256  fundingIncomeTotal;  // Cumulative funding income from hedge (6 dec)
        int256  shortPricePnL;       // Unrealised price PnL on short (6 dec)
        int256  netPnL;              // Sum of all income minus costs (6 dec)
        uint256 marginRatioBps;      // Current hedge margin ratio
        bool    marginIsHealthy;     // marginRatio > maintenanceMargin
        int256  carryScore;          // Current carry score in annualised bps
    }

    // ─── Mutating ─────────────────────────────────────────────────────────────

    function deposit(uint256 usdcAmount) external;
    function withdraw(uint256 shares) external;

    /// @notice Open a hedge position. Owner / manager only.
    function openHedge(
        uint256 notional,
        uint256 collateral,
        int256  currentDailyFundingRateBps
    ) external;

    /// @notice Close the active hedge position. Owner / manager only.
    function closeHedge() external;

    // ─── View ─────────────────────────────────────────────────────────────────

    function getVaultState() external view returns (VaultState memory);
    function getUserValue(address user) external view returns (uint256 usdcValue);
    function isCarryViable(int256 dailyFundingRateBps) external view returns (bool);
}
