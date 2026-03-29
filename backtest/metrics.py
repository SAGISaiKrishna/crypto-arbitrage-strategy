"""
metrics.py
──────────
Performance metrics for the delta-neutral carry strategy backtest.
"""

import numpy as np
import pandas as pd


def annualized_return(total_pnl: float, initial_capital: float, n_days: int) -> float:
    """
    Annualised return as a percentage.
    Uses simple (non-compounded) scaling.
    """
    if n_days == 0 or initial_capital == 0:
        return 0.0
    return (total_pnl / initial_capital) * (365.0 / n_days) * 100.0


def sharpe_ratio(
    daily_returns: pd.Series,
    benchmark_daily: float = 0.02 / 365,
    periods_per_year: int  = 365,
) -> float:
    """
    Annualised Sharpe ratio.
    daily_returns: series of daily PnL / initial capital (decimal returns)
    """
    excess = daily_returns - benchmark_daily
    if excess.std() == 0:
        return 0.0
    return float((excess.mean() / excess.std()) * np.sqrt(periods_per_year))


def max_drawdown(cumulative_pnl: pd.Series) -> float:
    """
    Maximum peak-to-trough drawdown in USD.
    """
    running_max = cumulative_pnl.cummax()
    drawdown    = running_max - cumulative_pnl
    return float(drawdown.max())


def win_rate(daily_carry_pnl: pd.Series) -> float:
    """
    Fraction of days where carry PnL was positive.
    """
    if len(daily_carry_pnl) == 0:
        return 0.0
    return float((daily_carry_pnl > 0).sum() / len(daily_carry_pnl))


def funding_positive_days(daily_funding: pd.Series) -> int:
    """Number of days the funding rate was positive (contango)."""
    return int((daily_funding > 0).sum())


def compute_summary(result: pd.DataFrame, config) -> dict:
    """
    Compute all summary metrics for a single backtest result.

    Parameters
    ----------
    result : DataFrame returned by strategy.run_backtest()
    config : BacktestConfig used for the run

    Returns
    -------
    dict of scalar metrics
    """
    n_days          = len(result) - 1  # exclude day 0 (entry)
    initial_capital = config.initial_capital_usd
    daily_returns   = result["total_pnl_daily"].iloc[1:] / initial_capital

    total_pnl       = result["total_pnl_cumulative"].iloc[-1]
    total_funding   = result["cumulative_funding"].iloc[-1]
    total_benchmark = result["cumulative_benchmark"].iloc[-1]
    total_carry     = result["cumulative_carry"].iloc[-1]

    return {
        "n_days":                 n_days,
        "initial_capital_usd":   initial_capital,
        "final_pnl_usd":         round(total_pnl, 2),
        "total_funding_usd":     round(total_funding, 2),
        "total_benchmark_cost":  round(total_benchmark, 2),
        "net_carry_usd":         round(total_carry, 2),
        "annualized_return_pct": round(annualized_return(total_pnl, initial_capital, n_days), 3),
        "sharpe_ratio":          round(sharpe_ratio(daily_returns), 3),
        "max_drawdown_usd":      round(max_drawdown(result["total_pnl_cumulative"]), 2),
        "win_rate_pct":          round(win_rate(result["carry_pnl"].iloc[1:]) * 100, 1),
        "avg_daily_basis_bps":   round(result["daily_funding_rate_bps"].mean(), 3),
        "positive_basis_days":   funding_positive_days(result["daily_funding_rate_bps"]),
        "avg_carry_score_bps":   round(result["carry_score_bps"].mean(), 1),
    }
