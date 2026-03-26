// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "../interfaces/IPerpEngine.sol";
import "../interfaces/IPriceOracle.sol";
import "./ArbitrageMath.sol";

/// @title MockPerpEngine
/// @notice Simulated perpetual futures engine for the strategy study.
///
///         What this contract models:
///         ─────────────────────────
///         A simplified on-chain representation of a centralised perpetual
///         exchange. Users (in practice: StrategyVault) can open a short ETH
///         position by posting USDC collateral. Funding accrues continuously
///         based on a configurable daily rate. The position can be closed at
///         any time; proceeds (collateral ± price PnL + cumulative funding)
///         are returned to the caller.
///
///         What this contract does NOT model:
///         ───────────────────────────────────
///         - Order books or matching engines
///         - Multiple simultaneous positions per user
///         - Cross-margin between positions
///         - Real exchange connectivity
///
///         One active short position per address at a time.
contract MockPerpEngine is IPerpEngine, Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;
    using ArbitrageMath for *; // allow library calls via `ArbitrageMath.fn()`

    // ─── State ────────────────────────────────────────────────────────────────

    IERC20 public immutable collateralToken; // MockUSDC, 6 decimals
    IPriceOracle public oracle;

    /// @notice Signed daily funding rate in basis points.
    ///         Positive = contango (shorts receive).
    ///         Negative = backwardation (shorts pay).
    ///         Default: 3 bps/day (0.03 %/day ≈ 10.95 % annualised).
    int256 public dailyFundingRateBps;

    /// @notice Minimum margin ratio (bps) before a position is liquidatable.
    ///         Default: 500 bps = 5 %.
    uint256 public maintenanceMarginBps;

    mapping(address => Position) private _positions;

    // ─── Events ───────────────────────────────────────────────────────────────

    event PositionOpened(
        address indexed user,
        uint256 notional,
        uint256 collateral,
        uint256 entryPrice,
        uint256 timestamp
    );

    event PositionClosed(
        address indexed user,
        uint256 notional,
        int256  pricePnL,
        int256  fundingPnL,
        int256  netPnL,
        uint256 proceedsReturned,
        uint256 timestamp
    );

    event FundingAccrued(
        address indexed user,
        int256  amount,
        uint256 timestamp
    );

    event Liquidated(
        address indexed user,
        address indexed liquidator,
        uint256 timestamp
    );

    event OracleUpdated(address indexed newOracle);
    event FundingRateUpdated(int256 oldRate, int256 newRate);
    event MaintenanceMarginUpdated(uint256 oldValue, uint256 newValue);

    // ─── Constructor ──────────────────────────────────────────────────────────

    /// @param initialOwner    Contract owner (StrategyVault in production)
    /// @param collateralToken_ MockUSDC address
    /// @param oracle_          Price oracle address (Mock or Chainlink)
    constructor(
        address initialOwner,
        address collateralToken_,
        address oracle_
    ) Ownable(initialOwner) {
        require(collateralToken_ != address(0), "MockPerpEngine: zero collateral");
        require(oracle_ != address(0), "MockPerpEngine: zero oracle");
        collateralToken  = IERC20(collateralToken_);
        oracle           = IPriceOracle(oracle_);
        dailyFundingRateBps   = 3;    // 0.03 %/day default
        maintenanceMarginBps  = 500;  // 5 % default
    }

    // ─── IPerpEngine: Mutating ─────────────────────────────────────────────────

    /// @inheritdoc IPerpEngine
    /// @dev Caller must approve this contract to spend `collateral` before calling.
    ///      Only one open position per address at a time.
    function openShort(
        uint256 notional,
        uint256 collateral
    ) external override nonReentrant {
        require(notional > 0,   "MockPerpEngine: zero notional");
        require(collateral > 0, "MockPerpEngine: zero collateral");
        require(collateral <= notional, "MockPerpEngine: collateral > notional");
        require(!_positions[msg.sender].isOpen, "MockPerpEngine: position already open");

        uint256 entryPrice = oracle.getPrice();
        require(entryPrice > 0, "MockPerpEngine: invalid oracle price");

        // Transfer margin from caller to this contract
        collateralToken.safeTransferFrom(msg.sender, address(this), collateral);

        _positions[msg.sender] = Position({
            notional:             notional,
            collateral:           collateral,
            entryPrice:           entryPrice,
            entryTimestamp:       block.timestamp,
            lastFundingTimestamp: block.timestamp,
            cumulativeFunding:    0,
            isOpen:               true
        });

        emit PositionOpened(msg.sender, notional, collateral, entryPrice, block.timestamp);
    }

    /// @inheritdoc IPerpEngine
    /// @dev Checkpoints funding first, then computes final PnL and returns proceeds.
    ///      If equity < 0 the position was underwater; we return 0 and absorb the loss
    ///      (simplified model — no insurance fund).
    function closeShort() external override nonReentrant returns (uint256 netProceeds) {
        Position storage pos = _positions[msg.sender];
        require(pos.isOpen, "MockPerpEngine: no open position");

        // Checkpoint any outstanding funding before closing
        _accrueFundingInternal(msg.sender);

        uint256 currentPrice = oracle.getPrice();

        int256 pricePnL = ArbitrageMath.calcShortPricePnL(
            pos.notional,
            pos.entryPrice,
            currentPrice
        );

        int256 netPnL = pricePnL + pos.cumulativeFunding;

        // Equity = collateral adjusted by PnL
        int256 equity = int256(pos.collateral) + netPnL;

        // Clear position before transferring (CEI pattern)
        uint256 collateral = pos.collateral;
        delete _positions[msg.sender];

        if (equity > 0) {
            netProceeds = uint256(equity);
            collateralToken.safeTransfer(msg.sender, netProceeds);
        }
        // If equity <= 0: position wiped out, return 0 (simplified — no shortfall socialisation)

        emit PositionClosed(
            msg.sender,
            collateral,
            pricePnL,
            pos.cumulativeFunding, // already captured before delete
            netPnL,
            netProceeds,
            block.timestamp
        );
    }

    /// @inheritdoc IPerpEngine
    /// @dev Public so the vault (or anyone) can trigger a funding checkpoint.
    function accrueFunding(address user) external override {
        require(_positions[user].isOpen, "MockPerpEngine: no open position");
        _accrueFundingInternal(user);
    }

    // ─── IPerpEngine: View ─────────────────────────────────────────────────────

    /// @inheritdoc IPerpEngine
    function getPosition(address user)
        external
        view
        override
        returns (Position memory)
    {
        return _positions[user];
    }

    /// @inheritdoc IPerpEngine
    /// @dev Includes both checkpointed funding AND pending funding since last checkpoint.
    function getUnrealizedPnL(address user)
        external
        view
        override
        returns (int256 pnl)
    {
        Position storage pos = _positions[user];
        if (!pos.isOpen) return 0;

        uint256 currentPrice = oracle.getPrice();

        int256 pricePnL = ArbitrageMath.calcShortPricePnL(
            pos.notional,
            pos.entryPrice,
            currentPrice
        );

        int256 pendingFunding = ArbitrageMath.calcFundingPayment(
            pos.notional,
            dailyFundingRateBps,
            block.timestamp - pos.lastFundingTimestamp
        );

        pnl = pricePnL + pos.cumulativeFunding + pendingFunding;
    }

    /// @inheritdoc IPerpEngine
    function getMarginRatio(address user)
        external
        view
        override
        returns (uint256 ratioBps)
    {
        Position storage pos = _positions[user];
        if (!pos.isOpen) return type(uint256).max;

        int256 unrealizedPnL = this.getUnrealizedPnL(user);
        ratioBps = ArbitrageMath.calcMarginRatio(
            pos.collateral,
            unrealizedPnL,
            pos.notional
        );
    }

    /// @inheritdoc IPerpEngine
    function isLiquidatable(address user)
        external
        view
        override
        returns (bool)
    {
        Position storage pos = _positions[user];
        if (!pos.isOpen) return false;
        return this.getMarginRatio(user) < maintenanceMarginBps;
    }

    // ─── Admin ────────────────────────────────────────────────────────────────

    /// @notice Update the daily funding rate. Owner only.
    ///         Set negative to model backwardation scenarios.
    function setDailyFundingRateBps(int256 newRate) external onlyOwner {
        emit FundingRateUpdated(dailyFundingRateBps, newRate);
        dailyFundingRateBps = newRate;
    }

    /// @notice Update the maintenance margin threshold. Owner only.
    function setMaintenanceMarginBps(uint256 newValue) external onlyOwner {
        require(newValue > 0 && newValue < 10_000, "MockPerpEngine: invalid margin");
        emit MaintenanceMarginUpdated(maintenanceMarginBps, newValue);
        maintenanceMarginBps = newValue;
    }

    /// @notice Swap the price oracle. Owner only.
    function setOracle(address newOracle) external onlyOwner {
        require(newOracle != address(0), "MockPerpEngine: zero oracle");
        oracle = IPriceOracle(newOracle);
        emit OracleUpdated(newOracle);
    }

    // ─── Liquidation (stub) ───────────────────────────────────────────────────

    /// @notice Liquidate an underwater position.
    /// @dev    TODO: implement full liquidation incentive logic.
    ///         Currently transfers remaining collateral to the liquidator as a reward.
    ///         A production version would involve an insurance fund, partial liquidation,
    ///         and a liquidation penalty.
    function liquidate(address user) external nonReentrant {
        require(_positions[user].isOpen, "MockPerpEngine: no open position");
        require(this.isLiquidatable(user), "MockPerpEngine: position is healthy");

        uint256 remainingCollateral = _positions[user].collateral;
        delete _positions[user];

        // Return any remaining collateral to the liquidator as incentive
        if (remainingCollateral > 0) {
            collateralToken.safeTransfer(msg.sender, remainingCollateral);
        }

        emit Liquidated(user, msg.sender, block.timestamp);
    }

    // ─── Internal ─────────────────────────────────────────────────────────────

    /// @dev Checkpoints funding into cumulativeFunding and updates lastFundingTimestamp.
    function _accrueFundingInternal(address user) internal {
        Position storage pos = _positions[user];
        uint256 elapsed = block.timestamp - pos.lastFundingTimestamp;
        if (elapsed == 0) return;

        int256 fundingPayment = ArbitrageMath.calcFundingPayment(
            pos.notional,
            dailyFundingRateBps,
            elapsed
        );

        pos.cumulativeFunding      += fundingPayment;
        pos.lastFundingTimestamp    = block.timestamp;

        emit FundingAccrued(user, fundingPayment, block.timestamp);
    }
}
