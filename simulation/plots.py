"""
plots.py
────────
All matplotlib charts for the final report.

Charts generated:
  1. Cumulative net PnL by scenario (line chart, 4 scenarios)
  2. Daily PnL decomposition — Neutral scenario (stacked bar: lending | funding | price)
  3. Margin ratio over time (all 4 scenarios, with maintenance threshold line)
  4. Edge score over time (Neutral scenario — shows when strategy would be viable)
  5. Break-even heatmap (lending APY × daily funding → net carry score bps)
  6. Sharpe ratio comparison (bar chart)

All charts are saved as high-resolution PNGs to ../charts/.
"""

import os
import numpy as np
import pandas as pd
import matplotlib.pyplot as plt
import matplotlib.ticker as mticker
from config import SCENARIOS

CHART_DIR = os.path.join(os.path.dirname(__file__), "..", "charts")
os.makedirs(CHART_DIR, exist_ok=True)

# Colour palette (accessible, print-friendly)
COLORS = ["#2196F3", "#4CAF50", "#F44336", "#FF9800"]
SCENARIO_LABELS = [s.label for s in SCENARIOS]


def _save(fig: plt.Figure, filename: str) -> None:
    path = os.path.join(CHART_DIR, filename)
    fig.savefig(path, dpi=150, bbox_inches="tight")
    plt.close(fig)
    print(f"  Saved: {path}")


# ── Chart 1: Cumulative PnL ───────────────────────────────────────────────────

def plot_cumulative_pnl(results: dict[str, pd.DataFrame]) -> None:
    """Line chart of cumulative net PnL for all scenarios."""
    fig, ax = plt.subplots(figsize=(10, 5))

    for (name, df), color, label in zip(results.items(), COLORS, SCENARIO_LABELS):
        ax.plot(df["day"], df["cumulative_net_pnl"], label=label, color=color, linewidth=2)

    ax.axhline(0, color="black", linewidth=0.8, linestyle="--", alpha=0.5)
    ax.set_xlabel("Day")
    ax.set_ylabel("Cumulative Net PnL (USD)")
    ax.set_title("Chart 1 — Cumulative Net PnL by Scenario")
    ax.legend(loc="upper left")
    ax.yaxis.set_major_formatter(mticker.FuncFormatter(lambda x, _: f"${x:,.0f}"))
    ax.grid(True, alpha=0.3)
    fig.tight_layout()
    _save(fig, "chart1_cumulative_pnl.png")


# ── Chart 2: Daily PnL Decomposition ─────────────────────────────────────────

def plot_daily_decomposition(results: dict[str, pd.DataFrame], scenario_name: str = "Neutral") -> None:
    """Stacked bar chart showing daily PnL components for one scenario."""
    df = results[scenario_name].iloc[1:]  # skip day 0 (entry cost day)

    fig, ax = plt.subplots(figsize=(12, 5))

    ax.bar(df["day"], df["lending_income_daily"],
           label="Lending Yield", color="#4CAF50", alpha=0.85)
    ax.bar(df["day"], df["funding_income_daily"],
           bottom=df["lending_income_daily"],
           label="Funding Income", color="#2196F3", alpha=0.85)
    ax.bar(df["day"], df["short_price_pnl_daily"],
           bottom=df["lending_income_daily"] + df["funding_income_daily"],
           label="Short Price PnL", color="#F44336", alpha=0.70)

    ax.axhline(0, color="black", linewidth=0.8)
    ax.set_xlabel("Day")
    ax.set_ylabel("Daily PnL (USD)")
    ax.set_title(f"Chart 2 — Daily PnL Decomposition: {scenario_name} Scenario")
    ax.legend()
    ax.yaxis.set_major_formatter(mticker.FuncFormatter(lambda x, _: f"${x:,.2f}"))
    ax.grid(True, alpha=0.3, axis="y")
    fig.tight_layout()
    _save(fig, "chart2_daily_decomposition.png")


# ── Chart 3: Margin Ratio ─────────────────────────────────────────────────────

def plot_margin_ratio(results: dict[str, pd.DataFrame], maintenance_bps: float = 500.0) -> None:
    """Line chart of margin ratio over time for all scenarios."""
    fig, ax = plt.subplots(figsize=(10, 5))

    for (name, df), color, label in zip(results.items(), COLORS, SCENARIO_LABELS):
        ax.plot(df["day"], df["margin_ratio_bps"], label=label, color=color, linewidth=2)

    ax.axhline(
        maintenance_bps, color="red", linewidth=1.5, linestyle="--",
        label=f"Maintenance margin ({maintenance_bps:.0f} bps)"
    )
    ax.set_xlabel("Day")
    ax.set_ylabel("Margin Ratio (bps)")
    ax.set_title("Chart 3 — Margin Ratio Over Time (All Scenarios)")
    ax.legend()
    ax.grid(True, alpha=0.3)
    fig.tight_layout()
    _save(fig, "chart3_margin_ratio.png")


# ── Chart 4: Edge Score ───────────────────────────────────────────────────────

def plot_edge_score(results: dict[str, pd.DataFrame]) -> None:
    """Line chart of carry edge score over time."""
    fig, ax = plt.subplots(figsize=(10, 5))

    for (name, df), color, label in zip(results.items(), COLORS, SCENARIO_LABELS):
        ax.plot(df["day"], df["edge_score_bps"], label=label, color=color, linewidth=2)

    # Default minimum threshold from StrategyVault (200 bps)
    ax.axhline(200, color="green", linewidth=1.5, linestyle="--", label="Min threshold (200 bps)")
    ax.axhline(0, color="black", linewidth=0.8, linestyle="--", alpha=0.5)

    ax.set_xlabel("Day")
    ax.set_ylabel("Annualised Carry Score (bps)")
    ax.set_title("Chart 4 — Edge Score Over Time")
    ax.legend()
    ax.grid(True, alpha=0.3)
    fig.tight_layout()
    _save(fig, "chart4_edge_score.png")


# ── Chart 5: Break-Even Heatmap ───────────────────────────────────────────────

def plot_break_even_heatmap(grid_df: pd.DataFrame) -> None:
    """
    Heatmap of annualised carry score across (lending APY, daily funding rate) space.
    Green = positive carry (trade is viable), red = negative carry.
    """
    fig, ax = plt.subplots(figsize=(10, 6))

    data = grid_df.values.astype(float)
    im   = ax.imshow(data, cmap="RdYlGn", aspect="auto",
                     vmin=-2000, vmax=2000)

    ax.set_xticks(range(len(grid_df.columns)))
    ax.set_xticklabels(grid_df.columns, rotation=45, ha="right")
    ax.set_yticks(range(len(grid_df.index)))
    ax.set_yticklabels([f"{r} bps/day" for r in grid_df.index])
    ax.set_xlabel("Lending APY (bps)")
    ax.set_ylabel("Daily Funding Rate (bps)")
    ax.set_title("Chart 5 — Break-Even Heatmap\n(Annualised Carry Score, bps; green = viable)")

    # Add text annotations
    for i in range(data.shape[0]):
        for j in range(data.shape[1]):
            ax.text(j, i, f"{data[i, j]:.0f}", ha="center", va="center", fontsize=8,
                    color="black" if abs(data[i, j]) < 1000 else "white")

    plt.colorbar(im, ax=ax, label="Carry Score (bps)")
    fig.tight_layout()
    _save(fig, "chart5_break_even_heatmap.png")


# ── Chart 6: Sharpe Ratio Comparison ─────────────────────────────────────────

def plot_sharpe_comparison(summary_df: pd.DataFrame) -> None:
    """Bar chart comparing Sharpe ratios across scenarios."""
    fig, ax = plt.subplots(figsize=(8, 5))

    bars = ax.bar(
        summary_df["scenario"],
        summary_df["sharpe_ratio"],
        color=COLORS[:len(summary_df)],
        alpha=0.85,
        edgecolor="black",
        linewidth=0.5,
    )
    ax.axhline(0, color="black", linewidth=0.8)
    ax.bar_label(bars, fmt="%.2f", padding=3)

    ax.set_xlabel("Scenario")
    ax.set_ylabel("Annualised Sharpe Ratio")
    ax.set_title("Chart 6 — Sharpe Ratio by Scenario")
    ax.grid(True, alpha=0.3, axis="y")
    fig.tight_layout()
    _save(fig, "chart6_sharpe_comparison.png")


# ── Generate All Charts ───────────────────────────────────────────────────────

def generate_all_charts(
    results: dict[str, pd.DataFrame],
    summary_df: pd.DataFrame,
    grid_df: pd.DataFrame,
) -> None:
    print("\nGenerating charts...")
    plot_cumulative_pnl(results)
    plot_daily_decomposition(results, scenario_name="Neutral")
    plot_margin_ratio(results)
    plot_edge_score(results)
    plot_break_even_heatmap(grid_df)
    plot_sharpe_comparison(summary_df)
    print(f"All charts saved to {CHART_DIR}/")
