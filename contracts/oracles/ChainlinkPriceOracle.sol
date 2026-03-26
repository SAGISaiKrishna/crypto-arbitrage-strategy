// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "../interfaces/IPriceOracle.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

/// @notice Minimal Chainlink AggregatorV3 interface — defined inline to avoid
///         external package version dependencies.
interface AggregatorV3Interface {
    function decimals() external view returns (uint8);
    function latestRoundData()
        external
        view
        returns (
            uint80  roundId,
            int256  answer,
            uint256 startedAt,
            uint256 updatedAt,
            uint80  answeredInRound
        );
}

/// @title ChainlinkPriceOracle
/// @notice Production price feed wrapper for Sepolia deployment.
///         Reads the Chainlink ETH/USD aggregator and normalises the answer
///         to 18 decimals so it is compatible with IPriceOracle.
///
///         Sepolia ETH/USD feed: 0x694AA1769357215DE4FAC081bf1f309aDC325306
///
///         Key safety checks:
///         - Reverts if the latest answer is stale (older than `stalenessThreshold`)
///         - Reverts if the answer is zero or negative
contract ChainlinkPriceOracle is IPriceOracle, Ownable {
    AggregatorV3Interface public immutable feed;

    /// @notice Maximum age of oracle data before it is considered stale.
    ///         Default: 1 hour (3 600 seconds). Configurable by owner.
    uint256 public stalenessThreshold;

    event StalenessThresholdUpdated(uint256 oldValue, uint256 newValue);

    /// @param initialOwner  Contract owner (can update staleness threshold)
    /// @param feedAddress   Chainlink AggregatorV3 address on the target network
    constructor(address initialOwner, address feedAddress)
        Ownable(initialOwner)
    {
        require(feedAddress != address(0), "ChainlinkPriceOracle: zero address");
        feed = AggregatorV3Interface(feedAddress);
        stalenessThreshold = 1 hours;
    }

    // ─── IPriceOracle ─────────────────────────────────────────────────────────

    /// @inheritdoc IPriceOracle
    /// @dev Chainlink ETH/USD feed uses 8 decimals; we scale up to 18.
    function getPrice() external view override returns (uint256) {
        (
            /* roundId */,
            int256 answer,
            /* startedAt */,
            uint256 updatedAt,
            /* answeredInRound */
        ) = feed.latestRoundData();

        require(answer > 0, "ChainlinkPriceOracle: invalid price");
        require(
            block.timestamp - updatedAt <= stalenessThreshold,
            "ChainlinkPriceOracle: stale price"
        );

        uint8 feedDecimals = feed.decimals(); // typically 8 for ETH/USD
        // Scale answer from feedDecimals → 18 decimals
        uint256 scaledPrice = uint256(answer) * (10 ** (18 - feedDecimals));
        return scaledPrice;
    }

    /// @inheritdoc IPriceOracle
    function decimals() external pure override returns (uint8) {
        return 18;
    }

    // ─── Admin ────────────────────────────────────────────────────────────────

    /// @notice Update the maximum allowed oracle data age. Owner only.
    function setStalenessThreshold(uint256 newThreshold) external onlyOwner {
        require(newThreshold > 0, "ChainlinkPriceOracle: zero threshold");
        emit StalenessThresholdUpdated(stalenessThreshold, newThreshold);
        stalenessThreshold = newThreshold;
    }
}
