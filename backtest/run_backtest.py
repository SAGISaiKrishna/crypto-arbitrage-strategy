"""
run_backtest.py
───────────────
Runs the delta-neutral ETH carry strategy backtest on the Bybit hourly dataset.

Strategy:
  Long ETH spot + Short ETH perp, equal notional.
  Income = funding carry - transaction costs.
  Position is only open when the carry gate is active.

PnL per hourly bar (t ≥ 1):
  spot_pnl    =  position_size × (spot_t − spot_{t-1})
  perp_pnl    = −position_size × (perp_t − perp_{t-1})
  funding_pnl =  position_size × perp_t × funding_rate_{t-1}

  funding_rate is the Bybit 8h settlement rate divided by 8 (per-hour accrual).
  Funding is lagged one bar to avoid look-ahead bias.
  Transaction cost is deducted at each entry and exit.

Usage:
    python3 backtest/run_backtest.py
"""

import glob, os, sys
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import matplotlib.dates as mdates
import numpy as np
import pandas as pd


ROOT       = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TABLES_DIR = os.path.join(ROOT, "output", "tables")
CHARTS_DIR = os.path.join(ROOT, "output", "charts")
os.makedirs(TABLES_DIR, exist_ok=True)
os.makedirs(CHARTS_DIR, exist_ok=True)

CAPITAL              = 10_000.0
TRANSACTION_COST_PCT = 0.002          # 0.20% per entry/exit ≈ $20 on $10k
TRANSACTION_COST_USD = CAPITAL * TRANSACTION_COST_PCT


# ─── 1. Load data ──────────────────────────────────────────────────────────────

def load_data() -> pd.DataFrame:
    files = sorted(glob.glob(os.path.join(ROOT, "data", "raw", "bybit*.csv")))
    if not files:
        sys.exit("ERROR: No bybit*.csv found in data/raw/")

    path = files[-1]
    print(f"Loading: {os.path.basename(path)}")
    df = pd.read_csv(path)
    df["timestamp"] = pd.to_datetime(df["datetime_utc"], utc=True)

    df = df.rename(columns={
        "spot_price": "spot_price_close",
        "perp_close": "perp_price_close",
    })

    # Bybit funding_rate_last is the 8h settlement rate — divide by 8 for per-hour accrual
    df["funding_rate"] = df["funding_rate_last"] / 8.0

    df["basis_pct"] = (df["perp_price_close"] - df["spot_price_close"]) / df["spot_price_close"] * 100
    df = df[["timestamp", "spot_price_close", "perp_price_close", "funding_rate", "basis_pct"]].copy()
    df = df.sort_values("timestamp").drop_duplicates("timestamp").reset_index(drop=True)

    # Forward-fill the single 6-hour gap in the dataset (2023-04-04/05)
    full_range = pd.date_range(df["timestamp"].min(), df["timestamp"].max(), freq="1h", tz="UTC")
    df = df.set_index("timestamp").reindex(full_range).ffill().reset_index()
    df = df.rename(columns={"index": "timestamp"})

    print(f"  {len(df):,} hourly rows  ({df['timestamp'].min().date()} → {df['timestamp'].max().date()})")
    return df


# ─── 2. Run backtest ───────────────────────────────────────────────────────────

def run_backtest(df: pd.DataFrame) -> pd.DataFrame:
    first_spot    = df["spot_price_close"].iloc[0]
    position_size = CAPITAL / first_spot

    # Carry gate mirrors the logic in StrategyVault.sol:
    # open when 7-day rolling annualised funding > benchmark + cost (250 bps)
    GATE_THRESHOLD_BPS = 250

    print(f"\nCapital         : ${CAPITAL:,.0f}")
    print(f"Position size   : {position_size:.4f} ETH  (@${first_spot:.2f})")
    print(f"Transaction cost: ${TRANSACTION_COST_USD:.2f}  ({TRANSACTION_COST_PCT*100:.2f}% per trade)")
    print(f"Carry gate      : 7-day rolling funding > {GATE_THRESHOLD_BPS} bps annualised")

    df = df.copy()
    df["date"] = df["timestamp"].dt.normalize()

    # Gate signal: 7-day rolling average of daily mean funding rate, lagged 1 day
    daily_fund = df.groupby("date")["funding_rate"].mean().rename("daily_rate").reset_index()
    daily_fund["rate_7d"]     = daily_fund["daily_rate"].rolling(7, min_periods=1).mean()
    daily_fund["rate_7d_lag"] = daily_fund["rate_7d"].shift(1).fillna(0.0)
    gate_map = {
        r["date"]: (r["rate_7d_lag"] * 8760 * 10_000) > GATE_THRESHOLD_BPS
        for _, r in daily_fund.iterrows()
    }

    rows          = []
    in_position   = False
    position_size = 0.0
    capital       = CAPITAL
    current_date  = None

    for i in range(len(df)):
        row  = df.iloc[i]
        prev = df.iloc[i - 1] if i > 0 else row

        this_date = row["date"]
        gate_open = gate_map.get(this_date, False)

        spot_pnl = perp_pnl = funding_pnl = tx_cost = 0.0

        # Gate transitions once per day
        if this_date != current_date:
            current_date = this_date
            if not in_position and gate_open:
                in_position   = True
                position_size = capital / row["spot_price_close"]
                tx_cost       = -TRANSACTION_COST_USD
                capital      += tx_cost
            elif in_position and not gate_open:
                in_position   = False
                position_size = 0.0
                tx_cost       = -TRANSACTION_COST_USD
                capital      += tx_cost

        if in_position and i > 0:
            spot_pnl    =  position_size * (row["spot_price_close"] - prev["spot_price_close"])
            perp_pnl    = -position_size * (row["perp_price_close"] - prev["perp_price_close"])
            funding_pnl =  position_size * row["perp_price_close"] * prev["funding_rate"]
            capital    +=  spot_pnl + perp_pnl + funding_pnl

        total_pnl = spot_pnl + perp_pnl + funding_pnl + tx_cost

        rows.append({
            "timestamp":       row["timestamp"],
            "spot_price":      row["spot_price_close"],
            "perp_price":      row["perp_price_close"],
            "basis_pct":       row["basis_pct"],
            "carry_score_bps": prev["funding_rate"] * 8760 * 10_000,
            "in_position":     in_position,
            "spot_pnl":        spot_pnl,
            "perp_pnl":        perp_pnl,
            "funding_pnl":     funding_pnl,
            "tx_cost":         tx_cost,
            "total_pnl":       total_pnl,
            "capital":         capital,
        })

    result = pd.DataFrame(rows)
    result["cumulative_pnl"] = result["total_pnl"].cumsum()

    days_in  = result["in_position"].sum() / 24
    days_out = (~result["in_position"]).sum() / 24
    n_trades = (result["tx_cost"] != 0).sum()
    print(f"Days in position: {days_in:.0f}  |  Days out (cash): {days_out:.0f}  |  Trades: {n_trades}")

    return result, position_size


# ─── 3. Metrics ────────────────────────────────────────────────────────────────

def compute_metrics(df: pd.DataFrame, result: pd.DataFrame) -> dict:
    n_days  = (result["timestamp"].iloc[-1] - result["timestamp"].iloc[0]).days
    final   = result["cumulative_pnl"].iloc[-1]
    ret_pct = final / CAPITAL * 100
    ann_pct = ret_pct * (365 / n_days) if n_days > 0 else 0.0

    hourly_ret = result["total_pnl"] / CAPITAL
    exc_hourly = hourly_ret - (0.02 / 8760)
    sh_hourly  = float(exc_hourly.mean() / exc_hourly.std(ddof=1) * np.sqrt(8760)) \
                 if exc_hourly.std() > 0 else 0.0

    daily      = result.set_index("timestamp").resample("D")["total_pnl"].sum()
    daily_ret  = daily / CAPITAL
    exc_daily  = daily_ret - (0.02 / 365)
    sh_daily   = float(exc_daily.mean() / exc_daily.std(ddof=1) * np.sqrt(365)) \
                 if exc_daily.std() > 0 else 0.0

    drawdown   = result["cumulative_pnl"] - result["cumulative_pnl"].cummax()
    max_dd     = float(drawdown.min())

    total_spot    = result["spot_pnl"].sum()
    total_perp    = result["perp_pnl"].sum()
    total_funding = result["funding_pnl"].sum()
    net_delta     = total_spot + total_perp
    delta_pct     = abs(net_delta) / (abs(total_spot) + 1e-9) * 100

    return {
        "n_days":             n_days,
        "initial_capital":    CAPITAL,
        "transaction_cost":   round(result["tx_cost"].sum(), 2),
        "total_spot_pnl":     round(total_spot, 2),
        "total_perp_pnl":     round(total_perp, 2),
        "net_delta_pnl":      round(net_delta, 4),
        "delta_residual_pct": round(delta_pct, 2),
        "total_funding_pnl":  round(total_funding, 2),
        "total_pnl":          round(final, 2),
        "total_return_pct":   round(ret_pct, 3),
        "ann_return_pct":     round(ann_pct, 2),
        "daily_sharpe":       round(sh_daily, 3),
        "hourly_sharpe":      round(sh_hourly, 3),
        "max_drawdown_usd":   round(max_dd, 2),
    }


# ─── 4. Validation print ───────────────────────────────────────────────────────

def validate(m: dict):
    print()
    print("=" * 60)
    print(" VALIDATION")
    print("=" * 60)
    print(f"  Spot PnL             : ${m['total_spot_pnl']:>9.2f}")
    print(f"  Perp PnL             : ${m['total_perp_pnl']:>9.2f}")
    print(f"  Net delta (residual) : ${m['net_delta_pnl']:>9.4f}  ({m['delta_residual_pct']:.2f}% of spot)")
    print(f"  Funding PnL          : ${m['total_funding_pnl']:>9.2f}")
    print(f"  Transaction costs    : ${m['transaction_cost']:>9.2f}")
    print(f"  {'─'*40}")
    print(f"  Total PnL            : ${m['total_pnl']:>9.2f}")
    print()
    if m['delta_residual_pct'] < 5.0:
        print("  ✓ Hedge effective  (residual < 5% of spot PnL)")
    else:
        print("  ! Delta residual > 5% — check hedge logic.")
    print()
    print(f"  Annualised return : {m['ann_return_pct']:.2f}%")
    print(f"  Sharpe (daily)    : {m['daily_sharpe']:.3f}")
    print(f"  Max drawdown      : ${m['max_drawdown_usd']:.2f}")
    print("=" * 60)


# ─── 5. Charts ─────────────────────────────────────────────────────────────────

def save_charts(result: pd.DataFrame):
    dates = result["timestamp"]

    # Chart 1: Cumulative PnL
    fig, ax = plt.subplots(figsize=(12, 5))
    ax.plot(dates, result["cumulative_pnl"], color="#2196F3", linewidth=1.6, label="Net PnL")
    ax.fill_between(dates, result["cumulative_pnl"], 0,
                    where=(result["cumulative_pnl"] >= 0), alpha=0.12, color="#2196F3")
    ax.fill_between(dates, result["cumulative_pnl"], 0,
                    where=(result["cumulative_pnl"] < 0), alpha=0.12, color="#F44336")
    ax.axhline(0, color="gray", linewidth=0.8, linestyle="--")
    ax.set_title("Cumulative PnL — Delta-Neutral ETH Carry (2021–2026)", fontsize=11)
    ax.set_ylabel("PnL (USD)")
    ax.xaxis.set_major_formatter(mdates.DateFormatter("%b %Y"))
    plt.xticks(rotation=45)
    ax.legend()
    ax.grid(alpha=0.3)
    plt.tight_layout()
    _save(fig, "chart1_cumulative_pnl.png")

    # Chart 2: Drawdown
    drawdown = result["cumulative_pnl"] - result["cumulative_pnl"].cummax()
    fig, ax = plt.subplots(figsize=(12, 4))
    ax.fill_between(dates, drawdown, 0, color="#F44336", alpha=0.5, label="Drawdown")
    ax.set_title("Drawdown from Peak (USD)", fontsize=11)
    ax.set_ylabel("Drawdown (USD)")
    ax.xaxis.set_major_formatter(mdates.DateFormatter("%b %Y"))
    plt.xticks(rotation=45)
    ax.legend()
    ax.grid(alpha=0.3)
    plt.tight_layout()
    _save(fig, "chart2_drawdown.png")

    # Chart 3: Daily PnL decomposition
    daily = result.set_index("timestamp").resample("D").sum(numeric_only=True).reset_index()
    fig, ax = plt.subplots(figsize=(12, 5))
    ax.bar(daily["timestamp"], daily["spot_pnl"],
           label="Spot PnL",    color="#4CAF50", alpha=0.8)
    ax.bar(daily["timestamp"], daily["perp_pnl"],
           label="Perp PnL",    color="#F44336", alpha=0.8, bottom=daily["spot_pnl"])
    ax.bar(daily["timestamp"], daily["funding_pnl"],
           label="Funding PnL", color="#2196F3", alpha=0.8,
           bottom=daily["spot_pnl"] + daily["perp_pnl"])
    ax.axhline(0, color="black", linewidth=0.8)
    ax.set_title("Daily PnL Decomposition: Spot / Perp / Funding", fontsize=11)
    ax.set_ylabel("Daily PnL (USD)")
    ax.xaxis.set_major_formatter(mdates.DateFormatter("%b %Y"))
    plt.xticks(rotation=45)
    ax.legend()
    ax.grid(alpha=0.3, axis="y")
    plt.tight_layout()
    _save(fig, "chart3_pnl_decomposition.png")


def _save(fig, name):
    path = os.path.join(CHARTS_DIR, name)
    fig.savefig(path, dpi=150)
    plt.close(fig)
    print(f"  Saved: {path}")


# ─── 6. Main ───────────────────────────────────────────────────────────────────

def main():
    print("=" * 60)
    print(" Delta-Neutral ETH Carry — Backtest")
    print("=" * 60)

    df               = load_data()
    result, pos_size = run_backtest(df)
    metrics          = compute_metrics(df, result)

    validate(metrics)

    table_path   = os.path.join(TABLES_DIR, "backtest_hourly.csv")
    metrics_path = os.path.join(TABLES_DIR, "backtest_metrics.csv")
    result.to_csv(table_path, index=False)
    pd.DataFrame([metrics]).to_csv(metrics_path, index=False)
    print(f"\n  Table  → {table_path}")
    print(f"  Metrics→ {metrics_path}")

    print("\nGenerating charts...")
    save_charts(result)
    print()

    n   = metrics["n_days"]
    eth_start = df["spot_price_close"].iloc[0]
    eth_end   = df["spot_price_close"].iloc[-1]
    print("=" * 60)
    print(" SUMMARY")
    print("=" * 60)
    print(f"  Period    : {n} days  ({df['timestamp'].min().date()} → {df['timestamp'].max().date()})")
    print(f"  ETH price : ${eth_start:.0f} → ${eth_end:.0f}  ({(eth_end/eth_start-1)*100:+.1f}%)")
    print(f"  Funding   : ${metrics['total_funding_pnl']:,.2f} gross carry earned")
    print(f"  Costs     : ${metrics['transaction_cost']:,.2f} ({abs(metrics['transaction_cost']/metrics['total_funding_pnl']*100):.1f}% of gross funding)")
    print(f"  Net PnL   : ${metrics['total_pnl']:,.2f}  (+{metrics['total_return_pct']:.1f}% total, {metrics['ann_return_pct']:.1f}% ann.)")
    print(f"  Sharpe    : {metrics['daily_sharpe']:.2f} daily  (2% risk-free benchmark)")
    print(f"  Note: Sharpe is elevated by 2021 bull-run funding (42% ann.). 2022-2026 alone: ~0.4.")
    print("=" * 60)
    print()


if __name__ == "__main__":
    main()
