// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "../interfaces/IStrategyVault.sol";
import "../interfaces/IPerpEngine.sol";
import "../interfaces/IPriceOracle.sol";
import "./ArbitrageMath.sol";

/// @title StrategyVault
/// @notice On-chain proof-of-concept for a delta-neutral ETH carry strategy.
///
///         Strategy overview:
///         ──────────────────
///         Users deposit USDC. The vault represents a two-leg position:
///
///           Leg 1 — Long spot:  The deposited USDC provides the economic
///           exposure equivalent to holding long ETH spot. In a full
///           implementation this would be deployed into a spot ETH position.
///           Here it is tracked as a USDC notional allocation.
///
///           Leg 2 — Short perp: A portion of USDC is posted as margin to
///           MockPerpEngine to open a short ETH perpetual futures position.
///           The notional equals the spot allocation, making the strategy
///           approximately delta-neutral (price moves cancel).
///
///         Profit source:
///           The net income is the perpetual funding rate (received by shorts
///           when the market is in contango) minus the benchmark opportunity
///           cost (what the capital could earn in a risk-free vehicle).
///
///           carryScore = (dailyFundingRate × 365) − benchmarkRate − costs
///
///         Delta neutrality:
///           spot PnL + short perp PnL ≈ 0, so price moves do not drive returns.
///           This is demonstrated in getVaultState() by computing both legs.
///
///         Access control:
///           - openHedge / closeHedge : owner / manager only
///           - deposit / withdraw      : any user
contract StrategyVault is IStrategyVault, Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ─── Immutables ───────────────────────────────────────────────────────────

    IERC20       public immutable usdc;
    IPerpEngine  public immutable perpEngine;
    IPriceOracle public immutable oracle;

    // ─── Strategy Parameters (owner-configurable) ─────────────────────────────

    /// @notice Annualised benchmark rate in bps.
    ///         Represents the opportunity cost — what the capital could earn
    ///         sitting in a stablecoin protocol or T-bill equivalent.
    ///         Default: 200 bps = 2%.
    uint256 public benchmarkRateBps;

    /// @notice Base risk premium per unit of leverage for the dynamic entry threshold.
    ///         Default: 75 bps per leverage unit.
    ///         Example: 5x leverage → threshold = costEstimate + 5×75 = 425 bps.
    uint256 public riskPremiumPerLeverageUnit;

    /// @notice Estimated round-trip execution cost (gas + slippage), annualised bps.
    ///         Default: 50 bps.
    uint256 public costEstimateBps;

    // ─── Exit Policy Parameters ───────────────────────────────────────────────

    /// @notice Margin ratio (bps) below which the perp position is force-closed.
    ///         Default: 800 bps (well above the 500 bps liquidation threshold).
    uint256 public safetyMarginBps;

    /// @notice Maximum seconds to hold an open position before a time-based exit.
    ///         Default: 30 days.
    uint256 public maxHoldingPeriod;

    /// @notice Capital protection threshold (bps of posted collateral).
    ///         Exit fires when net loss exceeds (1 − profitProtectionRatioBps / 10_000) of collateral.
    ///         Default: 9000 = exit when loss > 10% of collateral.
    uint256 public profitProtectionRatioBps;

    // ─── Vault State ──────────────────────────────────────────────────────────

    uint256 public totalDeposited;             // Total USDC deposited (6 dec)
    uint256 public totalShares;                // Total shares outstanding (18 dec)
    uint256 public hedgeCollateral;            // USDC locked in perp engine as margin
    uint256 public spotAllocationUsdc;         // Notional USDC of long spot leg
    uint256 public hedgeNotional;              // Perp short notional (= spotAllocationUsdc)
    uint256 public hedgeEntryPrice;            // ETH/USD price when position was opened (18 dec)

    bool    public hedgeIsOpen;
    int256  public currentDailyFundingRateBps; // Funding rate recorded at openHedge
    uint256 public hedgeOpenTimestamp;

    // ─── Per-User Accounting ──────────────────────────────────────────────────

    struct UserInfo {
        uint256 shares;    // Proportional claim on the vault
        uint256 principal; // USDC deposited (6 dec)
    }

    mapping(address => UserInfo) public userInfo;

    // ─── Events ───────────────────────────────────────────────────────────────

    event Deposited(address indexed user, uint256 usdcAmount, uint256 shares);
    event Withdrawn(address indexed user, uint256 shares, uint256 usdcReturned);
    event HedgeOpened(
        uint256 notional,
        uint256 collateral,
        uint256 entryPrice,
        int256  carryScore
    );
    event HedgeClosed(
        int256  spotPricePnL,
        int256  shortPricePnL,
        int256  fundingPnL,
        int256  netPnL,
        uint256 proceedsReturned
    );
    event AutoExitTriggered(string reason, int256 netPnL);

    // ─── Constructor ──────────────────────────────────────────────────────────

    constructor(
        address initialOwner,
        address usdc_,
        address perpEngine_,
        address oracle_
    ) Ownable(initialOwner) {
        require(usdc_       != address(0), "StrategyVault: zero usdc");
        require(perpEngine_ != address(0), "StrategyVault: zero engine");
        require(oracle_     != address(0), "StrategyVault: zero oracle");

        usdc       = IERC20(usdc_);
        perpEngine = IPerpEngine(perpEngine_);
        oracle     = IPriceOracle(oracle_);

        benchmarkRateBps           = 200;    // 2% annualised opportunity cost
        riskPremiumPerLeverageUnit = 75;     // 75 bps added to threshold per leverage unit
        costEstimateBps            = 50;     // 0.5% round-trip cost estimate
        safetyMarginBps            = 800;    // exit before reaching 500 bps liquidation
        maxHoldingPeriod           = 30 days;
        profitProtectionRatioBps   = 9000;   // exit when net loss > 10% of posted collateral
    }

    // ─── IStrategyVault: Mutating ─────────────────────────────────────────────

    /// @notice Deposit USDC and receive proportional vault shares.
    ///         Shares are minted 1:1 with USDC on the first deposit,
    ///         and proportionally for subsequent deposits.
    function deposit(uint256 usdcAmount) external override nonReentrant {
        require(usdcAmount > 0, "StrategyVault: zero amount");

        uint256 sharesToMint;
        if (totalShares == 0) {
            sharesToMint = usdcAmount * 1e12; // scale 6-dec USDC to 18-dec shares
        } else {
            uint256 vaultValue = _getTotalVaultValue();
            sharesToMint = (usdcAmount * totalShares) / vaultValue;
        }

        usdc.safeTransferFrom(msg.sender, address(this), usdcAmount);

        userInfo[msg.sender].shares    += sharesToMint;
        userInfo[msg.sender].principal += usdcAmount;
        totalShares    += sharesToMint;
        totalDeposited += usdcAmount;

        emit Deposited(msg.sender, usdcAmount, sharesToMint);
    }

    /// @notice Redeem shares for a proportional share of vault USDC.
    ///         Reverts if a position is open (collateral is locked in perpEngine).
    function withdraw(uint256 shares) external override nonReentrant {
        UserInfo storage info = userInfo[msg.sender];
        require(shares > 0,            "StrategyVault: zero shares");
        require(shares <= info.shares, "StrategyVault: insufficient shares");
        require(!hedgeIsOpen,          "StrategyVault: hedge is open, close first");

        uint256 vaultValue = _getTotalVaultValue();
        uint256 userValue  = (shares * vaultValue) / totalShares;

        require(
            usdc.balanceOf(address(this)) >= userValue,
            "StrategyVault: insufficient liquidity"
        );

        // Update accounting
        if (shares == info.shares) {
            info.principal = 0;
        } else {
            info.principal = info.principal - (shares * info.principal) / info.shares;
        }
        info.shares    -= shares;
        totalShares    -= shares;
        totalDeposited  = totalDeposited >= userValue ? totalDeposited - userValue : 0;

        usdc.safeTransfer(msg.sender, userValue);

        emit Withdrawn(msg.sender, shares, userValue);
    }

    /// @notice Open the delta-neutral position: record spot allocation + open short perp.
    ///         Owner / manager only.
    ///
    ///         The carry score must exceed the leverage-scaled dynamic threshold:
    ///           carryScore = (dailyFunding × 365) − benchmarkRate − costs
    ///           threshold  = costs + (leverage × riskPremiumPerLeverageUnit)
    ///
    /// @param notional                Notional size in USDC (= spot allocation = perp notional)
    /// @param collateral              Margin to post to perp engine in USDC
    /// @param dailyFundingRateBps_    Observed daily funding rate in bps at time of entry
    function openHedge(
        uint256 notional,
        uint256 collateral,
        int256  dailyFundingRateBps_
    ) external override onlyOwner {
        require(!hedgeIsOpen,                       "StrategyVault: hedge already open");
        require(notional > 0,                       "StrategyVault: zero notional");
        require(collateral > 0,                     "StrategyVault: zero collateral");
        require(collateral <= notional,             "StrategyVault: collateral > notional");
        require(
            usdc.balanceOf(address(this)) >= collateral,
            "StrategyVault: insufficient USDC balance"
        );

        // Entry gate: carry score must exceed the leverage-scaled threshold
        uint256 leverageRatio    = notional / collateral;
        int256  dynamicThreshold = int256(costEstimateBps + leverageRatio * riskPremiumPerLeverageUnit);

        int256 carryScore = ArbitrageMath.calcCarryScore(
            benchmarkRateBps,
            dailyFundingRateBps_,
            costEstimateBps
        );
        require(
            ArbitrageMath.isCarryViable(carryScore, dynamicThreshold),
            "StrategyVault: carry score below dynamic threshold"
        );

        // Record entry price for PnL calculations
        uint256 entryPrice = oracle.getPrice();

        // Open the short perp leg
        usdc.approve(address(perpEngine), collateral);
        perpEngine.openShort(notional, collateral);

        // Record position state
        hedgeIsOpen                = true;
        hedgeCollateral            = collateral;
        hedgeNotional              = notional;
        hedgeOpenTimestamp         = block.timestamp;
        currentDailyFundingRateBps = dailyFundingRateBps_;
        spotAllocationUsdc         = notional; // 1:1 hedge ratio
        hedgeEntryPrice            = entryPrice;

        emit HedgeOpened(notional, collateral, entryPrice, carryScore);
    }

    /// @notice Close the position and return proceeds to the vault.
    ///         Owner / manager only.
    function closeHedge() external override onlyOwner {
        require(hedgeIsOpen, "StrategyVault: no open hedge");
        _closePosition();
    }

    // ─── IStrategyVault: View ──────────────────────────────────────────────────

    /// @notice Full vault state snapshot, including delta-neutral PnL breakdown.
    function getVaultState() external view override returns (VaultState memory state) {
        state.totalDeposited    = totalDeposited;
        state.totalShares       = totalShares;
        state.hedgeCollateral   = hedgeCollateral;
        state.spotAllocationUsdc = spotAllocationUsdc;
        state.hedgeIsOpen       = hedgeIsOpen;

        if (hedgeIsOpen) {
            uint256 currentPrice = oracle.getPrice();

            // Long spot leg PnL (would be positive if ETH rose)
            state.spotPricePnL = ArbitrageMath.calcSpotPnL(
                spotAllocationUsdc,
                hedgeEntryPrice,
                currentPrice
            );

            // Short perp leg PnL (price component — opposite of spot)
            state.shortPricePnL = ArbitrageMath.calcShortPricePnL(
                hedgeNotional,
                hedgeEntryPrice,
                currentPrice
            );

            // Delta: should be approximately zero — demonstrates delta-neutrality
            state.netDeltaPnL = state.spotPricePnL + state.shortPricePnL;

            // Funding income (total unrealised from perp engine, includes price + funding)
            state.fundingIncomeTotal = perpEngine.getUnrealizedPnL(address(this));

            // Net PnL = spot leg + perp engine total (price legs cancel, leaving funding)
            state.netPnL = state.spotPricePnL + state.fundingIncomeTotal;

            state.marginRatioBps  = perpEngine.getMarginRatio(address(this));
            state.marginIsHealthy = !perpEngine.isLiquidatable(address(this));
        }

        state.carryScore = ArbitrageMath.calcCarryScore(
            benchmarkRateBps,
            currentDailyFundingRateBps,
            costEstimateBps
        );
    }

    /// @notice Returns the current USDC value of a user's shares.
    function getUserValue(address user)
        external
        view
        override
        returns (uint256 usdcValue)
    {
        UserInfo storage info = userInfo[user];
        if (info.shares == 0 || totalShares == 0) return 0;
        uint256 vaultValue = _getTotalVaultValue();
        usdcValue = (info.shares * vaultValue) / totalShares;
    }

    /// @notice Quick carry viability check (uses threshold = 0).
    ///         Actual entry uses the leverage-adjusted threshold in openHedge.
    function isCarryViable(int256 dailyFundingRateBps_)
        external
        view
        override
        returns (bool)
    {
        int256 score = ArbitrageMath.calcCarryScore(
            benchmarkRateBps,
            dailyFundingRateBps_,
            costEstimateBps
        );
        return ArbitrageMath.isCarryViable(score, 0);
    }

    // ─── Exit Logic ───────────────────────────────────────────────────────────

    /// @notice Evaluates whether any auto-exit condition is triggered.
    ///
    ///         Four conditions, in priority order:
    ///         1. MARGIN  — margin ratio fell below safetyMarginBps (liquidation protection)
    ///         2. CAPITAL — net loss exceeds the allowed fraction of posted collateral
    ///         3. CARRY   — funding no longer exceeds benchmark + costs
    ///         4. TIME    — position has been open beyond maxHoldingPeriod
    function shouldAutoExit()
        external
        view
        returns (bool triggered, string memory reason)
    {
        if (!hedgeIsOpen) return (false, "no open hedge");

        // 1. Margin safety
        uint256 marginRatio = perpEngine.getMarginRatio(address(this));
        if (marginRatio < safetyMarginBps) {
            return (true, "MARGIN: below safety threshold");
        }

        // 2. Capital protection
        int256 unrealisedPnL = perpEngine.getUnrealizedPnL(address(this));
        if (unrealisedPnL < 0) {
            uint256 absLoss     = uint256(-unrealisedPnL);
            uint256 allowedLoss = (hedgeCollateral * (10_000 - profitProtectionRatioBps)) / 10_000;
            if (absLoss > allowedLoss) {
                return (true, "CAPITAL: net loss exceeds collateral protection threshold");
            }
        }

        // 3. Carry gone — funding no longer exceeds benchmark + costs
        int256 carryScore = ArbitrageMath.calcCarryScore(
            benchmarkRateBps,
            currentDailyFundingRateBps,
            costEstimateBps
        );
        if (carryScore <= 0) {
            return (true, "CARRY: funding no longer exceeds benchmark and costs");
        }

        // 4. Time limit
        if (block.timestamp >= hedgeOpenTimestamp + maxHoldingPeriod) {
            return (true, "TIME: maximum holding period reached");
        }

        return (false, "no exit condition triggered");
    }

    /// @notice Closes the position if any exit condition is triggered.
    ///         Callable by anyone (keeper-friendly).
    function autoClose() external nonReentrant {
        require(hedgeIsOpen, "StrategyVault: no open hedge");
        (bool triggered, string memory reason) = this.shouldAutoExit();
        require(triggered, "StrategyVault: no exit condition triggered");

        int256 netPnL = _closePosition();
        emit AutoExitTriggered(reason, netPnL);
    }

    // ─── Admin ────────────────────────────────────────────────────────────────

    /// @notice Update the benchmark rate (opportunity cost). Owner only.
    function setBenchmarkRate(uint256 newRateBps) external onlyOwner {
        require(newRateBps <= 5_000, "StrategyVault: benchmark rate too high");
        benchmarkRateBps = newRateBps;
    }

    /// @notice Update the risk premium per leverage unit. Owner only.
    function setRiskPremiumPerLeverageUnit(uint256 newPremiumBps) external onlyOwner {
        riskPremiumPerLeverageUnit = newPremiumBps;
    }

    /// @notice Update the cost estimate. Owner only.
    function setCostEstimate(uint256 newCostBps) external onlyOwner {
        costEstimateBps = newCostBps;
    }

    /// @notice Update the safety margin threshold. Owner only.
    function setSafetyMargin(uint256 newMarginBps) external onlyOwner {
        require(newMarginBps > 500, "StrategyVault: must be above liquidation threshold");
        safetyMarginBps = newMarginBps;
    }

    /// @notice Update the maximum holding period. Owner only.
    function setMaxHoldingPeriod(uint256 newPeriodSeconds) external onlyOwner {
        maxHoldingPeriod = newPeriodSeconds;
    }

    /// @notice Update the profit protection ratio. Owner only.
    function setProfitProtectionRatio(uint256 newRatioBps) external onlyOwner {
        require(newRatioBps <= 10_000, "StrategyVault: ratio exceeds 100%");
        profitProtectionRatioBps = newRatioBps;
    }

    // ─── Internal ─────────────────────────────────────────────────────────────

    /// @dev Close the perp position, reset state, emit event, return net PnL.
    function _closePosition() internal returns (int256 netPnL) {
        uint256 currentPrice   = oracle.getPrice();
        uint256 balanceBefore  = usdc.balanceOf(address(this));

        uint256 proceeds       = perpEngine.closeShort();
        uint256 balanceAfter   = usdc.balanceOf(address(this));
        uint256 actualReceived = balanceAfter - balanceBefore;

        // PnL breakdown for event
        int256 spotPricePnL  = ArbitrageMath.calcSpotPnL(
            spotAllocationUsdc, hedgeEntryPrice, currentPrice
        );
        int256 shortPricePnL = ArbitrageMath.calcShortPricePnL(
            hedgeNotional, hedgeEntryPrice, currentPrice
        );
        int256 fundingPnL    = int256(actualReceived) - int256(hedgeCollateral) - shortPricePnL;
        netPnL               = spotPricePnL + int256(actualReceived) - int256(hedgeCollateral);

        // Clear position state
        hedgeIsOpen        = false;
        hedgeCollateral    = 0;
        hedgeNotional      = 0;
        hedgeOpenTimestamp = 0;
        spotAllocationUsdc = 0;
        hedgeEntryPrice    = 0;

        emit HedgeClosed(spotPricePnL, shortPricePnL, fundingPnL, netPnL, actualReceived);

        // Suppress unused variable warning
        (proceeds);
    }

    /// @dev Total vault value = idle USDC + collateral locked in perp engine.
    function _getTotalVaultValue() internal view returns (uint256) {
        return usdc.balanceOf(address(this)) + hedgeCollateral;
    }
}
