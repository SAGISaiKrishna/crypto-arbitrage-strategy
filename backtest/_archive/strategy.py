"""
strategy.py
───────────
Delta-neutral ETH carry strategy backtest engine.

Strategy overview:
  - Long leg:  Hold USDC equivalent to the ETH spot exposure (tracks ETH price)
  - Short leg: Open a short ETH perpetual futures position of equal notional
  - Income:    Basis compression as perp converges to spot (contango carry)
  - Benchmark: Subtract the opportunity cost (e.g. stablecoin yield / T-bill rate)

PnL mechanics (model-free, uses actual prices):
  spot_pnl   =  notional × (spot_close_t / spot_close_{t-1} − 1)
  perp_pnl   = −notional × (perp_close_t / perp_close_{t-1} − 1)
  net_carry  =  spot_pnl + perp_pnl   ← basis captured (≈0 on pure delta moves)

Carry score (mirrors ArbitrageMath.sol):
  carry_score_bps = log_basis_bps_mean × 365 − benchmark_bps − cost_bps
"""

import pandas as pd
import numpy as np
from dataclasses import dataclass


@dataclass
class BacktestConfig:
    """All parameters for a single backtest run."""
    initial_capital_usd:   float = 100_000.0  # Total USDC deposited
    hedge_notional_pct:    float = 1.0         # Perp notional as fraction of capital
    collateral_pct:        float = 0.20        # Perp margin / notional (0.20 = 5× leverage)
    benchmark_rate_annual: float = 0.02        # Annual benchmark rate (2%)
    entry_cost_pct:        float = 0.0005      # One-time entry cost (0.05% round-trip)
    maintenance_margin:    float = 0.05        # Liquidation threshold (5% of notional)
    label:                 str   = "Backtest"


def run_backtest(data: pd.DataFrame, config: BacktestConfig = None) -> pd.DataFrame:
    """
    Run the delta-neutral carry strategy on historical data.

    Parameters
    ----------
    data : DataFrame returned by data_loader.load_and_merge(), with columns:
        date               — daily timestamps
        spot_close         — ETH/USD spot closing price
        perp_close         — ETH/USD perp closing price
        basis_pct_mean     — mean (perp − spot) / spot × 100 for the day
        log_basis_bps_mean — mean ln(perp / spot) × 10 000 for the day

    config : BacktestConfig (uses defaults if None)

    Returns
    -------
    DataFrame with one row per day and columns:
        date, eth_price, perp_price,
        spot_pnl, perp_pnl, net_delta_pnl,
        funding_income, benchmark_cost, carry_pnl,
        total_pnl_daily, total_pnl_cumulative,
        cumulative_funding, cumulative_benchmark, cumulative_carry,
        capital, margin_ratio, is_viable,
        carry_score_bps, daily_funding_rate_bps
    """
    if config is None:
        config = BacktestConfig()

    df             = data.copy().reset_index(drop=True)
    capital        = config.initial_capital_usd
    notional       = capital * config.hedge_notional_pct
    collateral     = notional * config.collateral_pct
    benchmark_daily = config.benchmark_rate_annual / 365.0
    benchmark_bps  = config.benchmark_rate_annual * 10_000
    cost_bps       = config.entry_cost_pct * 10_000
    entry_cost     = notional * config.entry_cost_pct

    # Track entry perp price for margin ratio calculation
    entry_perp  = df["perp_close"].iloc[0]
    in_position = False   # carry gate: only trade when carry score > 0

    rows = []

    for i in range(len(df)):
        row           = df.iloc[i]
        date          = row["date"]
        spot_price    = row["spot_close"]
        perp_price    = row["perp_close"]
        log_basis_bps = row["log_basis_bps_mean"]

        # Carry score uses PREVIOUS day's basis (lagged, no look-ahead)
        if i == 0:
            prev_log_basis = log_basis_bps
        else:
            prev_log_basis = df["log_basis_bps_mean"].iloc[i - 1]

        carry_score_bps = prev_log_basis * 365 - benchmark_bps - cost_bps
        is_viable       = carry_score_bps > 0

        spot_pnl       = 0.0
        perp_pnl       = 0.0
        net_delta_pnl  = 0.0
        funding_income = 0.0
        benchmark_cost = 0.0
        carry_pnl      = 0.0
        total_daily    = 0.0

        if i == 0:
            # Day 0: decide whether to enter based on carry score
            if is_viable:
                in_position = True
                entry_perp  = perp_price
                carry_pnl   = -entry_cost
                total_daily = -entry_cost
        else:
            prev_spot = df["spot_close"].iloc[i - 1]
            prev_perp = df["perp_close"].iloc[i - 1]

            if not in_position and is_viable:
                # Enter: pay entry cost, reset perp entry price
                in_position = True
                entry_perp  = perp_price
                carry_pnl   = -entry_cost
                total_daily = -entry_cost

            elif in_position and not is_viable:
                # Exit: pay exit cost, close position
                in_position = False
                carry_pnl   = -entry_cost
                total_daily = -entry_cost

            elif in_position:
                # Active position: earn carry
                spot_pnl = notional * (spot_price / prev_spot - 1.0)
                perp_pnl = -notional * (perp_price / prev_perp - 1.0)

                net_delta_pnl  = spot_pnl + perp_pnl
                benchmark_cost = capital * benchmark_daily
                funding_income = net_delta_pnl
                carry_pnl      = net_delta_pnl - benchmark_cost
                total_daily    = carry_pnl

            # else: not in position, carry not viable → sit in cash, pnl = 0

        capital += total_daily

        # Margin ratio: only meaningful when in position
        if in_position:
            unrealised_perp = notional * (entry_perp - perp_price) / entry_perp
            equity          = collateral + unrealised_perp
            margin_ratio    = max(equity / notional, 0.0)
        else:
            margin_ratio = 1.0   # full margin, not deployed

        rows.append({
            "date":                   date,
            "eth_price":              spot_price,
            "perp_price":             perp_price,
            "daily_funding_rate_bps": log_basis_bps,
            "spot_pnl":               spot_pnl,
            "perp_pnl":               perp_pnl,
            "net_delta_pnl":          net_delta_pnl,
            "funding_income":         funding_income,
            "benchmark_cost":         benchmark_cost,
            "carry_pnl":              carry_pnl,
            "total_pnl_daily":        total_daily,
            "capital":                capital,
            "margin_ratio":           margin_ratio,
            "is_viable":              is_viable,
            "carry_score_bps":        carry_score_bps,
            "in_position":            in_position,
        })

    result = pd.DataFrame(rows)

    result["total_pnl_cumulative"] = result["total_pnl_daily"].cumsum()
    result["cumulative_funding"]   = result["funding_income"].cumsum()
    result["cumulative_benchmark"] = result["benchmark_cost"].cumsum()
    result["cumulative_carry"]     = result["carry_pnl"].cumsum()

    return result
