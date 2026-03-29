# Data

## Dataset

**`data/raw/bybit_eth_usdt_1h.csv`** — Bybit ETHUSDT hourly data, Jan 2021 – Mar 2026.

This is the only dataset used by the backtest. It is not fetched at runtime — the file
must be present before running the backtest.

### Key columns used by the backtest

| Column | Description |
|---|---|
| `datetime_utc` | Hourly UTC timestamp |
| `spot_price` | Bybit ETH spot price (mark price) |
| `perp_close` | Bybit ETHUSDT perpetual close price |
| `funding_rate_last` | Bybit 8h settlement funding rate |

All three come from Bybit, so they are self-consistent.

### Processing done at load time (inside `run_backtest.py`)

1. Parse `datetime_utc` → UTC datetime
2. Rename columns to `spot_price_close` / `perp_price_close`
3. Divide `funding_rate_last` by 8 → per-hour accrual rate
4. Compute `basis_pct` = (perp − spot) / spot × 100
5. Drop duplicate rows and forward-fill a single 6-hour gap (2023-04-05)

## Output

Running `python3 backtest/run_backtest.py` writes to:

```
output/tables/backtest_hourly.csv    hourly PnL breakdown
output/tables/backtest_metrics.csv   scalar performance metrics

output/charts/chart1_cumulative_pnl.png
output/charts/chart2_drawdown.png
output/charts/chart3_pnl_decomposition.png
```

## data/processed/

Empty. Previously used by a legacy pipeline that has been removed.
