# Formulas

These formulas are used in both the Python backtest (`run_backtest.py`) and the
on-chain implementation (`contracts/core/ArbitrageMath.sol`).

---

## 1. Spot PnL (long leg)

```
spot_pnl = position_size × (spot_t − spot_{t-1})
```

Positive when ETH price rises. Offset by the perp leg.

---

## 2. Perp PnL (short leg)

```
perp_pnl = −position_size × (perp_t − perp_{t-1})
```

Negative when ETH price rises. Offsets the spot leg.

---

## 3. Funding PnL

```
funding_pnl = position_size × perp_t × funding_rate_{t-1}
```

`funding_rate` is the Bybit 8h settlement rate divided by 8 (per-hour accrual).
Positive in contango (shorts receive from longs); negative in backwardation.

---

## 4. Basis

```
basis_pct = (perp_close − spot_close) / spot_close × 100
```

Positive = contango. Negative = backwardation.

---

## 5. Carry gate signal

```
annualised_funding_bps = 7d_rolling_avg(daily_mean_funding_rate) × 8760 × 10000

gate_open = annualised_funding_bps > 250
```

---

## 6. On-chain: carry score (ArbitrageMath.sol)

```
carryScore = fundingRateBps × 365 − benchmarkBps − costBps
```

Where `fundingRateBps` is the daily funding rate in basis points.
Position is viable when `carryScore > 0`.

---

## 7. On-chain: margin ratio

```
equity      = collateral + unrealisedPnL
marginRatio = equity / notional × BPS
```

Liquidation threshold: `marginRatio < maintenanceMarginBps`.

---

## 8. On-chain: short position price PnL

```
shortPricePnL = notional × (entryPrice − currentPrice) / entryPrice
```

Positive when price falls (short profits); negative when price rises.

---

## 9. On-chain: funding payment (per elapsed time)

```
fundingPayment = notional × fundingRateBps × elapsedSeconds / (BPS × 86400)
```

`BPS = 10000`, `86400` = seconds per day.
