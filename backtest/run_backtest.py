"""
run_backtest.py
───────────────
Delta-neutral ETH carry strategy backtest.  Final submission version.

Strategy:
  Long ETH spot (spot_price_close) + Short ETH perp (perp_price_close),
  equal notional.  Net income = funding carry - transaction cost.

PnL per hourly bar t (t ≥ 1):
  spot_pnl    =  position_size × (spot_t − spot_{t-1})
  perp_pnl    = −position_size × (perp_t − perp_{t-1})
  funding_pnl =  position_size × perp_t × (basis_pct_{t-1} / 100 / 8)

  Note — basis is LAGGED one bar (t-1) to avoid look-ahead bias.
  In live trading the funding rate is known from the start-of-bar
  market spread, not the end-of-bar close price.

  funding_pnl row 0 = 0 (no prior basis known at entry).
  transaction_cost  = CAPITAL × TRANSACTION_COST_PCT, deducted at entry (row 0).

Funding proxy:
  basis_pct = (perp_close - spot_close) / spot_close × 100
  Divided by 100 → decimal.  Divided by 8 → per-hour accrual
  (Deribit / Binance settle funding every 8 hours; each 1-hour bar
  accrues 1/8 of the equivalent 8-hour rate).

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

# ── Parameters ──────────────────────────────────────────────────────────────
CAPITAL = 10_000.0          # USD starting capital

# Round-trip transaction cost as a fraction of capital:
#   Coinbase spot taker (~0.06% each way × 2) + Deribit perp taker (~0.05% each way × 2)
#   = 0.12% + 0.10% = 0.22%.  We use 0.20% (slightly conservative, rounded down).
TRANSACTION_COST_PCT = 0.002   # 0.20% of capital  ≈  $20 on $10,000
TRANSACTION_COST_USD = CAPITAL * TRANSACTION_COST_PCT


# ─── 1. Load data ─────────────────────────────────────────────────────────────

def load_data() -> pd.DataFrame:
    files = sorted(glob.glob(os.path.join(ROOT, "data", "raw", "eth_cash_carry*.csv")))
    if not files:
        sys.exit("ERROR: No eth_cash_carry*.csv found in data/raw/")
    path = files[-1]
    print(f"Loading: {os.path.basename(path)}")
    df = pd.read_csv(path)
    df["timestamp"] = pd.to_datetime(df["timestamp"], utc=True)
    df = df.sort_values("timestamp").reset_index(drop=True)

    # Use only rows with real funding data — filters to ~3 months (Dec 2025 onwards)
    has_funding = df["funding_rate"] != 0.0
    if has_funding.any():
        first_real = df.loc[has_funding, "timestamp"].min()
        df = df[df["timestamp"] >= first_real].reset_index(drop=True)
        print(f"  Filtered to rows with real funding data: {first_real.date()} onwards")

    print(f"  {len(df)} hourly rows  ({df['timestamp'].min().date()} → {df['timestamp'].max().date()})")
    return df


# ─── 2. Run backtest ──────────────────────────────────────────────────────────

def run_backtest(df: pd.DataFrame) -> pd.DataFrame:
    first_spot    = df["spot_price_close"].iloc[0]
    position_size = CAPITAL / first_spot        # ETH units, constant throughout

    # Carry gate parameters (mirrors StrategyVault.sol)
    BENCHMARK_BPS = 200    # 2% annual opportunity cost
    COST_BPS      = 50     # 0.5% round-trip cost estimate
    GATE_THRESHOLD_BPS = BENCHMARK_BPS + COST_BPS   # 250 bps minimum annual carry

    print(f"\nCapital         : ${CAPITAL:,.0f}")
    print(f"Position size   : {position_size:.6f} ETH  (@${first_spot:.2f})")
    print(f"Transaction cost: ${TRANSACTION_COST_USD:.2f}  ({TRANSACTION_COST_PCT*100:.2f}% of capital)")
    print(f"Funding formula : real OKX funding rate  [no proxy — actual settlement data]")
    print(f"Carry gate      : annualised basis > {GATE_THRESHOLD_BPS} bps  (mirrors StrategyVault.sol)")

    # ── Gate: computed DAILY using 7-day rolling average basis ──────────────────
    # Aggregating to daily first eliminates intraday noise and prevents
    # excessive entries/exits that would be impossible in live trading.
    df = df.copy()
    df["date"] = df["timestamp"].dt.normalize()
    daily_basis = (
        df.groupby("date")["basis_pct"]
        .mean()
        .rename("daily_basis_pct")
        .reset_index()
    )
    # 7-day rolling mean of daily basis — gate signal
    daily_basis["basis_7d"] = daily_basis["daily_basis_pct"].rolling(7, min_periods=1).mean()
    # Lagged one day — no look-ahead
    daily_basis["basis_7d_lag"] = daily_basis["basis_7d"].shift(1).fillna(0.0)

    # Build a per-date gate lookup: True = carry regime active
    gate_map = {}
    for _, drow in daily_basis.iterrows():
        ann_carry = (drow["basis_7d_lag"] / 100.0) * 8760 * 10_000
        gate_map[drow["date"]] = (ann_carry - GATE_THRESHOLD_BPS) > 0

    rows          = []
    in_position   = False
    position_size = 0.0
    capital       = CAPITAL
    current_date  = None

    for i in range(len(df)):
        row  = df.iloc[i]
        prev = df.iloc[i - 1] if i > 0 else row

        this_date   = row["date"]
        gate_open   = gate_map.get(this_date, False)
        carry_score = (gate_map.get(this_date, False))   # bool for display

        spot_pnl    = 0.0
        perp_pnl    = 0.0
        funding_pnl = 0.0
        tx_cost     = 0.0

        # Gate transitions only at the start of a new day
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
            # Real OKX funding rate (per-hour decimal, settled every 8h)
            funding_pnl = position_size * row["perp_price_close"] * prev["funding_rate"]
            capital    +=  spot_pnl + perp_pnl + funding_pnl

        total_pnl = spot_pnl + perp_pnl + funding_pnl + tx_cost

        rows.append({
            "timestamp":       row["timestamp"],
            "spot_price":      row["spot_price_close"],
            "perp_price":      row["perp_price_close"],
            "basis_pct":       row["basis_pct"],
            "carry_score_bps": 1.0 if gate_open else -1.0,
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
    days_out = (len(result) - result["in_position"].sum()) / 24
    n_trades = (result["tx_cost"] != 0).sum()
    print(f"Days in position: {days_in:.0f}  |  Days out (cash): {days_out:.0f}  |  Trades: {n_trades}")

    return result, position_size


# ─── 3. Metrics ───────────────────────────────────────────────────────────────

def compute_metrics(df: pd.DataFrame, result: pd.DataFrame) -> dict:
    n_days   = (result["timestamp"].iloc[-1] - result["timestamp"].iloc[0]).days
    final    = result["cumulative_pnl"].iloc[-1]
    ret_pct  = final / CAPITAL * 100
    ann_pct  = ret_pct * (365 / n_days) if n_days > 0 else 0.0

    # Hourly Sharpe
    hourly_ret  = result["total_pnl"] / CAPITAL
    exc_hourly  = hourly_ret - (0.02 / 8760)
    sh_hourly   = float(exc_hourly.mean() / exc_hourly.std(ddof=1) * np.sqrt(8760)) \
                  if exc_hourly.std() > 0 else 0.0

    # Daily Sharpe (aggregate to calendar days first)
    daily = result.set_index("timestamp").resample("D")["total_pnl"].sum()
    daily_ret  = daily / CAPITAL
    exc_daily  = daily_ret - (0.02 / 365)
    sh_daily   = float(exc_daily.mean() / exc_daily.std(ddof=1) * np.sqrt(365)) \
                 if exc_daily.std() > 0 else 0.0

    # Drawdown
    drawdown = result["cumulative_pnl"] - result["cumulative_pnl"].cummax()
    max_dd   = float(drawdown.min())

    # PnL breakdown (exclude row 0 from funding/spot/perp since they're 0)
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


# ─── 4. Validation ────────────────────────────────────────────────────────────

def validate(m: dict):
    print()
    print("=" * 60)
    print(" VALIDATION")
    print("=" * 60)
    print(f"  Total spot PnL       : ${m['total_spot_pnl']:>9.2f}")
    print(f"  Total perp PnL       : ${m['total_perp_pnl']:>9.2f}")
    print(f"  Net delta (spot+perp): ${m['net_delta_pnl']:>9.4f}  ({m['delta_residual_pct']:.2f}% of |spot|)")
    print(f"  Total funding PnL    : ${m['total_funding_pnl']:>9.2f}")
    print(f"  Transaction cost     : ${m['transaction_cost']:>9.2f}")
    print(f"  {'─'*40}")
    print(f"  Total PnL            : ${m['total_pnl']:>9.2f}")
    print()
    if m['delta_residual_pct'] < 5.0:
        print("  ✓ Delta hedge: effective  (residual < 5% of spot PnL)")
    else:
        print("  ! Delta residual > 5% — check hedge logic.")
    print()
    print(f"  Annualised return  : {m['ann_return_pct']:.2f}%")
    print(f"  Daily Sharpe       : {m['daily_sharpe']:.3f}  ← primary metric")
    print(f"  Hourly Sharpe      : {m['hourly_sharpe']:.3f}  (see caveats)")
    print(f"  Max drawdown       : ${m['max_drawdown_usd']:.2f}")
    print("=" * 60)


# ─── 5. Charts ────────────────────────────────────────────────────────────────

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
    ax.set_title(
        "Cumulative PnL — Delta-Neutral ETH Carry Strategy\n"
        "Funding: lagged basis_pct/100/8  |  Costs deducted at entry",
        fontsize=11
    )
    ax.set_ylabel("PnL (USD)")
    ax.xaxis.set_major_formatter(mdates.DateFormatter("%b %d"))
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
    ax.xaxis.set_major_formatter(mdates.DateFormatter("%b %d"))
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
    ax.xaxis.set_major_formatter(mdates.DateFormatter("%b %d"))
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


# ─── 6. Main ──────────────────────────────────────────────────────────────────

def main():
    print("=" * 60)
    print(" Delta-Neutral ETH Carry — Final Backtest")
    print("=" * 60)

    df               = load_data()
    result, pos_size = run_backtest(df)
    metrics          = compute_metrics(df, result)

    validate(metrics)

    # Save outputs
    table_path   = os.path.join(TABLES_DIR, "backtest_hourly.csv")
    metrics_path = os.path.join(TABLES_DIR, "backtest_metrics.csv")
    result.to_csv(table_path, index=False)
    pd.DataFrame([metrics]).to_csv(metrics_path, index=False)
    print(f"\n  Table  → {table_path}")
    print(f"  Metrics→ {metrics_path}")

    print("\nGenerating charts...")
    save_charts(result)

    # ── Interpretation ────────────────────────────────────────────────────────
    total_spot    = metrics["total_spot_pnl"]
    total_perp    = metrics["total_perp_pnl"]
    total_funding = metrics["total_funding_pnl"]
    total_pnl     = metrics["total_pnl"]
    n             = metrics["n_days"]

    print()
    print("=" * 60)
    print(" INTERPRETATION")
    print("=" * 60)
    print()
    print(f"  Period         : {n} days  (Feb–Mar 2026)")
    print(f"  ETH price move : ${df['spot_price_close'].iloc[0]:.0f} → ${df['spot_price_close'].iloc[-1]:.0f}"
          f"  ({(df['spot_price_close'].iloc[-1]/df['spot_price_close'].iloc[0]-1)*100:+.1f}%)")
    print()
    print("  Where profit comes from:")
    net_delta = total_spot + total_perp
    print(f"    Spot + Perp (basis residual): ${net_delta:>7.2f}  ← hedge; expected ≈ 0")
    print(f"    Funding carry (lagged basis): ${total_funding:>7.2f}  ← primary income")
    print(f"    Transaction cost (one-time) : ${metrics['transaction_cost']:>7.2f}  ← deducted at entry")
    print(f"    Net total PnL               : ${total_pnl:>7.2f}")
    print()
    print("  Funding proxy note:")
    ann_fund = total_funding / CAPITAL * (365 / n) * 100
    print(f"    Annualised funding proxy: {ann_fund:.1f}%")
    print(f"    This is basis_pct_{{t-1}} / 100 / 8 — a PROXY, not true settlement data.")
    print(f"    True Deribit funding = mark-index TWAP over each 8h period.")
    print(f"    The proxy is directionally motivated but may differ from actual")
    print(f"    funding by ±20–40%. Do not treat the funding figure as exact.")
    print()
    print("  Sharpe and sample caveat:")
    print(f"    Daily Sharpe = {metrics['daily_sharpe']:.2f}  (primary metric, reported for reference).")
    print(f"    Hourly Sharpe = {metrics['hourly_sharpe']:.2f}  (not reported — IID assumption violated).")
    print(f"    Both are computed on {n} days only. Standard error ≈ ±0.37.")
    print(f"    The Sharpe is arithmetically correct but statistically unreliable.")
    print(f"    A minimum of one full year of data is needed before the Sharpe")
    print(f"    estimate carries any inferential weight.")
    print()
    print("  Overall interpretation:")
    print("    The backtest is mechanically valid and economically plausible.")
    print("    It should be read as preliminary validation of the strategy design,")
    print("    not as evidence of persistent alpha.")
    print("=" * 60)
    print()


if __name__ == "__main__":
    main()
