# Mathematical Formulas

All formulas are implemented in both `contracts/core/ArbitrageMath.sol` (on-chain)
and `simulation/models.py` (Python) using identical logic.

## Notation

| Symbol | Meaning | Units |
|--------|---------|-------|
| N | Notional position size | USDC |
| C | Collateral / margin posted | USDC |
| P₀ | ETH entry price | USD (18 dec on-chain) |
| Pₜ | ETH current price | USD |
| r_f | Daily funding rate | basis points |
| r_L | Lending APY | basis points |
| t | Elapsed seconds | seconds |
| BPS | 10 000 | dimensionless |

---

## 1. Short Position Price PnL

```
shortPricePnL = N × (P₀ − Pₜ) / P₀
```

- Positive when Pₜ < P₀ (ETH fell, short profits)
- Negative when Pₜ > P₀ (ETH rose, short loses)

**Example:** N = $10 000, P₀ = $2 000, Pₜ = $2 200
→ PnL = 10 000 × (2 000 − 2 200) / 2 000 = **−$1 000**

---

## 2. Funding Payment (over elapsed time)

```
fundingPayment = N × r_f × t / (BPS × 86 400)
```

Where t is in seconds, 86 400 = seconds per day.

- Positive: contango (shorts receive from longs)
- Negative: backwardation (shorts pay to longs)

**Example:** N = $10 000, r_f = 3 bps/day, t = 1 day = 86 400s
→ fundingPayment = 10 000 × 3 × 86 400 / (10 000 × 86 400) = **$3.00**

---

## 3. Lending Yield (over elapsed time)

```
lendingYield = C × r_L × t / (BPS × 365 days)
```

**Example:** C = $100 000, r_L = 500 bps, t = 30 days
→ lendingYield = 100 000 × 500 × (30 × 86 400) / (10 000 × 31 536 000) = **$411.00**

---

## 4. Margin Ratio

```
equity       = C + unrealisedPnL
marginRatio  = equity / N × BPS    [in basis points]
```

**Example:** C = $2 000, unrealisedPnL = −$500, N = $10 000
→ marginRatio = (2 000 − 500) / 10 000 × 10 000 = **1 500 bps (15%)**

---

## 5. Health Factor

```
healthFactor = marginRatio / maintenanceMarginBps × 1e18
```

- healthFactor > 1e18: position is safe
- healthFactor < 1e18: position is liquidatable

---

## 6. Carry Score (annualised)

```
carryScore = r_L + (r_f × 365) − costBps    [all in basis points]
```

**Example:** r_L = 500, r_f = 3, costBps = 50
→ carryScore = 500 + 1 095 − 50 = **1 545 bps = 15.45% annualised**

---

## 7. Break-Even Days

```
breakEvenDays = entryCost / dailyNetYield
```

**Example:** entryCost = $50, dailyNetYield = $5
→ breakEvenDays = **10 days**

---

## 8. Annualised Return (from simulation)

```
annualisedReturnBps = (cumulativePnL / principal / elapsedDays) × 365 × BPS
```
