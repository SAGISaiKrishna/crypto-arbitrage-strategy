"""
main.py
───────
Entry point for the delta-neutral carry strategy backtest.

Usage:
    cd backtest
    python main.py

Before running:
    Place a combined hourly CSV in data/raw/:
      - eth_cash_carry_*.csv    (Coinbase spot ETH/USD + Deribit perp ETH/USD)

    See data/README.md for the expected file format.

Outputs (written to output/):
    tables/backtest_daily.csv       — daily P&L and position data
    tables/backtest_summary.csv     — scalar performance metrics
    charts/chart1_cumulative_pnl.png
    charts/chart2_funding_rate.png
    charts/chart3_pnl_decomposition.png
    charts/chart4_drawdown.png
    charts/chart5_carry_score.png
"""

import os
import sys
import pandas as pd
import matplotlib
matplotlib.use("Agg")  # non-interactive backend for saving to files
import matplotlib.pyplot as plt
import matplotlib.dates as mdates

# Add repo root to path so imports work from any working directory
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from backtest.data_loader import load_and_merge
from backtest.strategy    import run_backtest, BacktestConfig
from backtest.metrics     import compute_summary

TABLES_DIR = os.path.join(ROOT, "output", "tables")
CHARTS_DIR = os.path.join(ROOT, "output", "charts")


def ensure_dirs():
    os.makedirs(TABLES_DIR, exist_ok=True)
    os.makedirs(CHARTS_DIR, exist_ok=True)


def save_charts(result: pd.DataFrame, config: BacktestConfig):
    dates = result["date"]

    # ── Chart 1: Cumulative PnL ───────────────────────────────────────────────
    fig, ax = plt.subplots(figsize=(12, 5))
    ax.plot(dates, result["total_pnl_cumulative"], color="#2196F3", linewidth=1.8, label="Net PnL")
    ax.fill_between(
        dates, result["total_pnl_cumulative"], 0,
        where=(result["total_pnl_cumulative"] >= 0), alpha=0.15, color="#2196F3"
    )
    ax.fill_between(
        dates, result["total_pnl_cumulative"], 0,
        where=(result["total_pnl_cumulative"] < 0), alpha=0.15, color="#F44336"
    )
    ax.axhline(0, color="gray", linewidth=0.8, linestyle="--")
    ax.set_title("Cumulative Net P&L — Delta-Neutral ETH Carry Strategy", fontsize=13)
    ax.set_ylabel("P&L (USD)")
    ax.xaxis.set_major_formatter(mdates.DateFormatter("%Y-%m"))
    plt.xticks(rotation=45)
    ax.legend()
    ax.grid(alpha=0.3)
    plt.tight_layout()
    path = os.path.join(CHARTS_DIR, "chart1_cumulative_pnl.png")
    plt.savefig(path, dpi=150)
    plt.close()
    print(f"  Saved: {path}")

    # ── Chart 2: Daily Funding Rate ───────────────────────────────────────────
    fig, ax = plt.subplots(figsize=(12, 4))
    colors = ["#4CAF50" if v >= 0 else "#F44336" for v in result["daily_funding_rate_bps"]]
    ax.bar(dates, result["daily_funding_rate_bps"], color=colors, width=1.0, alpha=0.8)
    ax.axhline(0, color="black", linewidth=0.8)
    ax.set_title("Daily Log-Basis (bps) — Coinbase Spot / Deribit Perp ETH/USD", fontsize=13)
    ax.set_ylabel("Log-Basis (bps/day)")
    ax.xaxis.set_major_formatter(mdates.DateFormatter("%Y-%m"))
    plt.xticks(rotation=45)
    ax.grid(alpha=0.3, axis="y")
    plt.tight_layout()
    path = os.path.join(CHARTS_DIR, "chart2_funding_rate.png")
    plt.savefig(path, dpi=150)
    plt.close()
    print(f"  Saved: {path}")

    # ── Chart 3: P&L Decomposition ────────────────────────────────────────────
    fig, ax = plt.subplots(figsize=(12, 5))
    ax.plot(dates, result["cumulative_funding"],   color="#4CAF50", linewidth=1.5, label="Cumulative funding income")
    ax.plot(dates, result["cumulative_benchmark"], color="#FF9800", linewidth=1.5, linestyle="--", label="Cumulative benchmark cost")
    ax.plot(dates, result["cumulative_carry"],     color="#2196F3", linewidth=2.0, label="Net carry (funding − benchmark)")
    ax.axhline(0, color="gray", linewidth=0.8, linestyle="--")
    ax.set_title("P&L Decomposition: Funding Income vs Benchmark Cost", fontsize=13)
    ax.set_ylabel("Cumulative USD")
    ax.xaxis.set_major_formatter(mdates.DateFormatter("%Y-%m"))
    plt.xticks(rotation=45)
    ax.legend()
    ax.grid(alpha=0.3)
    plt.tight_layout()
    path = os.path.join(CHARTS_DIR, "chart3_pnl_decomposition.png")
    plt.savefig(path, dpi=150)
    plt.close()
    print(f"  Saved: {path}")

    # ── Chart 4: Drawdown ─────────────────────────────────────────────────────
    running_max = result["total_pnl_cumulative"].cummax()
    drawdown    = result["total_pnl_cumulative"] - running_max

    fig, ax = plt.subplots(figsize=(12, 4))
    ax.fill_between(dates, drawdown, 0, color="#F44336", alpha=0.5, label="Drawdown")
    ax.set_title("Drawdown (USD from Peak)", fontsize=13)
    ax.set_ylabel("Drawdown (USD)")
    ax.xaxis.set_major_formatter(mdates.DateFormatter("%Y-%m"))
    plt.xticks(rotation=45)
    ax.legend()
    ax.grid(alpha=0.3)
    plt.tight_layout()
    path = os.path.join(CHARTS_DIR, "chart4_drawdown.png")
    plt.savefig(path, dpi=150)
    plt.close()
    print(f"  Saved: {path}")

    # ── Chart 5: Carry Score Over Time ────────────────────────────────────────
    fig, ax = plt.subplots(figsize=(12, 4))
    ax.plot(dates, result["carry_score_bps"], color="#9C27B0", linewidth=1.2)
    ax.axhline(0, color="red", linewidth=0.9, linestyle="--", label="Break-even (0 bps)")
    ax.fill_between(dates, result["carry_score_bps"], 0,
                    where=(result["carry_score_bps"] > 0), alpha=0.15, color="#4CAF50", label="Positive carry")
    ax.fill_between(dates, result["carry_score_bps"], 0,
                    where=(result["carry_score_bps"] <= 0), alpha=0.15, color="#F44336", label="Negative carry")
    ax.set_title("Annualised Carry Score (bps): Funding − Benchmark − Costs", fontsize=13)
    ax.set_ylabel("Carry Score (bps/year)")
    ax.xaxis.set_major_formatter(mdates.DateFormatter("%Y-%m"))
    plt.xticks(rotation=45)
    ax.legend()
    ax.grid(alpha=0.3)
    plt.tight_layout()
    path = os.path.join(CHARTS_DIR, "chart5_carry_score.png")
    plt.savefig(path, dpi=150)
    plt.close()
    print(f"  Saved: {path}")


def main():
    print("=" * 60)
    print(" Delta-Neutral ETH Carry Strategy — Backtest")
    print("=" * 60)

    ensure_dirs()

    # ── Load and merge data ───────────────────────────────────────────────────
    print("\nLoading data...")
    data = load_and_merge()

    # ── Run backtest ──────────────────────────────────────────────────────────
    config = BacktestConfig(
        initial_capital_usd   = 100_000.0,
        hedge_notional_pct    = 1.0,       # 100% of capital as notional
        collateral_pct        = 0.20,      # 20% margin = 5x leverage
        benchmark_rate_annual = 0.02,      # 2% annual benchmark (stablecoin yield)
        entry_cost_pct        = 0.0005,    # 0.05% round-trip cost
        maintenance_margin    = 0.05,      # 5% liquidation threshold
    )

    print("\nRunning backtest...")
    result = run_backtest(data, config)

    # ── Compute metrics ───────────────────────────────────────────────────────
    summary = compute_summary(result, config)

    print("\n─── Backtest Summary ─────────────────────────────────────────")
    for k, v in summary.items():
        print(f"  {k:<30} {v}")
    print("──────────────────────────────────────────────────────────────")

    # ── Save outputs ──────────────────────────────────────────────────────────
    print("\nSaving tables...")

    daily_path   = os.path.join(TABLES_DIR, "backtest_daily.csv")
    summary_path = os.path.join(TABLES_DIR, "backtest_summary.csv")

    result.to_csv(daily_path, index=False)
    print(f"  Saved: {daily_path}")

    pd.DataFrame([summary]).to_csv(summary_path, index=False)
    print(f"  Saved: {summary_path}")

    print("\nGenerating charts...")
    save_charts(result, config)

    print("\n" + "=" * 60)
    print(" Backtest complete.")
    print(f" Tables → output/tables/")
    print(f" Charts → output/charts/")
    print("=" * 60)


if __name__ == "__main__":
    main()
