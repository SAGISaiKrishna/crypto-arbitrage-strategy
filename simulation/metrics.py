"""
metrics.py
──────────
Post-scenario analytics for the final report.
Computes Sharpe ratio, max drawdown, break-even, and other summary statistics
from the raw scenario DataFrames produced by scenarios.py.
"""

import numpy as np
import pandas as pd
from typing import Optional
from models import calc_break_even_days


def sharpe_ratio(daily_returns: pd.Series, risk_free_daily: float = 0.0) -> float:
    """
    Annualised Sharpe ratio.
    daily_returns: daily net PnL as a fraction of initial capital.
    """
    excess = daily_returns - risk_free_daily
    if excess.std() == 0:
        return float('inf') if excess.mean() > 0 else 0.0
    return float((excess.mean() / excess.std()) * np.sqrt(365))


def max_drawdown(cumulative_pnl: pd.Series) -> float:
    """
    Maximum peak-to-trough drawdown in USD.
    Returns a positive number representing the magnitude of the worst drawdown.
    """
    peak    = cumulative_pnl.cummax()
    drawdown = peak - cumulative_pnl
    return float(drawdown.max())


def days_at_risk(df: pd.DataFrame, threshold_bps: float = 500.0) -> int:
    """
    Number of days where margin ratio fell below the maintenance margin threshold.
    """
    return int((df["margin_ratio_bps"] < threshold_bps).sum())


def compute_scenario_summary(name: str, df: pd.DataFrame, initial_capital: float) -> dict:
    """
    Compute all key metrics for one scenario. Returns a flat dict suitable
    for a summary CSV row.
    """
    daily_returns = df["net_pnl_daily"] / initial_capital

    final_pnl       = float(df["cumulative_net_pnl"].iloc[-1])
    final_lending   = float(df["cumulative_lending"].iloc[-1])
    final_funding   = float(df["cumulative_funding"].iloc[-1])
    final_price_pnl = float(df["cumulative_price_pnl"].iloc[-1])
    ann_return_bps  = float(df["annualized_return_bps"].iloc[-1])

    # Daily net yield on day 1 (after entry cost) for break-even calculation
    if len(df) > 1:
        day1_yield = float(df["net_pnl_daily"].iloc[1])
    else:
        day1_yield = 0.0

    entry_cost = float(df["costs_daily"].iloc[0])
    be_days    = calc_break_even_days(entry_cost, day1_yield)

    return {
        "scenario":                 name,
        "days":                     len(df) - 1,
        "initial_capital_usd":      initial_capital,
        "final_net_pnl_usd":        round(final_pnl, 2),
        "cumulative_lending_usd":   round(final_lending, 2),
        "cumulative_funding_usd":   round(final_funding, 2),
        "cumulative_price_pnl_usd": round(final_price_pnl, 2),
        "annualized_return_bps":    round(ann_return_bps, 1),
        "annualized_return_pct":    round(ann_return_bps / 100, 3),
        "sharpe_ratio":             round(sharpe_ratio(daily_returns), 3),
        "max_drawdown_usd":         round(max_drawdown(df["cumulative_net_pnl"]), 2),
        "break_even_days":          round(be_days, 1) if be_days is not None else "N/A",
        "days_at_liquidation_risk": days_at_risk(df),
        "final_margin_ratio_bps":   round(float(df["margin_ratio_bps"].iloc[-1]), 1),
    }


def compute_all_summaries(
    results: dict[str, pd.DataFrame],
    initial_capital: float = 100_000.0
) -> pd.DataFrame:
    """Compute summary metrics for all scenarios and return as a DataFrame."""
    rows = [
        compute_scenario_summary(name, df, initial_capital)
        for name, df in results.items()
    ]
    return pd.DataFrame(rows)


def build_break_even_grid(
    lending_apy_range: list[float] | None = None,
    daily_funding_range: list[float] | None = None,
    cost_bps: float = 50.0,
    notional: float = 100_000.0,
) -> pd.DataFrame:
    """
    Build a grid showing annualised carry score (bps) for combinations of
    lending APY and daily funding rate. Used for the break-even heatmap chart.

    Returns a DataFrame with lending APY as columns and daily funding rate as index.
    """
    from models import calc_carry_score

    if lending_apy_range is None:
        lending_apy_range = [100, 200, 300, 400, 500, 600, 700, 800]
    if daily_funding_range is None:
        daily_funding_range = [-3, -2, -1, 0, 1, 2, 3, 4, 5, 6]

    grid = {}
    for apy in lending_apy_range:
        col = {}
        for fund in daily_funding_range:
            score = calc_carry_score(float(apy), float(fund), cost_bps)
            col[fund] = round(score, 1)
        grid[f"{apy}bps APY"] = col

    return pd.DataFrame(grid)
