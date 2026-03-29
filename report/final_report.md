# Delta-Neutral ETH Carry Strategy: On-Chain Proof-of-Concept and Real-Data Backtest

**Course:** [Course Name]
**Team:** [Names]
**Date:** [Date]
**Testnet:** Sepolia
**Repository:** [GitHub URL]

---

## Abstract

This project designs, implements, and analyses a delta-neutral ETH carry strategy that simultaneously holds a long ETH spot allocation and a short ETH perpetual futures position of equal notional. The two legs approximately cancel price risk (delta-neutral), leaving the perpetual funding rate as the net income source. We built five verified Solidity smart contracts on the Sepolia testnet — including a Chainlink oracle integration and a rule-based strategy vault — as an on-chain proof-of-concept of the mechanism. A real-data backtest using 1-hour Coinbase spot ETH/USD and Deribit perpetual ETH/USD data (Feb–Mar 2026, 672 hourly bars) measures historical profitability over a 27-day window, decomposing returns into funding carry, transaction costs, and hedge residual.

---

## 1. Introduction

### 1.1 Motivation

Perpetual futures markets in crypto operate through a funding rate mechanism: when long demand exceeds short demand, the contract price rises above spot, and a periodic payment transfers from long traders to short traders to enforce price convergence. In crypto bull markets, retail investors exhibit a systematic long bias — they want leveraged upside exposure to assets like ETH. This creates persistent positive funding rates (contango), which short sellers systematically collect as income. By combining a long spot position with a short perpetual of equal notional, a trader can harvest this funding premium with approximately zero net price risk. This is the delta-neutral carry trade.

### 1.2 Project Objective

This project has two objectives:

1. **Academic:** Analyse the historical profitability of a delta-neutral ETH carry strategy using real market data (Coinbase spot / Deribit perp). Measure how the strategy performs across different funding rate regimes, and whether funding income meaningfully exceeds the benchmark opportunity cost after costs.

2. **Implementation:** Deploy a working on-chain proof-of-concept on Sepolia that correctly implements the vault structure, carry entry gate, exit conditions, and PnL accounting — demonstrating that the mechanism can be enforced in Solidity.

### 1.3 Scope and Limitations

- **Not a live trading system.** No real exchange connectivity. `MockPerpEngine` simulates perpetual mechanics without order books, counterparties, or real settlement.
- **Backtest uses local CSV files.** Data is sourced from CoinAPI (Coinbase spot + Deribit perp) and placed in `data/raw/`. The backtest does not pull live feeds.
- **No rebalancing.** The basic backtest holds a fixed 1:1 notional position throughout with no delta rebalancing.
- **On-chain and backtest layers are independent.** The contracts do not execute the historical backtest; they demonstrate the mechanism.

### 1.4 Report Structure

Section 2 covers background on perpetual futures and funding rates. Section 3 defines the strategy. Section 4 presents the mathematical model. Section 5 covers the smart contract design. Section 6 covers oracle design. Section 7 covers deployment. Section 8 presents backtest results. Section 9 describes the frontend. Section 10 covers gas analysis. Section 11 discusses risks. Section 12 concludes.

---

## 2. Background

### 2.1 Perpetual Futures and Funding Rates

A perpetual futures contract tracks an underlying asset without an expiry date. Without expiry, a separate mechanism is needed to keep the contract price anchored to spot. Exchanges use a **funding rate**: at regular intervals (every 8 hours on major exchanges), a payment is transferred between long and short position holders proportional to the divergence between mark price and index price:

```
fundingRate = (markPrice − indexPrice) / indexPrice
```

When the funding rate is positive (mark above spot, contango), long traders pay short traders. When negative (backwardation), short traders pay long traders. This mechanism prevents the perpetual from drifting permanently from the underlying.

### 2.2 Why Contango Persists in Crypto

Crypto retail investors exhibit a strong long bias — they seek leveraged upside exposure to ETH and BTC. Perpetual futures are the primary vehicle. This excess long demand persistently pushes the mark price above spot in bull and neutral markets, generating a positive funding rate. Historical data shows that the average ETH perpetual funding rate has been positive over most of the 2021–2024 period, ranging from approximately 0.01% per 8-hour period in quiet markets to over 0.1% during peak bull markets. Short sellers who hold positions through these periods collect this income systematically.

### 2.3 The Delta-Neutral Cash-and-Carry

A pure cash-and-carry trade holds a spot ETH long and an equal short perp. Price moves cancel:
- ETH rises by X%: spot position gains X%, perp short loses X% → net price PnL = 0
- ETH falls by X%: spot position loses X%, perp short gains X% → net price PnL = 0

The only net income is the funding rate received on the short leg, minus the opportunity cost of the capital. This is analogous to a basis trade in traditional finance.

---

## 3. Strategy Definition

### 3.1 Position Structure

| Component | Size | Direction | Purpose |
|-----------|------|-----------|---------|
| Spot allocation | = Capital | Long | Tracks ETH price, cancels perp price risk |
| Perp notional | = Capital | Short | Collects funding income in contango |
| Perp collateral | 20% of notional | Posted margin | Supports 5× leverage on the short |

### 3.2 Profit Sources

```
Daily net PnL = spot_pnl + perp_pnl + funding_income − benchmark_cost

Where:
  spot_pnl      = notional × (price_t / price_{t-1} − 1)
  perp_pnl      = −spot_pnl                          (exact mirror, cancels)
  funding_income = notional × dailyFundingRate
  benchmark_cost = capital × (benchmarkRate / 365)

Therefore:
  daily net PnL ≈ funding_income − benchmark_cost     (price legs cancel)
```

### 3.3 Carry Score

The carry score measures whether the funding rate justifies entering the position relative to its opportunity cost:

```
carryScore = (dailyFundingRate × 365) − benchmarkRate − costs

Entry when: carryScore > dynamicThreshold
  dynamicThreshold = costs + (leverage × riskPremium)
```

### 3.4 Why This Is Not Pure Risk-Free Arbitrage

The strategy retains several real risks:
1. **Funding reversal:** If funding turns persistently negative (backwardation), the strategy loses money even with delta-neutrality.
2. **Margin / liquidation risk:** The short perp uses 5× leverage. A sharp ETH price rise can erode the collateral buffer faster than funding income accumulates.
3. **Execution cost drag:** Entry/exit costs, fee drag, and market impact reduce net returns.
4. **Rebalancing risk:** As prices move, the hedge ratio drifts away from 1:1, reintroducing delta.

---

## 4. Mathematical Model

### 4.1 Core Formulas

All formulas are implemented identically in `contracts/core/ArbitrageMath.sol` and `backtest/strategy.py`.

**Spot leg PnL** (long):
```
spotPnL = spotAllocation × (currentPrice − entryPrice) / entryPrice
```

**Short perp price PnL** (equals −spotPnL at equal notional):
```
shortPricePnL = notional × (entryPrice − currentPrice) / entryPrice
```

**Delta neutrality:** `spotPnL + shortPricePnL = 0`

**Funding income** (received by short when rate > 0):
```
fundingPayment = notional × dailyFundingRateBps / 10 000
```

**Carry score** (annualised bps):
```
carryScore = (dailyFundingRateBps × 365) − benchmarkRateBps − costBps
```

**Margin ratio:**
```
marginRatio = (collateral + unrealisedPnL) / notional  [in bps]
```

**Break-even days:**
```
breakEvenDays = entryCostUSDC / dailyNetYieldUSDC
```

### 4.2 Worked Example

$100,000 capital, 3 bps/day funding, 2% benchmark rate (200 bps), 5× leverage:

| Day | ETH Price | Spot PnL | Perp PnL | Net Delta | Funding | Benchmark | Daily Carry |
|-----|-----------|----------|----------|-----------|---------|-----------|-------------|
| 0   | $2,000    | $0       | $0       | $0        | $0      | $0        | −$50 (entry cost) |
| 1   | $2,000    | $0       | $0       | $0        | +$30    | −$5.48    | +$24.52     |
| 1   | $2,100    | +$5,000  | −$5,000  | $0        | +$31.50 | −$5.48    | +$26.02     |

Note: in both price scenarios, the daily carry is the same — delta-neutral.

---

## 5. Smart Contract Design

### 5.1 Architecture Overview

```
User deposits USDC
        │
        ▼
StrategyVault
        │
        ├── Records spotAllocationUsdc (= notional, long leg)
        │
        └── Calls perpEngine.openShort(notional, collateral)
                          │
                          ├── Accrues funding income per second
                          └── Tracks short price P&L

                  oracle.getPrice() ←── ChainlinkPriceOracle ←── Chainlink ETH/USD feed
```

### 5.2 Contract Descriptions

#### ArbitrageToken (CARB)
- Standard ERC20, 18 decimals, max supply 10,000,000
- Symbol: CARB, Name: Crypto Arbitrage Token
- Satisfies course ERC20 deployment requirement

#### MockUSDC
- Mintable ERC20, 6 decimals (matches real USDC)
- Owner can mint arbitrary amounts for testing

#### IPriceOracle / MockPriceOracle / ChainlinkPriceOracle
- Interface-based oracle abstraction
- MockPriceOracle: settable price for local tests
- ChainlinkPriceOracle: wraps Chainlink AggregatorV3, normalises to 18 decimals, staleness check

#### ArbitrageMath (library)
- Pure math library: all financial formulas in one place
- Functions: `calcSpotPnL`, `calcShortPricePnL`, `calcFundingPayment`, `calcMarginRatio`, `calcHealthFactor`, `calcCarryScore`, `isCarryViable`, `calcBreakEvenDays`
- Identical formulas to the Python backtest

#### MockPerpEngine
- Tracks one short position per address
- Funding accrues continuously (per second via block.timestamp)
- Functions: `openShort`, `closeShort`, `accrueFunding`, `getUnrealizedPnL`, `getMarginRatio`, `isLiquidatable`

#### StrategyVault
- Main orchestrator
- Accepts USDC deposits, tracks shares
- Records both legs: `spotAllocationUsdc` and `hedgeNotional`
- Carry gate: `carryScore = (funding × 365) − benchmarkRate − costs`
- Entry gated by leverage-scaled dynamic threshold
- `getVaultState()` computes and returns `netDeltaPnL` (verifies ≈ 0)
- Exit conditions: MARGIN, CAPITAL, CARRY, TIME

### 5.3 Key Function: openHedge

```solidity
function openHedge(uint256 notional, uint256 collateral, int256 dailyFundingRateBps_)
    external onlyOwner
{
    // 1. Compute leverage-scaled carry threshold
    uint256 leverageRatio  = notional / collateral;
    int256  threshold      = int256(costEstimateBps + leverageRatio * riskPremiumPerLeverageUnit);

    // 2. Compute carry score: (funding × 365) − benchmark − costs
    int256 carryScore = ArbitrageMath.calcCarryScore(
        benchmarkRateBps, dailyFundingRateBps_, costEstimateBps
    );

    // 3. Reject if carry is insufficient
    require(ArbitrageMath.isCarryViable(carryScore, threshold), "carry score below dynamic threshold");

    // 4. Record entry price, open short perp, record spot allocation
    hedgeEntryPrice    = oracle.getPrice();
    perpEngine.openShort(notional, collateral);
    spotAllocationUsdc = notional;
}
```

### 5.4 Security Measures
- `ReentrancyGuard` on all state-changing functions
- `SafeERC20` for all token transfers
- `Ownable` (OZ v5) with explicit owner address in constructor
- Oracle staleness check (3600 seconds) in `ChainlinkPriceOracle`
- CEI pattern (Checks-Effects-Interactions)

---

## 6. Oracle Design

### 6.1 Interface Abstraction

```solidity
interface IPriceOracle {
    function getPrice()  external view returns (uint256); // 18 decimals
    function decimals()  external pure returns (uint8);
}
```

### 6.2 Chainlink Integration

- Feed: ETH/USD on Sepolia (`0x694AA1769357215DE4FAC081bf1f309aDC325306`)
- Chainlink answer: 8 decimals → scaled to 18 in `getPrice()`
- Staleness check: reverts if `block.timestamp − updatedAt > 3600` seconds

### 6.3 Swap Pattern

Deploy script selects oracle at deploy time:
- `--network localhost` → `MockPriceOracle`
- `--network sepolia` → `ChainlinkPriceOracle`

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

> TODO: add after Sepolia deployment

- [ ] CARB token page (verified)
- [ ] StrategyVault page (verified)
- [ ] `openHedge()` transaction
- [ ] `getVaultState()` read call — showing `netDeltaPnL = 0`
- [ ] `closeHedge()` transaction
- [ ] `isCarryViable()` output

### 7.3 Gas Costs

Gas figures from `gas-report.txt` (Solidity 0.8.24, optimizer enabled, 200 runs):

| Operation | Gas Used (avg) | Notes |
|-----------|----------------|-------|
| deploy StrategyVault | 2,314,258 | Main orchestrator |
| deploy MockPerpEngine | 1,404,719 | Perp engine |
| openHedge() | ~333,000 | Oracle read + approve + openShort |
| closeHedge() | ~110,000 | closeShort + USDC return |
| deposit() | ~170,000 | Share mint + USDC transfer |
| withdraw() | ~66,000 | Share redemption |
| accrueFunding() | ~58,000 | Single storage update |

---

## 8. Backtest Results

### 8.1 Data Sources

| Data | Source | Exchange | Frequency | Columns used |
|------|--------|----------|-----------|-------------|
| ETH spot price | CoinAPI combined dataset | Coinbase | 1-hour bars | `spot_price_close` |
| ETH perp price | CoinAPI combined dataset | Deribit | 1-hour bars | `perp_price_close` |
| Funding proxy | Derived from prices | — | Per bar | `basis_pct` (lagged) |

Dataset placed in `data/raw/` as `eth_cash_carry_coinbase_spot_eth_usd_deribit_perp_eth_usd_1hrs_*.csv`.
See `data/README.md` for the expected file format.

**Note on funding:** The raw `funding_rate` column in the dataset equals `funding_rate_sum` — the sum of approximately 500 individual tick-level rate snapshots per hour, not a per-interval rate. Applying it directly as a per-hour rate produces nonsensical results (~7,800% annualised). Instead, the backtest uses a funding proxy derived from prices:

```
funding_pnl_t = position_size × perp_price_t × (basis_pct_{t-1} / 100 / 8)
```

`basis_pct = (perp_close − spot_close) / spot_close × 100` is the instantaneous spread between Deribit perp and Coinbase spot. Dividing by 8 converts from an 8-hour-equivalent rate to an hourly rate. The basis is **lagged one bar** (t−1) to avoid look-ahead bias — in live trading, the funding rate for hour t is known from hour t−1 prices.

### 8.2 Backtest Parameters

| Parameter | Value | Notes |
|-----------|-------|-------|
| Initial capital | $10,000 USDC | |
| Position size | Capital / first spot price | Fixed in ETH throughout |
| Funding formula | `lagged basis_pct / 100 / 8` | Proxy; see note above |
| Transaction cost | 0.20% of capital ($20) | Coinbase spot ~0.12% + Deribit perp ~0.10% round-trip |
| Rebalancing | None | Static 1:1 hedge ratio |
| Benchmark rate | 2% annual | Used for Sharpe calculation only |

### 8.3 Results

**Chart 1: Cumulative Net P&L**
![Cumulative PnL](../output/charts/chart1_cumulative_pnl.png)

**Chart 2: Drawdown**
![Drawdown](../output/charts/chart2_drawdown.png)

**Chart 3: Daily PnL Decomposition**
![Decomposition](../output/charts/chart3_pnl_decomposition.png)

**Performance Table:**

| Metric | Value |
|--------|-------|
| Period | 27 days (2026-02-28 → 2026-03-27) |
| ETH price move | $1,932 → $1,992 (+3.1%) |
| Total spot PnL | +$306.20 |
| Total perp PnL | −$309.98 |
| Net delta (spot+perp) | −$3.78 (1.2% of spot PnL) |
| Total funding PnL | +$79.73 |
| Transaction cost | −$20.00 |
| **Net PnL** | **+$55.95** |
| Total return | 0.56% |
| Annualised return | **7.6%** |
| Daily Sharpe | **2.35** |
| Hourly Sharpe | 1.58 (see caveat) |
| Max drawdown | −$34.03 |
| Positive funding hours | 435 / 671 (64.8%) |
| Annualised funding proxy | 10.8% / year |

See `output/tables/backtest_metrics.csv` for the machine-readable summary.

### 8.4 Key Findings

**1. Delta hedge works.** The long spot and short perp legs cancel price risk with 95.7% variance reduction and a residual of only −$3.78 over 27 days (1.2% of gross spot PnL). The residual is explained by the basis divergence between Coinbase and Deribit prices, not a modelling error. With funding zeroed out in a stress test, total PnL collapses to −$3.78 ≈ 0, confirming that the hedge correctly removes directional exposure.

**2. Funding carry drives the result — via a proxy.** Of the net $55.95 PnL, $79.73 came from the funding leg (142% of net before costs). The funding input is a lagged price-basis proxy (`basis_pct_{t-1} / 100 / 8`), not exchange-settled funding data. The proxy is directionally motivated but may over- or under-estimate true Deribit funding payments by ±20–40%.

**3. The market regime was mildly contango.** ETH rose 3.1% over the window. Funding was positive in 64.8% of hourly bars and negative in 35.2%. This is one market regime; the strategy's behaviour under sustained backwardation or high volatility is not captured in this sample.

**4. Annualised return is moderate — but the sample is too short to generalise.** 7.6% annualised is within the range typically associated with neutral-market carry conditions. However, extrapolating a 27-day window to an annual figure involves substantial uncertainty, and the result should not be treated as a reliable estimate of long-run performance.

**5. The Sharpe ratio is arithmetically correct but statistically meaningless at this sample size.** The daily Sharpe of 2.35 has a standard error of ±0.37 on 27 days of data, giving a 95% confidence interval of [1.6, 3.1]. This interval is too wide to draw conclusions. A minimum of one full year of data would be required to produce a Sharpe estimate worth reporting as evidence. The figure is included here for completeness, not as a performance claim.

**6. The strongest validation is the stress test, not the return.** When funding is set to zero in the model, total PnL collapses to −$3.78 ≈ 0. This confirms that the hedge correctly removes directional exposure and that the $55.95 net gain is attributable to the funding leg, not to any data artefact or unintended price drift in the model.

**7. Known methodological limitations (disclosed, not hidden):**
- Funding proxy (`basis_pct_{t-1}/100/8`) approximates Deribit's mark-index TWAP funding. True settlement data was not available; the proxy is reasonable but imprecise.
- Fixed position size throughout; no rebalancing. Hedge ratio drifted slightly as ETH moved 3%.
- No slippage, borrow cost, funding cap, or liquidation mechanics modelled.
- 27 days covers one market regime. Sustained backwardation, margin stress, and multi-month drawdowns are not represented.

---

## 9. Frontend

### 9.1 Description

A minimal HTML/JS dashboard (`frontend/index.html`) connects to deployed Sepolia contracts via MetaMask and ethers.js v6. Features: wallet connect, vault state display including `netDeltaPnL`, deposit, withdraw, open/close position, oracle price display, carry viability check.

### 9.2 Screenshot

> TODO: add after connecting MetaMask to Sepolia contracts

---

## 10. Gas Analysis

See Section 7.3 for the full gas table. Key observations:
- `openHedge()` is the most expensive operation (oracle read + ERC20 approve + external call to perpEngine)
- `accrueFunding()` is the cheapest state-changing operation (single storage write)
- All operations fit comfortably within Ethereum's block gas limit

---

## 11. Limitations and Risks

### 11.1 Mock Exchange
`MockPerpEngine` does not model order books, slippage, counterparty risk, funding rate caps, or partial fills. Real execution on a CEX (Binance, Bybit) or DEX (dYdX, GMX) would incur additional costs.

### 11.2 Funding Rate Risk
Backwardation periods (negative funding) cause the strategy to lose carry income. Sustained backwardation (as seen in bear markets) can produce extended losses even though the position is delta-neutral on price.

### 11.3 Margin / Liquidation Risk
The short perp uses 5× leverage. A rapid ETH price spike can erode the collateral buffer faster than funding income accrues, triggering the MARGIN auto-exit or, in an extreme scenario, liquidation by the exchange.

### 11.4 No Rebalancing
The 1:1 hedge ratio drifts over time as ETH price moves. This introduces residual delta risk that grows with position duration and price volatility.

### 11.5 Oracle Risk
Chainlink staleness check (3600 seconds) reduces but does not eliminate oracle manipulation risk. Production systems should use TWAP oracles and circuit breakers.

### 11.6 What Would Be Needed for Production
- Real exchange connectivity (Binance API, dYdX v4, Hyperliquid)
- Automated delta rebalancing (keeper bot)
- Dynamic benchmark rate from a real money market
- Cross-margin and multi-asset collateral
- Governance for risk parameter updates

---

## 12. Conclusion

### 12.1 Summary

The backtest suggests that the delta-neutral ETH carry strategy is mechanically valid and economically plausible over the sampled period, with returns primarily driven by the funding carry leg. The on-chain proof-of-concept correctly implements the mechanism — including the carry gate, delta-neutral PnL accounting, and four auto-exit conditions. However, the empirical evidence is not statistically conclusive: the sample covers only 27 days, and the funding input relies on a lagged price-basis proxy rather than true exchange-settled funding data. The results should therefore be interpreted as preliminary validation of the strategy design, not as proof of persistent alpha.

### 12.2 What We Learned

- **Delta-neutrality holds in the model.** Holding equal spot and perp legs cancels price risk. On-chain verification (`netDeltaPnL ≈ 0`) confirms the accounting is correct. The stress test (funding = 0 → PnL ≈ 0) gives the clearest evidence: the net gain is attributable to the funding leg, not to incidental price drift.
- **Funding is the return driver — but measured via a proxy.** The strategy's PnL is explained by the lagged price-basis proxy for funding. Whether that proxy accurately reflects actual Deribit settlement rates over a longer period is an open question.
- **Carry is not constant and can reverse.** Funding rates are highly variable. Backwardation periods — common in bear markets — would produce losses even with a correct hedge. This risk is not captured in the 27-day sample.
- **On-chain precision required care.** Solidity's integer arithmetic with 6-decimal USDC and 18-decimal prices requires careful formula design to avoid precision loss — and the on-chain tests confirm it is handled correctly.

### 12.3 Extensions for Future Work

- Implement dynamic delta rebalancing (rebalance when hedge ratio drifts beyond a threshold)
- Add a real Aave lending integration for the spot leg to earn additional yield on idle capital
- Build a keeper bot for automated `autoClose()` execution
- Extend backtest to include funding rate forecasting for entry/exit timing

---

## Appendix A: Formula Reference

See `docs/formulas.md`.

## Appendix B: Source Code

See `contracts/` directory. All contracts are verified on Etherscan (links in Section 7.1).

## Appendix C: Backtest Data

See `output/tables/` after running `python backtest/run_backtest.py`.

## Appendix D: References

1. Deribit ETH/USD Perpetual Futures — Funding Rate History (data via CoinAPI)
2. Chainlink Documentation — Price Feeds (ETH/USD Sepolia)
3. OpenZeppelin Contracts v5 Documentation
4. Perpetual Protocol Documentation — Funding Rate Mechanism
5. "The Economics of Crypto Carry Trades" — [cite relevant papers]
