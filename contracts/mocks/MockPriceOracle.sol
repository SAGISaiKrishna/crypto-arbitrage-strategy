// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "../interfaces/IPriceOracle.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

/// @title MockPriceOracle
/// @notice Settable price feed used during local Hardhat testing.
///         Implements IPriceOracle so it can be swapped for ChainlinkPriceOracle
///         at deploy time without changing any downstream contract.
///
///         The owner can call setPrice() to simulate different ETH prices
///         in test scenarios (e.g. rising market, falling market).
contract MockPriceOracle is IPriceOracle, Ownable {
    /// @dev Price is stored with 18 decimals. Default: $2 000.
    uint256 private _price;

    event PriceUpdated(uint256 oldPrice, uint256 newPrice);

    constructor(address initialOwner, uint256 initialPrice)
        Ownable(initialOwner)
    {
        require(initialPrice > 0, "MockPriceOracle: zero price");
        _price = initialPrice;
    }

    // ─── IPriceOracle ─────────────────────────────────────────────────────────

    /// @inheritdoc IPriceOracle
    function getPrice() external view override returns (uint256) {
        return _price;
    }

    /// @inheritdoc IPriceOracle
    function decimals() external pure override returns (uint8) {
        return 18;
    }

    // ─── Admin ────────────────────────────────────────────────────────────────

    /// @notice Update the price. Owner only.
    /// @param newPrice New ETH/USD price with 18 decimals (e.g. 2500e18)
    function setPrice(uint256 newPrice) external onlyOwner {
        require(newPrice > 0, "MockPriceOracle: zero price");
        emit PriceUpdated(_price, newPrice);
        _price = newPrice;
    }
}
