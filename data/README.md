# Data Directory

Place the combined hourly dataset in `data/raw/` before running the backtest.
The `data/processed/` folder is auto-generated — do not edit it manually.

---

## File Required

### `data/raw/eth_cash_carry_*.csv`

A combined hourly bar file containing Coinbase spot ETH/USD and Deribit perpetual ETH/USD.

The backtest auto-detects any file matching the pattern `eth_cash_carry*.csv` in `data/raw/`.

**Expected columns (31 total, key ones listed):**

| Column              | Description                                          |
|---------------------|------------------------------------------------------|
| `timestamp`         | Hourly UTC timestamp (e.g. `2026-02-28 00:00:00+00:00`) |
| `spot_price_close`  | ETH/USD spot close price (Coinbase)                  |
| `perp_price_close`  | ETH/USD perpetual close price (Deribit)              |
| `basis_pct`         | `(perp − spot) / spot × 100` — percentage basis     |
| `log_basis_bps`     | `ln(perp / spot) × 10 000` — log basis in bps       |
| `funding_rate`      | Hourly funding rate sum (may contain NaN — filled with 0) |

**Example rows:**
```
timestamp,spot_price_close,perp_price_close,basis_pct,log_basis_bps,...
2026-02-28 00:00:00+00:00,1932.38,1931.15,-0.0637,-6.37,...
2026-02-28 01:00:00+00:00,1924.30,1924.50, 0.0104, 1.04,...
```

---

## Strategy Interpretation

The backtest uses `basis_pct` and `log_basis_bps` as the primary carry metrics:

- **Contango** (basis > 0, perp > spot): short perp earns positive carry
- **Backwardation** (basis < 0, perp < spot): short perp pays carry

Annualised carry ≈ `mean(log_basis_bps) × 365`

Position PnL is computed from **actual price moves** (model-free):
- Long spot PnL = `notional × (spot_close_t / spot_close_{t−1} − 1)`
- Short perp PnL = `−notional × (perp_close_t / perp_close_{t−1} − 1)`
- Net carry = sum of both (≈ basis compression each day)

---

## What Gets Generated

After running `python backtest/run_backtest.py` (primary):

```
output/tables/
  backtest_hourly.csv  ← hourly P&L breakdown
  backtest_metrics.csv ← scalar performance metrics

output/charts/
  chart1_cumulative_pnl.png
  chart2_drawdown.png
  chart3_pnl_decomposition.png
```

After running `python backtest/main.py` (legacy daily-aggregation backtest):

```
data/processed/
  merged_daily.csv     ← daily aggregation of hourly data

output/tables/
  backtest_daily.csv
  backtest_summary.csv

output/charts/
  chart1_cumulative_pnl.png  chart2_funding_rate.png
  chart3_pnl_decomposition.png  chart4_drawdown.png  chart5_carry_score.png
```

---

## Adding More Data

To extend the backtest period, add more files matching `eth_cash_carry*.csv` to `data/raw/`.
The loader will pick the most recently named file. For multiple files, concatenate them
into a single CSV (ensuring no duplicate timestamps).
