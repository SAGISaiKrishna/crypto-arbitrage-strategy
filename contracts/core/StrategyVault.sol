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
/// @notice Main orchestrator for the crypto carry / arbitrage strategy.
///
///         Strategy overview:
///         ──────────────────
///         Users deposit USDC. The vault tracks each user's principal and
///         continuously accrues a configurable lending yield (simple interest,
///         modelled after Aave-style money markets). Separately, the vault
///         manager (owner) can allocate a portion of deposited USDC as margin
///         to MockPerpEngine to open a short ETH perpetual position. When the
///         market is in contango, this short earns a funding rate income in
///         addition to the lending yield.
///
///         The strategy opens only when the carry score
///         (lendingAPY + annualised funding − costs) exceeds a configurable
///         threshold — ensuring the trade is entered only when conditions are
///         economically favourable.
///
///         Profit sources:
///           1. Lending yield: accrued on deposited principal per second.
///           2. Funding income: received from long traders when contango persists.
///
///         Retained risk (important for report):
///           The short position has negative ETH delta. If ETH price rises
///           significantly, price P&L on the short can exceed funding income,
///           resulting in a net loss. This risk is explicitly modelled in the
///           simulation scenarios.
///
///         Access control:
///           - openHedge / closeHedge : owner/manager only
///           - deposit / withdraw      : any user
contract StrategyVault is IStrategyVault, Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ─── Immutables ───────────────────────────────────────────────────────────

    IERC20      public immutable usdc;
    IPerpEngine public immutable perpEngine;
    IPriceOracle public immutable oracle;

    // ─── Strategy Parameters (owner-configurable) ─────────────────────────────

    /// @notice Annual lending yield paid to depositors, in basis points.
    ///         Default: 500 bps = 5 % APY.
    uint256 public lendingAPYBps;

    /// @notice Base risk premium added per unit of leverage when computing the
    ///         dynamic carry threshold. Default: 75 bps per leverage unit.
    ///         Example: 5x leverage → threshold = costEstimate + 5×75 = 425 bps.
    uint256 public riskPremiumPerLeverageUnit;

    /// @notice Estimated round-trip cost (gas + slippage), annualised bps.
    ///         Used in carry score calculation.
    ///         Default: 50 bps.
    uint256 public costEstimateBps;

    // ─── Exit Policy Parameters ───────────────────────────────────────────────

    /// @notice Margin ratio (bps) below which the position is force-closed to
    ///         avoid liquidation. Default: 800 bps (well above 500 bps liquidation).
    uint256 public safetyMarginBps;

    /// @notice Maximum number of seconds to hold an open hedge before a time-based
    ///         exit fires. Default: 30 days.
    uint256 public maxHoldingPeriod;

    /// @notice Fraction of posted collateral that the strategy is willing to lose
    ///         (net unrealised PnL) before the capital-protection exit fires.
    ///         Expressed in bps: default 9000 = 90 % protected → exit when loss > 10 % of collateral.
    ///         Higher value = tighter stop (less loss tolerated).
    uint256 public profitProtectionRatioBps;

    // ─── Vault State ──────────────────────────────────────────────────────────

    uint256 public totalDeposited;    // Total USDC deposited (6 dec)
    uint256 public totalShares;       // Total shares outstanding (18 dec, 1:1 with USDC initially)
    uint256 public hedgeCollateral;   // USDC currently locked in the perp engine

    bool    public hedgeIsOpen;
    int256  public currentDailyFundingRateBps; // Last known funding rate (set at openHedge)

    // ─── Hedge Entry Snapshot (for exit logic) ────────────────────────────────

    uint256 public hedgeOpenTimestamp;  // block.timestamp when openHedge was called
    uint256 public hedgeNotional;       // Notional recorded at openHedge (6 dec)

    // ─── Per-User Accounting ──────────────────────────────────────────────────

    struct UserInfo {
        uint256 shares;           // Proportional claim on vault
        uint256 principal;        // USDC deposited (6 dec)
        uint256 depositTimestamp; // For lending yield accrual
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
        int256 pricePnL,
        int256 fundingPnL,
        int256 netPnL,
        uint256 proceedsReturned
    );
    event LendingAPYUpdated(uint256 oldValue, uint256 newValue);
    event AutoExitTriggered(string reason, int256 netPnL);

    // ─── Constructor ──────────────────────────────────────────────────────────

    /// @param initialOwner  Deployer / strategy manager
    /// @param usdc_         MockUSDC (or real USDC) address
    /// @param perpEngine_   MockPerpEngine address
    /// @param oracle_       Price oracle address
    constructor(
        address initialOwner,
        address usdc_,
        address perpEngine_,
        address oracle_
    ) Ownable(initialOwner) {
        require(usdc_       != address(0), "StrategyVault: zero usdc");
        require(perpEngine_ != address(0), "StrategyVault: zero engine");
        require(oracle_     != address(0), "StrategyVault: zero oracle");

        usdc        = IERC20(usdc_);
        perpEngine  = IPerpEngine(perpEngine_);
        oracle      = IPriceOracle(oracle_);

        lendingAPYBps              = 500;    // 5 % APY
        riskPremiumPerLeverageUnit = 75;     // 75 bps added to threshold per unit of leverage
        costEstimateBps            = 50;     // 0.5 % round-trip cost estimate
        safetyMarginBps            = 800;    // exit before reaching 500 bps liquidation threshold
        maxHoldingPeriod           = 30 days;
        profitProtectionRatioBps   = 9000;   // exit when net loss exceeds 10 % of posted collateral
    }

    // ─── IStrategyVault: Mutating ─────────────────────────────────────────────

    /// @inheritdoc IStrategyVault
    /// @dev Shares are minted 1:1 with USDC on the first deposit.
    ///      Subsequent deposits receive shares proportional to their contribution
    ///      relative to total vault value.
    function deposit(uint256 usdcAmount) external override nonReentrant {
        require(usdcAmount > 0, "StrategyVault: zero amount");

        // Settle existing lending yield for this user before updating their principal
        _settleLendingYield(msg.sender);

        // Calculate shares to mint
        uint256 sharesToMint;
        if (totalShares == 0) {
            // First deposit: 1 share = 1 USDC (scaled to 1e18 for precision)
            sharesToMint = usdcAmount * 1e12; // convert 6-dec USDC to 18-dec shares
        } else {
            // Proportional: newShares = usdcAmount * totalShares / totalVaultValue
            uint256 vaultValue = _getTotalVaultValue();
            sharesToMint = (usdcAmount * totalShares) / vaultValue;
        }

        usdc.safeTransferFrom(msg.sender, address(this), usdcAmount);

        userInfo[msg.sender].shares           += sharesToMint;
        userInfo[msg.sender].principal        += usdcAmount;
        userInfo[msg.sender].depositTimestamp  = block.timestamp;
        totalShares    += sharesToMint;
        totalDeposited += usdcAmount;

        emit Deposited(msg.sender, usdcAmount, sharesToMint);
    }

    /// @inheritdoc IStrategyVault
    /// @dev Withdraws the user's proportional share of the vault.
    ///      Lending yield is settled and included in the withdrawal.
    ///      Reverts if the hedge is open (collateral is locked in perpEngine).
    ///
    ///      TODO: allow partial withdrawal of non-hedged idle USDC if needed.
    function withdraw(uint256 shares) external override nonReentrant {
        UserInfo storage info = userInfo[msg.sender];
        require(shares > 0,            "StrategyVault: zero shares");
        require(shares <= info.shares, "StrategyVault: insufficient shares");
        require(!hedgeIsOpen,          "StrategyVault: hedge is open, close first");

        // Settle lending yield so it is included in the payout
        _settleLendingYield(msg.sender);

        // User's proportional claim on the vault
        uint256 vaultValue  = _getTotalVaultValue();
        uint256 userValue   = (shares * vaultValue) / totalShares;

        require(
            usdc.balanceOf(address(this)) >= userValue,
            "StrategyVault: insufficient liquidity"
        );

        info.shares   -= shares;
        totalShares   -= shares;

        // Adjust principal proportionally
        uint256 principalReduction = (shares * info.principal) / (info.shares + shares);
        if (info.principal >= principalReduction) {
            info.principal -= principalReduction;
        } else {
            info.principal = 0;
        }
        totalDeposited = totalDeposited >= userValue ? totalDeposited - userValue : 0;

        usdc.safeTransfer(msg.sender, userValue);

        emit Withdrawn(msg.sender, shares, userValue);
    }

    /// @inheritdoc IStrategyVault
    /// @notice Open a short ETH hedge on MockPerpEngine. Owner / manager only.
    ///
    ///         Steps:
    ///         1. Compute carry score using current lending APY + supplied funding rate.
    ///         2. Revert if carry score does not meet the minimum threshold.
    ///         3. Approve perpEngine to spend `collateral` USDC.
    ///         4. Call perpEngine.openShort().
    ///         5. Record hedge state.
    ///
    /// @param notional                 Notional size of short in USDC (6 dec)
    /// @param collateral               Margin to post in USDC (6 dec)
    /// @param dailyFundingRateBps_     Current observed daily funding rate in bps
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

        // ── Dynamic carry threshold ────────────────────────────────────────────
        // Threshold scales with leverage so that higher-risk positions require
        // proportionally higher expected carry before entry is permitted.
        // threshold = costEstimate + (leverageRatio × riskPremiumPerLeverageUnit)
        uint256 leverageRatio      = notional / collateral; // integer division, e.g. 5 for 5x
        int256  dynamicThreshold   = int256(costEstimateBps + leverageRatio * riskPremiumPerLeverageUnit);

        int256 carryScore = ArbitrageMath.calcCarryScore(
            lendingAPYBps,
            dailyFundingRateBps_,
            costEstimateBps
        );
        require(
            ArbitrageMath.isCarryViable(carryScore, dynamicThreshold),
            "StrategyVault: carry score below dynamic threshold"
        );

        // ── Open position ──────────────────────────────────────────────────────
        usdc.approve(address(perpEngine), collateral);
        perpEngine.openShort(notional, collateral);

        hedgeIsOpen                = true;
        hedgeCollateral            = collateral;
        hedgeNotional              = notional;
        hedgeOpenTimestamp         = block.timestamp;
        currentDailyFundingRateBps = dailyFundingRateBps_;

        uint256 entryPrice = oracle.getPrice();
        emit HedgeOpened(notional, collateral, entryPrice, carryScore);
    }

    /// @inheritdoc IStrategyVault
    /// @notice Close the active hedge and receive proceeds back. Owner / manager only.
    function closeHedge() external override onlyOwner {
        require(hedgeIsOpen, "StrategyVault: no open hedge");

        uint256 balanceBefore = usdc.balanceOf(address(this));
        uint256 proceeds      = perpEngine.closeShort();
        uint256 balanceAfter  = usdc.balanceOf(address(this));

        // Compute how much USDC came back
        uint256 actualReceived = balanceAfter - balanceBefore;

        int256 netPnL = int256(actualReceived) - int256(hedgeCollateral);

        hedgeIsOpen        = false;
        hedgeCollateral    = 0;
        hedgeNotional      = 0;
        hedgeOpenTimestamp = 0;

        emit HedgeClosed(0, 0, netPnL, actualReceived);

        // Suppress unused variable warning
        (proceeds);
    }

    // ─── IStrategyVault: View ──────────────────────────────────────────────────

    /// @inheritdoc IStrategyVault
    function getVaultState() external view override returns (VaultState memory state) {
        state.totalDeposited    = totalDeposited;
        state.totalShares       = totalShares;
        state.hedgeCollateral   = hedgeCollateral;
        state.hedgeIsOpen       = hedgeIsOpen;

        // Lending yield accrued vault-wide (approximation: treat all deposits as one)
        // A more precise implementation would iterate per-user and sum.
        // For the report this vault-wide figure is sufficient.
        // TODO: precise per-user yield tracking.
        state.lendingYieldAccrued = 0; // placeholder — see getUserValue for per-user yield

        if (hedgeIsOpen) {
            state.fundingIncomeTotal = perpEngine.getUnrealizedPnL(address(this));
            state.shortPricePnL      = 0; // included in fundingIncomeTotal via getUnrealizedPnL
            state.netPnL             = state.fundingIncomeTotal;
            state.marginRatioBps     = perpEngine.getMarginRatio(address(this));
            state.marginIsHealthy    = !perpEngine.isLiquidatable(address(this));
        }

        state.carryScore = ArbitrageMath.calcCarryScore(
            lendingAPYBps,
            currentDailyFundingRateBps,
            costEstimateBps
        );
    }

    /// @inheritdoc IStrategyVault
    /// @notice Returns user's USDC-equivalent value including accrued lending yield.
    function getUserValue(address user)
        external
        view
        override
        returns (uint256 usdcValue)
    {
        UserInfo storage info = userInfo[user];
        if (info.shares == 0) return 0;

        uint256 lendingYield = ArbitrageMath.calcLendingYield(
            info.principal,
            lendingAPYBps,
            block.timestamp - info.depositTimestamp
        );

        // User's proportional share of total vault value, plus their unsettled lending yield
        uint256 vaultValue = _getTotalVaultValue();
        uint256 shareValue = totalShares > 0
            ? (info.shares * vaultValue) / totalShares
            : 0;

        usdcValue = shareValue + lendingYield;
    }

    /// @inheritdoc IStrategyVault
    /// @notice Quick viability check for the frontend — does NOT revert.
    function isCarryViable(int256 dailyFundingRateBps_)
        external
        view
        override
        returns (bool)
    {
        int256 score = ArbitrageMath.calcCarryScore(
            lendingAPYBps,
            dailyFundingRateBps_,
            costEstimateBps
        );
        // For the view check, require score > 0 (positive carry).
        // Actual entry uses the leverage-adjusted dynamic threshold in openHedge.
        return ArbitrageMath.isCarryViable(score, 0);
    }

    // ─── Exit Logic ───────────────────────────────────────────────────────────

    /// @notice Evaluates whether any exit condition is currently triggered.
    ///
    ///         Four conditions are checked in priority order:
    ///
    ///         1. MARGIN  — margin ratio has fallen below safetyMarginBps.
    ///                      Highest priority: prevents forced liquidation.
    ///
    ///         2. CAPITAL — net unrealised PnL (price + funding combined) has turned
    ///                      negative and the absolute loss exceeds (1 − profitProtectionRatio)
    ///                      of posted collateral. Default: exit when loss > 10 % of collateral.
    ///
    ///         3. CARRY   — current carry score has turned negative.
    ///                      The income stream is gone; no reason to stay in.
    ///
    ///         4. TIME    — hedge has been open longer than maxHoldingPeriod.
    ///                      Backstop exit to bound total exposure duration.
    ///
    /// @return triggered  True if any condition is met.
    /// @return reason     Short description of the first triggered condition.
    function shouldAutoExit()
        external
        view
        returns (bool triggered, string memory reason)
    {
        if (!hedgeIsOpen) return (false, "no open hedge");

        // ── 1. Margin safety ──────────────────────────────────────────────────
        uint256 marginRatio = perpEngine.getMarginRatio(address(this));
        if (marginRatio < safetyMarginBps) {
            return (true, "MARGIN: below safety threshold");
        }

        // ── 2. Capital protection ─────────────────────────────────────────────
        // Exits when unrealised net PnL (price + funding combined) has turned
        // negative AND the absolute loss exceeds the allowed fraction of posted
        // collateral.
        //
        // allowedLoss = collateral × (1 − profitProtectionRatioBps / 10_000)
        //
        // With the default profitProtectionRatioBps = 9000 (90 %):
        //   allowedLoss = collateral × 10 %
        //   e.g. $8 000 collateral → exit fires if net loss > $800
        //
        // Note: getUnrealizedPnL() returns funding income + price PnL combined.
        // A rising ETH price erodes margin faster than funding income accumulates,
        // so a net negative value signals the position is losing more than earning.
        int256 unrealisedPnL = perpEngine.getUnrealizedPnL(address(this));
        if (unrealisedPnL < 0) {
            uint256 absLoss      = uint256(-unrealisedPnL);
            uint256 allowedLoss  = (hedgeCollateral * (10_000 - profitProtectionRatioBps)) / 10_000;
            if (absLoss > allowedLoss) {
                return (true, "CAPITAL: net loss exceeds collateral protection threshold");
            }
        }

        // ── 3. Carry gone ─────────────────────────────────────────────────────
        // Uses currentDailyFundingRateBps which is recorded at openHedge time.
        // This reflects the funding environment at entry; it is NOT updated in real
        // time as market conditions change. To react to a funding rate reversal after
        // entry, the owner should call closeHedge() or autoClose() directly, or use
        // the margin condition above which will eventually trigger regardless.
        int256 carryScore = ArbitrageMath.calcCarryScore(
            lendingAPYBps,
            currentDailyFundingRateBps,
            costEstimateBps
        );
        if (carryScore <= 0) {
            return (true, "CARRY: entry carry score is non-positive");
        }

        // ── 4. Time limit ─────────────────────────────────────────────────────
        if (block.timestamp >= hedgeOpenTimestamp + maxHoldingPeriod) {
            return (true, "TIME: maximum holding period reached");
        }

        return (false, "no exit condition triggered");
    }

    /// @notice Closes the hedge automatically if any exit condition is met.
    ///         Callable by anyone — the owner does not need to monitor manually.
    ///         Reverts if no exit condition is triggered (prevents premature closure).
    function autoClose() external nonReentrant {
        require(hedgeIsOpen, "StrategyVault: no open hedge");

        (bool triggered, string memory reason) = this.shouldAutoExit();
        require(triggered, "StrategyVault: no exit condition triggered");

        uint256 balanceBefore  = usdc.balanceOf(address(this));
        uint256 proceeds       = perpEngine.closeShort();
        uint256 balanceAfter   = usdc.balanceOf(address(this));
        uint256 actualReceived = balanceAfter - balanceBefore;
        int256  netPnL         = int256(actualReceived) - int256(hedgeCollateral);

        hedgeIsOpen        = false;
        hedgeCollateral    = 0;
        hedgeNotional      = 0;
        hedgeOpenTimestamp = 0;

        emit AutoExitTriggered(reason, netPnL);
        emit HedgeClosed(0, 0, netPnL, actualReceived);

        (proceeds);
    }

    // ─── Admin ────────────────────────────────────────────────────────────────

    /// @notice Update the lending APY. Owner only.
    function setLendingAPY(uint256 newAPYBps) external onlyOwner {
        require(newAPYBps <= 10_000, "StrategyVault: APY too high");
        emit LendingAPYUpdated(lendingAPYBps, newAPYBps);
        lendingAPYBps = newAPYBps;
    }

    /// @notice Update the risk premium per leverage unit. Owner only.
    function setRiskPremiumPerLeverageUnit(uint256 newPremiumBps) external onlyOwner {
        riskPremiumPerLeverageUnit = newPremiumBps;
    }

    /// @notice Update the cost estimate. Owner only.
    function setCostEstimate(uint256 newCostBps) external onlyOwner {
        costEstimateBps = newCostBps;
    }

    /// @notice Update the safety margin threshold for auto-exit. Owner only.
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

    /// @dev Mints lending yield into the user's principal so it compounds on
    ///      subsequent actions. Resets depositTimestamp.
    function _settleLendingYield(address user) internal {
        UserInfo storage info = userInfo[user];
        if (info.principal == 0 || info.depositTimestamp == 0) return;

        uint256 yield = ArbitrageMath.calcLendingYield(
            info.principal,
            lendingAPYBps,
            block.timestamp - info.depositTimestamp
        );

        if (yield > 0) {
            // Add accrued yield to principal (simple compounding)
            // NOTE: In a real system the vault would need to source this yield
            //       from actual lending protocol income. Here it is minted from
            //       vault reserves. For the course project this is acceptable.
            info.principal        += yield;
            totalDeposited        += yield;
        }

        info.depositTimestamp = block.timestamp;
    }

    /// @dev Total vault value = idle USDC balance + collateral locked in perp engine.
    ///      Unrealised P&L on the hedge is NOT included here to avoid oracle dependency
    ///      in share price calculations. A more advanced version would include it.
    ///      TODO: include unrealised PnL in vault value for accurate share pricing.
    function _getTotalVaultValue() internal view returns (uint256) {
        return usdc.balanceOf(address(this)) + hedgeCollateral;
    }
}
