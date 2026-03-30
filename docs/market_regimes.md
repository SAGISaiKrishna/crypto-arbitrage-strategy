# Market Regime Analysis

## Overview

The carry strategy's entry and exit signals act as a real-time regime detector.
When the carry gate opens, the market is in a **contango / carry-positive regime**.
When it closes, the market has shifted to a **backwardation / carry-negative regime**.
The transition points in the backtest data map cleanly onto known ETH market phases.

---

## Regime Definitions

Three regimes emerge from the data, defined by the 7-day rolling annualised funding rate
and the direction of ETH price:

### Regime 1 — Bull Contango (Gate Open, Carry High)

| Signal | Condition |
|--------|-----------|
| Carry score | > 500 bps annualised |
| Funding direction | Positive and sustained |
| ETH price | Trending up or at elevated levels |
| Gate behaviour | Opens and stays open for weeks to months |
| Strategy action | Enter and hold |

**What is happening:** Retail demand for leveraged ETH longs is high. Perpetual
mark price sits above spot (contango). Longs pay funding to shorts every 8 hours.
The strategy collects this as income with near-zero price risk.

**Example periods:** Jan 2021 – Jan 2022, Oct 2023 – Apr 2024, late 2024.

---

### Regime 2 — Bear / Backwardation (Gate Closed)

| Signal | Condition |
|--------|-----------|
| Carry score | Below 250 bps or negative |
| Funding direction | Flat, zero, or negative |
| ETH price | Falling or in a sustained downtrend |
| Gate behaviour | Stays closed for weeks to months |
| Strategy action | Out of position, sitting in cash |

**What is happening:** Market de-risking. Leveraged longs are being unwound.
Perpetual trades at or below spot (backwardation). Funding turns zero or negative —
collecting it would mean paying out, not receiving. The strategy correctly stays in cash.

**Example periods:** Jun 2022 – Nov 2022 (post-Terra collapse), early 2023,
late 2025 choppy periods.

---

### Regime 3 — Transitional / Choppy (Gate Churning)

| Signal | Condition |
|--------|-----------|
| Carry score | Oscillating around 250 bps threshold |
| Funding direction | Inconsistent, reversing frequently |
| ETH price | Ranging, no clear trend |
| Gate behaviour | Opens and closes within days |
| Strategy action | Short trades, frequent entries and exits |

**What is happening:** Market is indecisive. Funding flips between positive and negative
on short timeframes. The gate opens briefly on a positive funding spike, then closes
again when it fades. These short trades typically earn little after transaction costs.

**Example periods:** Q3–Q4 2022 (many 1–8 day trades), Mar–Apr 2025, Dec 2025.

---

## Historical Regime Map (Bybit data, Jan 2021 – Mar 2026)

| Year | Avg Carry Score (bps) | % Time Invested | Gross Funding Earned | Regime |
|------|-----------------------|-----------------|----------------------|--------|
| 2021 | 4,293 | 96% | +$11,131 | Bull Contango |
| 2022 | 131 | 58% | +$766 | Bear / Choppy |
| 2023 | 866 | 87% | +$2,182 | Recovery |
| 2024 | 1,321 | 88% | +$4,791 | Bull Contango |
| 2025 | 484 | 74% | +$1,512 | Mixed / Moderate |
| 2026 | 200 | 44% | +$91 | Weakening |

**Key observation:** 2021 contributed $11,131 of the total $20,475 gross funding (54%)
on the back of elevated funding conditions during the bull market. From 2022 onwards,
the strategy still generated positive returns but at a more modest pace. This is why
the full-period Sharpe (6.59) overstates typical performance — 2021 is an outlier, not a baseline.

---

## Entry and Exit Signals by Regime

### How to identify the regime in real time

```
7-day rolling annualised funding rate:

  > 1,000 bps  →  Strong Bull Contango  (enter and hold confidently)
  250–1,000 bps →  Moderate Carry       (enter, but watch for quick reversals)
  0–250 bps    →  Transition Zone       (gate closed, stay in cash)
  < 0 bps      →  Backwardation         (do not enter under any circumstance)
```

### What the gate transitions tell you

| Gate Event | What it signals |
|------------|-----------------|
| Gate opens (cash → in position) | Market has sustained positive funding for 7 days. Contango confirmed. |
| Gate closes (in position → cash) | Funding has faded below the 250 bps threshold. Regime shifting bearish or neutral. |
| Gate opens and closes within 1–3 days | Transitional / choppy regime. Short spike in funding that didn't sustain. |
| Gate stays open for 30+ days | Strong contango regime. Most of the strategy's profit is earned here. |

---

## Notable Regime Transitions (Key Entry/Exit Points)

| Date | Event | ETH Price | Carry Score | Context |
|------|--------|-----------|-------------|---------|
| Jan 2, 2021 | ENTER | $720 | 5,595 bps | Start of 2021 bull run |
| May 25, 2021 | EXIT | $2,713 | 1,095 bps | Funding fading post first leg of bull |
| Jun 24, 2021 | EXIT | $1,938 | −1,062 bps | May 2021 crash, funding negative |
| Jan 30, 2022 | EXIT | $2,568 | −1,040 bps | ETH topping out, funding collapsing |
| Jun 18, 2022 | EXIT | $1,088 | −219 bps | Post-Terra/LUNA collapse |
| Jan 19, 2023 | ENTER | $1,516 | 1,095 bps | Early 2023 recovery |
| Aug 24, 2023 | EXIT | $1,681 | −110 bps | Summer 2023 chop |
| Oct 24, 2023 | ENTER | $1,777 | 1,095 bps | Pre-ETF narrative builds |
| Apr 23, 2024 | EXIT | $3,216 | 399 bps | Post-halving euphoria fading |
| Aug 6, 2024 | EXIT | $2,540 | −485 bps | Yen carry unwind, crypto selloff |
| Mar 10, 2025 | EXIT | $2,035 | −1,668 bps | Funding turns sharply negative |
| Sep 1, 2025 | EXIT | $4,394 | 119 bps | ATH territory, funding fading |

---

## Strategy Behaviour Summary Per Regime

| Regime | Avg holding period | Typical outcome | Risk |
|--------|--------------------|-----------------|------|
| Bull Contango | Weeks to months | Strong funding income, minimal drawdown | Funding reversal |
| Recovery | Days to weeks | Moderate income, some churn | Frequent re-entry costs |
| Bear / Backwardation | N/A (not invested) | Flat (in cash, no loss) | Opportunity cost |
| Transitional / Choppy | 1–5 days | Small gains or small losses after costs | Cost drag from repeated entries |

---

## Why This Matters

The carry gate is essentially a **regime filter**. It is not predicting price direction —
it is identifying whether the structural condition (positive funding) that makes this
trade viable actually exists.

- In bull contango regimes: the gate stays open, income compounds.
- In bear regimes: the gate stays closed, capital is preserved.
- In choppy regimes: the gate churns, which is the main source of cost drag.

The 250 bps threshold was chosen to cover opportunity cost (200 bps) and estimated
transaction costs (~50 bps). Any regime below this threshold does not compensate
the capital being deployed.

---

## Limitations

- Regimes are identified **after the fact** using a 7-day lagged signal. There is no
  forward-looking prediction — the strategy always enters one day late and exits one day late.
- Choppy regimes are the hardest to handle. Short trades (1–3 days) rarely recover
  their entry/exit costs. A minimum holding period filter could reduce this drag.
- The 250 bps threshold is fixed. A dynamic threshold (e.g., based on recent volatility
  or market regime classification) could improve performance in transition periods.
