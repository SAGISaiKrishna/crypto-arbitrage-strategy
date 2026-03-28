# Design and Analysis of a Crypto Arbitrage Strategy Using Perpetual Futures Hedging

**Course:** [Course Name]
**Team:** [Names]
**Date:** [Date]
**Testnet:** Sepolia
**Repository:** [GitHub URL]

---

## Abstract

> TODO: 3–4 sentences. State: (1) what the strategy is, (2) what you built, (3) key finding from simulation.
>
> Example: "This project designs and implements a carry-based crypto arbitrage strategy that simultaneously extracts lending yield and perpetual futures funding rate income from a USDC deposit. We built and deployed five verified Solidity smart contracts on the Sepolia testnet, including a Chainlink oracle integration. Quantitative scenario analysis across four market regimes shows that the strategy generates a positive annualised return of X% in contango conditions but produces a net loss when funding turns persistently negative (backwardation)."

---

## 1. Introduction

### 1.1 Motivation

> TODO: 1 paragraph. Why does this arbitrage opportunity exist in crypto markets?
> Key points: perpetual futures funding mechanism, retail long bias in crypto, structural contango, yield-seeking capital.

### 1.2 Project Objective

> TODO: 1 paragraph. State the dual objective:
> (1) academic: analyse under what conditions the strategy is profitable,
> (2) implementation: deploy a working proof-of-concept on Sepolia.

### 1.3 Scope and Limitations

> TODO: explicitly state what this is NOT:
> - Not a live trading system
> - Not connected to a real exchange
> - Simulation uses assumed parameters, not historical data
> - MockPerpEngine simulates mechanics, not real order flow

### 1.4 Report Structure

This report is organised as follows: Section 2 provides background on perpetual futures and funding rates. Section 3 describes the strategy methodology. Section 4 presents the mathematical model. Section 5 covers the smart contract design. Section 6 covers oracle design. Section 7 covers deployment and verification. Section 8 presents simulation results. Section 9 describes the frontend. Section 10 covers gas analysis. Section 11 discusses risks and limitations. Section 12 concludes.

---

## 2. Background

### 2.1 Perpetual Futures and Funding Rates

> TODO: explain perpetual futures in plain English. Key concepts:
> - No expiry date (unlike regular futures)
> - Funding rate mechanism keeps mark price close to spot price
> - Every 8 hours (on most exchanges): longs pay shorts (or vice versa)
> - Rate is determined by: (mark price − spot price) / spot price

### 2.2 Why Contango Creates Structural Short Yield

> TODO: explain the crypto retail long bias → systematic demand for long exposure →
> funding rate is systematically positive in bull markets → shorts systematically receive income.
> Reference: historical funding rates on Binance/dYdX (cite approximate figures).

### 2.3 Comparison to Traditional Carry Trades

> TODO: briefly compare to FX carry trade, bond carry, commodity basis trade.
> The strategy is analogous to: deposit USD → earn T-bill yield + sell futures premium.

---

## 3. Strategy Methodology

### 3.1 Overview

[See docs/strategy.md for full text — paste here before submission]

### 3.2 The Carry Condition

```
carryScore = lendingAPYBps + (dailyFundingRateBps × 365) − costBps

dynamicThreshold = costBps + (leverageRatio × riskPremiumPerUnit)
  e.g. 5x leverage: threshold = 50 + (5 × 75) = 425 bps

Open   when: carryScore > dynamicThreshold (leverage-scaled)
Close  when: (1) marginRatio < 800 bps  OR
             (2) net loss > 10% of collateral  OR
             (3) carry score at entry ≤ 0  OR
             (4) holding period > 30 days
```

### 3.3 Cash Flow Diagram

```
User deposits USDC
        │
        ▼
StrategyVault
        │
        ├── Lending yield accrues on principal (5% APY)
        │
        └── [hedge open] → MockPerpEngine (short ETH perp)
                                │
                                ├── Funding income (contango)
                                └── Price PnL (positive if ETH falls)
```

### 3.4 Where Profit Comes From

| Source | Driver | Risk |
|--------|--------|------|
| Lending yield | USDC demand in money markets | Rate compression |
| Funding income | Long demand for ETH leverage | Backwardation |
| Price PnL | ETH price falling | ETH price rising |

### 3.5 Retained Directional Risk

Unlike a true delta-neutral cash-and-carry, this strategy holds only the short leg. It retains negative ETH delta. The simulation explicitly studies this trade-off.

---

## 4. Mathematical Model

[See docs/formulas.md for all formulas — paste here before submission]

### 4.1 Worked Numerical Example (Day 1–5)

> TODO: fill this table after running the simulation.

| Day | ETH Price | Lending Yield | Funding Income | Price PnL | Net Daily PnL | Cumulative PnL |
|-----|-----------|---------------|----------------|-----------|---------------|----------------|
| 0   | $2 000    | $0            | $0             | $0        | −$50 (entry)  | −$50           |
| 1   | $2 000    | $13.70        | $30.00         | $0        | $43.70        | −$6.30         |
| 2   | $2 000    | $13.70        | $30.00         | $0        | $43.70        | $37.40         |
| ... | ...       | ...           | ...            | ...       | ...           | ...            |

> (Example: $100 000 capital, 5% APY lending, 3 bps/day funding on $100 000 notional)

---

## 5. Smart Contract Design

### 5.1 Architecture Overview

[See docs/architecture.md — paste diagram here before submission]

### 5.2 Contract Descriptions

#### ArbitrageToken (CARB)
- Standard OpenZeppelin ERC20, 18 decimals
- Name: "Crypto Arbitrage Token", Symbol: CARB
- Max supply: 10 000 000 CARB, minted to deployer
- Purpose: satisfies course ERC20 deployment requirement

#### MockUSDC
- Mintable ERC20, 6 decimals (matching real USDC)
- Owner can mint arbitrary amounts for testing

#### IPriceOracle / MockPriceOracle / ChainlinkPriceOracle
- Interface-based oracle abstraction
- MockPriceOracle: settable price for local tests
- ChainlinkPriceOracle: wraps AggregatorV3Interface, normalises to 18 decimals, includes staleness check

#### ArbitrageMath (library)
- Pure math library: all financial formulas in isolation
- Testable independently via ArbitrageMathHarness
- Functions: calcShortPricePnL, calcFundingPayment, calcLendingYield, calcMarginRatio, calcHealthFactor, calcCarryScore, isCarryViable, calcBreakEvenDays

#### MockPerpEngine
- Tracks one short position per address
- Funding accrues continuously (per second, via block.timestamp)
- Key functions: openShort, closeShort, accrueFunding, getUnrealizedPnL, getMarginRatio, isLiquidatable, liquidate

#### StrategyVault
- Main orchestrator
- Accepts USDC deposits, tracks internal shares
- Accrues lending yield on-chain (simple interest per second)
- openHedge / closeHedge: owner only
- Viability gate: carryScore must exceed a leverage-scaled dynamic threshold before hedge opens

### 5.3 Key Function: openHedge

```solidity
function openHedge(uint256 notional, uint256 collateral, int256 dailyFundingRateBps)
    external onlyOwner
{
    // 1. Compute carry score
    // 2. Require carryScore > dynamicThreshold (= costBps + leverageRatio × riskPremium)
    // 3. Approve perpEngine to spend collateral
    // 4. Call perpEngine.openShort(notional, collateral)
    // 5. Record hedge state
}
```

### 5.4 Security Measures
- ReentrancyGuard on all state-changing functions
- SafeERC20 for all token transfers
- Ownable with OZ v5 (constructor requires explicit owner address)
- Oracle staleness check (ChainlinkPriceOracle only)
- CEI pattern (Checks-Effects-Interactions) in closeShort

---

## 6. Oracle Design

### 6.1 Interface Abstraction

```solidity
interface IPriceOracle {
    function getPrice()   external view returns (uint256); // 18 decimals
    function decimals()   external pure returns (uint8);
}
```

### 6.2 Chainlink Integration

- Feed: ETH/USD on Sepolia (`0x694AA1769357215DE4FAC081bf1f309aDC325306`)
- Chainlink answer: 8 decimals → scaled to 18 in `getPrice()`
- Staleness check: reverts if `block.timestamp − updatedAt > 3 600` seconds

### 6.3 Swap Pattern

Deploy script selects the oracle at deploy time:
- `--network localhost` → MockPriceOracle
- `--network sepolia` → ChainlinkPriceOracle

No contract code changes required.

---

## 7. Deployment and Verification

### 7.1 Deployed Contract Addresses (Sepolia)

> TODO: fill after deployment

| Contract | Address | Etherscan |
|----------|---------|-----------|
| MockUSDC | `0x...` | [link] |
| ArbitrageToken (CARB) | `0x...` | [link] |
| ChainlinkPriceOracle | `0x...` | [link] |
| MockPerpEngine | `0x...` | [link] |
| StrategyVault | `0x...` | [link] |

### 7.2 Etherscan Screenshots

> TODO: add screenshots from screenshots/ folder

- [ ] CARB token page (Etherscan verified)
- [ ] StrategyVault page (Etherscan verified)
- [ ] openHedge() transaction
- [ ] getVaultState() read call output
- [ ] closeHedge() transaction
- [ ] isCarryViable() output

### 7.3 CARB Token Details

- Name: Crypto Arbitrage Token
- Symbol: CARB
- Decimals: 18
- Total Supply: 10 000 000 CARB
- Contract: `0x...` (Sepolia)

### 7.4 Gas Costs

> TODO: fill from gas-report.txt after running `npm run test:gas`

| Operation | Gas Used | USD Cost (at X gwei) |
|-----------|----------|----------------------|
| deploy StrategyVault | — | — |
| deposit() | — | — |
| openHedge() | — | — |
| accrueFunding() | — | — |
| closeHedge() | — | — |
| withdraw() | — | — |

---

## 8. Quantitative Simulation

### 8.1 Design Rationale

The simulation is a **scenario analysis**, not a historical backtest. Parameters are assumed (see assumptions.csv). This is appropriate because: (a) we do not have access to real exchange data, (b) scenario analysis allows explicit stress-testing of specific market conditions, and (c) the study question is "under what conditions is the strategy viable?" — not "what would have happened historically?"

### 8.2 Simulation Parameters

See `excel/assumptions.csv` for full parameter table.

| Parameter | Value | Notes |
|-----------|-------|-------|
| Capital | $100 000 | Initial USDC deposit |
| Notional | $100 000 | 100% hedge notional |
| Collateral | $20 000 | 20% margin ratio |
| Lending APY | 5% (500 bps) | Configurable |
| Days | 30 | Base horizon |
| Entry cost | 5 bps | Gas + slippage estimate |
| Maintenance margin | 500 bps | Liquidation threshold |

### 8.3 Scenario Descriptions

| Scenario | Price Path | Daily Funding | Lending APY | Key Question |
|----------|-----------|---------------|-------------|--------------|
| Favorable | Flat $2 000 | +5 bps/day | 5% | Best case: how much can we earn? |
| Neutral | Flat $2 000 | +3 bps/day | 5% | Base case: is the trade profitable? |
| Backwardation | Down −20% | −2 bps/day | 3% | Bear market: does the strategy lose money? |
| GBM Volatile | Stochastic (σ=60%) | 2 bps ± 1.5 | 5% | Realistic: what happens with noise? |

### 8.4 Results

> TODO: insert charts from charts/ folder and fill summary table from scenario_summary.csv

**Chart 1: Cumulative Net PnL by Scenario**
[charts/chart1_cumulative_pnl.png]

**Chart 2: Daily PnL Decomposition (Neutral scenario)**
[charts/chart2_daily_decomposition.png]

**Chart 3: Margin Ratio Over Time**
[charts/chart3_margin_ratio.png]

**Chart 4: Edge Score Over Time**
[charts/chart4_edge_score.png]

**Chart 5: Break-Even Heatmap**
[charts/chart5_break_even_heatmap.png]

**Chart 6: Sharpe Ratio Comparison**
[charts/chart6_sharpe_comparison.png]

**Summary Statistics Table:**

> TODO: paste from excel/scenario_summary.csv

### 8.5 Key Findings

> TODO: 3–5 bullet points after reviewing simulation output.
> Example structure:
> - "In the Favorable scenario, the strategy generates $X net profit over 30 days (Y% annualised), with a Sharpe ratio of Z."
> - "Backwardation causes a net loss of $X, driven primarily by funding payments of −$Y."
> - "The strategy break-even at 3 bps/day funding occurs after N days."
> - "Margin ratio never fell below the liquidation threshold in any scenario (flat price)."

---

## 9. Frontend

### 9.1 Description

A minimal HTML/JS dashboard that connects to deployed Sepolia contracts via MetaMask and ethers.js v6. Features: wallet connect, vault state display, deposit, withdraw, open/close hedge, oracle price display.

### 9.2 Screenshot

> TODO: add screenshot from screenshots/frontend.png

---

## 10. Gas Analysis

> TODO: run `npm run test:gas` and paste results from gas-report.txt

Key observations:
- openHedge() is the most gas-intensive operation (calls perpEngine + oracle)
- accrueFunding() is lightweight (single storage write)
- deposit() and withdraw() are comparable to standard ERC20 operations

---

## 11. Limitations and Risks

### 11.1 Mock Exchange vs. Real Exchange
MockPerpEngine does not model order books, slippage, counterparty risk, or settlement delays. Real execution would incur additional costs and risks.

### 11.2 Static Funding Rate Assumption
In the simulation, funding rates are either constant or Gaussian-noisy. Real funding rates exhibit autocorrelation, regime shifts, and spike behaviour. The backwardation scenario is a simplified stress test.

### 11.3 No Real Aave Integration
Lending yield is modelled as a configurable APY, not sourced from a real money market. In practice, APYs are dynamic and can compress significantly.

### 11.4 Oracle Risk
Even with a staleness check, oracle manipulation (price oracle attack) can cause incorrect liquidation triggers. Production systems require TWAP oracles and circuit breakers.

### 11.5 Liquidation Risk
In the Backwardation scenario, the downward ETH price trend causes the short to lose mark-to-market. With real leverage and adverse funding, a 30-day −20% ETH move could force liquidation.

### 11.6 What Would Be Needed for Production
- Real exchange connectivity (dYdX, Binance perp API)
- Dynamic funding rate feed
- Insurance fund for liquidation shortfalls
- Multi-asset collateral support
- Governance and risk parameters management

---

## 12. Conclusion

### 12.1 Summary of Findings

> TODO: 1 paragraph after reviewing results.
> Answer the central research question: "Is this arbitrage viable, and when?"

### 12.2 What We Learned

> TODO: honest reflection. Example topics:
> - Understanding of perpetual futures funding mechanics deepened
> - On-chain math precision (18 vs 6 decimals) requires careful handling
> - Oracle abstraction is a clean pattern for testability
> - Delta-neutral requires both legs; this strategy retains directional risk

### 12.3 Extensions for Future Work

- Implement real Aave lending integration
- Add cross-margin between multiple positions
- Model dynamic funding rates from historical data
- Add a governance layer for risk parameter updates
- Automate hedge management via a keeper bot

---

## Appendix A: Assumptions Table

See `excel/assumptions.csv`.

## Appendix B: Complete Source Code

See `contracts/` directory. All contracts are verified on Etherscan (links in Section 7.1).

## Appendix C: CSV Data

See `excel/` directory:
- `daily_positions_favorable.csv`
- `daily_positions_neutral.csv`
- `daily_positions_backwardation.csv`
- `daily_positions_gbm_volatile.csv`
- `scenario_summary.csv`
- `break_even_analysis.csv`
- `margin_health.csv`

## Appendix D: References

1. Perpetual Protocol Documentation — Funding Rate Mechanism
2. Binance Futures — Funding Rate History
3. Aave Documentation — Interest Rate Model
4. Chainlink Documentation — Price Feeds
5. OpenZeppelin Contracts v5 Documentation
6. "Crypto Carry Trades and Funding Rate Arbitrage" — [cite relevant papers if found]
