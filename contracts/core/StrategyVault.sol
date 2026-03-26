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

    /// @notice Minimum annualised carry score required to open a hedge, in bps.
    ///         Default: 200 bps (2 %). Below this the expected edge is too thin.
    int256 public minCarryThresholdBps;

    /// @notice Estimated round-trip cost (gas + slippage), annualised bps.
    ///         Used in carry score calculation.
    ///         Default: 50 bps.
    uint256 public costEstimateBps;

    // ─── Vault State ──────────────────────────────────────────────────────────

    uint256 public totalDeposited;    // Total USDC deposited (6 dec)
    uint256 public totalShares;       // Total shares outstanding (18 dec, 1:1 with USDC initially)
    uint256 public hedgeCollateral;   // USDC currently locked in the perp engine

    bool    public hedgeIsOpen;
    int256  public currentDailyFundingRateBps; // Last known funding rate (set at openHedge)

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
    event CarryThresholdUpdated(int256 oldValue, int256 newValue);

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

        lendingAPYBps         = 500;   // 5 % APY
        minCarryThresholdBps  = 200;   // 2 % minimum annualised carry
        costEstimateBps       = 50;    // 0.5 % round-trip cost estimate
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

        // ── Carry viability check ──────────────────────────────────────────────
        // The strategy only opens when the annualised carry (lending + funding − costs)
        // exceeds the configured minimum threshold.
        int256 carryScore = ArbitrageMath.calcCarryScore(
            lendingAPYBps,
            dailyFundingRateBps_,
            costEstimateBps
        );
        require(
            ArbitrageMath.isCarryViable(carryScore, minCarryThresholdBps),
            "StrategyVault: carry score below threshold"
        );

        // ── Open position ──────────────────────────────────────────────────────
        usdc.approve(address(perpEngine), collateral);
        perpEngine.openShort(notional, collateral);

        hedgeIsOpen                = true;
        hedgeCollateral            = collateral;
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

        hedgeIsOpen     = false;
        hedgeCollateral = 0;

        // TODO: decompose netPnL into pricePnL vs fundingPnL for cleaner reporting.
        //       Currently emitted as (0, 0, netPnL) — extend after full integration.
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
        return ArbitrageMath.isCarryViable(score, minCarryThresholdBps);
    }

    // ─── Admin ────────────────────────────────────────────────────────────────

    /// @notice Update the lending APY. Owner only.
    function setLendingAPY(uint256 newAPYBps) external onlyOwner {
        require(newAPYBps <= 10_000, "StrategyVault: APY too high");
        emit LendingAPYUpdated(lendingAPYBps, newAPYBps);
        lendingAPYBps = newAPYBps;
    }

    /// @notice Update the minimum carry threshold. Owner only.
    function setMinCarryThreshold(int256 newThresholdBps) external onlyOwner {
        emit CarryThresholdUpdated(minCarryThresholdBps, newThresholdBps);
        minCarryThresholdBps = newThresholdBps;
    }

    /// @notice Update the cost estimate. Owner only.
    function setCostEstimate(uint256 newCostBps) external onlyOwner {
        costEstimateBps = newCostBps;
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
