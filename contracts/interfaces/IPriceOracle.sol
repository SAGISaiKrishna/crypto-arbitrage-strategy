// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IPriceOracle
/// @notice Standard interface for price feed adapters.
///         Allows MockPriceOracle and ChainlinkPriceOracle to be swapped without
///         changing any downstream contract code.
interface IPriceOracle {
    /// @notice Returns the latest ETH/USD price, normalised to 18 decimals.
    /// @dev    Implementations must revert if the data is stale or invalid.
    /// @return price ETH price in USD, scaled to 1e18
    ///         (e.g. $2 000.00 → 2_000e18)
    function getPrice() external view returns (uint256 price);

    /// @notice Returns the number of decimals used by getPrice() (always 18).
    function decimals() external pure returns (uint8);
}
