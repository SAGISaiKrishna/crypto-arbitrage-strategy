// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IPerpEngine
/// @notice Interface for the mock perpetual futures engine.
///         Tracks short positions, funding accrual, and margin health.
interface IPerpEngine {
    // ─── Structs ──────────────────────────────────────────────────────────────

    struct Position {
        uint256 notional;             // Position size in USDC (6 decimals)
        uint256 collateral;           // Margin posted in USDC (6 decimals)
        uint256 entryPrice;           // ETH/USD at open, 18 decimals
        uint256 entryTimestamp;       // block.timestamp at open
        uint256 lastFundingTimestamp; // Last time funding was checkpointed
        int256  cumulativeFunding;    // Total funding received (6 dec, signed)
        bool    isOpen;
    }

    // ─── Mutating ─────────────────────────────────────────────────────────────

    /// @notice Open a short position. Transfers `collateral` USDC from caller.
    /// @param notional   Notional size of the short in USDC (6 decimals)
    /// @param collateral Margin amount in USDC (6 decimals)
    function openShort(uint256 notional, uint256 collateral) external;

    /// @notice Close caller's short position and return proceeds to caller.
    /// @return netProceeds USDC returned (collateral ± price PnL + funding)
    function closeShort() external returns (uint256 netProceeds);

    /// @notice Checkpoint funding for `user` without closing the position.
    function accrueFunding(address user) external;

    // ─── View ─────────────────────────────────────────────────────────────────

    /// @notice Returns the full position struct for a user.
    function getPosition(address user) external view returns (Position memory);

    /// @notice Unrealised PnL = price PnL + accrued (but not yet checkpointed) funding.
    /// @return pnl Signed USDC value (6 decimals)
    function getUnrealizedPnL(address user) external view returns (int256 pnl);

    /// @notice Margin ratio = (collateral + unrealisedPnL) / notional, in basis points.
    function getMarginRatio(address user) external view returns (uint256 ratioBps);

    /// @notice True when margin ratio falls below the maintenance margin threshold.
    function isLiquidatable(address user) external view returns (bool);
}
