"""
scenarios.py
────────────
Runs each scenario configuration and returns a list of DailyRow objects
that can be converted into a DataFrame for analysis, charting, and CSV export.
"""

import numpy as np
import pandas as pd
from dataclasses import asdict
from config import ScenarioConfig, SCENARIOS
from models import (
    DailyRow,
    generate_price_path,
    generate_funding_path,
    calc_short_price_pnl,
    calc_funding_payment_daily,
    calc_lending_yield_daily,
    calc_margin_ratio_bps,
    calc_health_factor,
    calc_carry_score,
    calc_annualized_return_bps,
)


def run_scenario(cfg: ScenarioConfig) -> pd.DataFrame:
    """
    Run a single scenario and return a DataFrame with one row per day.

    Simulation logic:
    ─────────────────
    Day 0: Position opens. Entry cost is deducted.
    Days 1-N: Funding and lending yield accrue daily.
              Price PnL is computed mark-to-market each day.
              Margin ratio is checked against maintenance threshold.
    """
    rng = np.random.default_rng(cfg.seed)

    # Generate price and funding paths
    prices   = generate_price_path(cfg)
    fundings = generate_funding_path(cfg, rng)

    # Derived position sizing
    notional       = cfg.initial_capital_usd * cfg.hedge_notional_pct
    margin_posted  = notional * cfg.collateral_pct
    entry_price    = prices[0]

    # Entry cost (one-time, on day 0)
    entry_cost_usd = notional * cfg.entry_cost_bps / 10_000

    # Running totals
    cum_lending    = 0.0
    cum_funding    = 0.0
    cum_price_pnl  = 0.0
    cum_costs      = entry_cost_usd
    cum_net_pnl    = -entry_cost_usd  # starts negative (cost to enter)

    rows: list[DailyRow] = []

    for day in range(cfg.days + 1):
        spot    = prices[day]
        funding = fundings[day]
        mark    = spot * (1 + cfg.spread_bps / 10_000 + day * cfg.spread_convergence_daily / 10_000)

        spread_today = (mark - spot) / spot * 10_000 if spot > 0 else 0.0

        # Daily income components
        lending_today  = calc_lending_yield_daily(cfg.initial_capital_usd, cfg.lending_apy_bps)
        funding_today  = calc_funding_payment_daily(notional, funding) if day > 0 else 0.0

        # Price PnL is mark-to-market (delta from previous day)
        prev_pnl = calc_short_price_pnl(notional, entry_price, prices[day - 1]) if day > 0 else 0.0
        curr_pnl = calc_short_price_pnl(notional, entry_price, spot)
        price_pnl_today = curr_pnl - prev_pnl if day > 0 else 0.0

        daily_cost = entry_cost_usd if day == 0 else 0.0
        net_today  = lending_today + funding_today + price_pnl_today - daily_cost

        # Update cumulative totals
        if day > 0:
            cum_lending   += lending_today
            cum_funding   += funding_today
            cum_price_pnl += price_pnl_today
            cum_net_pnl   += net_today

        unrealised_pnl = calc_short_price_pnl(notional, entry_price, spot) + cum_funding

        margin_ratio = calc_margin_ratio_bps(margin_posted, unrealised_pnl, notional)
        health       = calc_health_factor(margin_ratio, cfg.maintenance_margin_bps)
        edge_score   = calc_carry_score(cfg.lending_apy_bps, funding, cfg.entry_cost_bps)
        ann_return   = calc_annualized_return_bps(
            cum_net_pnl, cfg.initial_capital_usd, max(day, 1)
        )

        rows.append(DailyRow(
            day                    = day,
            eth_spot_price         = round(spot, 2),
            eth_mark_price         = round(mark, 2),
            spread_bps             = round(spread_today, 4),
            daily_funding_rate_bps = round(funding, 4),
            edge_score_bps         = round(edge_score, 2),
            is_hedge_open          = True,
            position_notional      = round(notional, 2),
            posted_margin          = round(margin_posted, 2),
            entry_price            = round(entry_price, 2),
            lending_income_daily   = round(lending_today, 4),
            funding_income_daily   = round(funding_today, 4),
            short_price_pnl_daily  = round(price_pnl_today, 4),
            costs_daily            = round(daily_cost, 4),
            cumulative_lending     = round(cum_lending, 4),
            cumulative_funding     = round(cum_funding, 4),
            cumulative_price_pnl   = round(cum_price_pnl, 4),
            cumulative_costs       = round(cum_costs, 4),
            net_pnl_daily          = round(net_today, 4),
            cumulative_net_pnl     = round(cum_net_pnl, 4),
            equity                 = round(cfg.initial_capital_usd + cum_net_pnl, 4),
            margin_ratio_bps       = round(margin_ratio, 2),
            health_factor          = round(health, 4),
            annualized_return_bps  = round(ann_return, 2),
        ))

    return pd.DataFrame([asdict(r) for r in rows])


def run_all_scenarios() -> dict[str, pd.DataFrame]:
    """Run all configured scenarios and return a dict of name → DataFrame."""
    results = {}
    for cfg in SCENARIOS:
        print(f"  Running scenario: {cfg.name}...")
        results[cfg.name] = run_scenario(cfg)
    return results


if __name__ == "__main__":
    dfs = run_all_scenarios()
    for name, df in dfs.items():
        print(f"\n{name} — last row:")
        print(df.tail(1).to_string())
