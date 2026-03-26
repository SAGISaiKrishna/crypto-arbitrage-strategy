"""
models.py
─────────
Data model and all financial formula functions for the simulation.

This module mirrors the ArbitrageMath.sol library exactly — the same formulas
are used in both the on-chain contract and the Python simulation so results
are directly comparable and explainable in the report.

All monetary values are in USD unless noted as "bps".
"""

from dataclasses import dataclass, field
import numpy as np
from typing import Optional


# ─── Daily Row Schema ─────────────────────────────────────────────────────────

@dataclass
class DailyRow:
    """One row in the simulation output DataFrame. Represents end-of-day state."""
    day: int

    # Price
    eth_spot_price: float           # ETH/USD reference price
    eth_mark_price: float           # Perp mark price (for spread calc)
    spread_bps: float               # (mark - spot) / spot * 10 000

    # Strategy rates
    daily_funding_rate_bps: float   # That day's funding rate
    edge_score_bps: float           # annualised carry score (lending + funding*365 - cost)

    # Position
    is_hedge_open: bool
    position_notional: float        # USD notional of short
    posted_margin: float            # USD collateral posted
    entry_price: float              # ETH price at position open

    # Income decomposition (daily)
    lending_income_daily: float     # From vault APY on principal
    funding_income_daily: float     # From short position funding
    short_price_pnl_daily: float    # Mark-to-market on short (negative when ETH rises)
    costs_daily: float              # Entry cost on day 0, zero thereafter

    # Cumulative
    cumulative_lending: float
    cumulative_funding: float
    cumulative_price_pnl: float
    cumulative_costs: float
    net_pnl_daily: float
    cumulative_net_pnl: float

    # Portfolio
    equity: float                   # initial_capital + cumulative_net_pnl
    margin_ratio_bps: float         # (posted_margin + unrealised_pnl) / notional * 10 000
    health_factor: float            # margin_ratio / maintenance_margin (>1 = safe)
    annualized_return_bps: float    # cumulative return extrapolated to full year


# ─── Formulas (mirror ArbitrageMath.sol) ──────────────────────────────────────

def calc_short_price_pnl(notional: float, entry_price: float, current_price: float) -> float:
    """
    Unrealised P&L on a short position.
    Positive when price falls (short profits), negative when price rises.

    Formula: notional × (entry_price − current_price) / entry_price
    """
    if entry_price == 0:
        return 0.0
    return notional * (entry_price - current_price) / entry_price


def calc_funding_payment_daily(notional: float, daily_funding_rate_bps: float) -> float:
    """
    Funding income for one day.
    Positive in contango (shorts receive), negative in backwardation.

    Formula: notional × dailyFundingRateBps / 10 000
    """
    return notional * daily_funding_rate_bps / 10_000


def calc_lending_yield_daily(principal: float, lending_apy_bps: float) -> float:
    """
    Lending yield for one day.

    Formula: principal × lendingAPYBps / (10 000 × 365)
    """
    return principal * lending_apy_bps / (10_000 * 365)


def calc_margin_ratio_bps(collateral: float, unrealized_pnl: float, notional: float) -> float:
    """
    Margin ratio = (collateral + unrealised PnL) / notional, in basis points.
    Returns 0 if equity is negative.
    """
    if notional == 0:
        return float('inf')
    equity = collateral + unrealized_pnl
    if equity <= 0:
        return 0.0
    return (equity / notional) * 10_000


def calc_health_factor(margin_ratio_bps: float, maintenance_margin_bps: float) -> float:
    """
    Health factor = margin_ratio / maintenance_margin.
    > 1.0 = safe, < 1.0 = liquidatable.
    """
    if maintenance_margin_bps == 0:
        return float('inf')
    return margin_ratio_bps / maintenance_margin_bps


def calc_carry_score(
    lending_apy_bps: float,
    daily_funding_rate_bps: float,
    cost_bps: float
) -> float:
    """
    Annualised carry score in basis points.
    Positive = trade expected to be profitable.

    Formula: lendingAPYBps + (dailyFundingRateBps × 365) − costBps
    """
    annualized_funding = daily_funding_rate_bps * 365
    return lending_apy_bps + annualized_funding - cost_bps


def calc_annualized_return_bps(
    net_pnl: float,
    principal: float,
    elapsed_days: int
) -> float:
    """
    Return rate extrapolated to one full year, in bps.
    """
    if principal == 0 or elapsed_days == 0:
        return 0.0
    daily_return = net_pnl / principal / elapsed_days
    return daily_return * 365 * 10_000


def calc_break_even_days(entry_cost_usd: float, daily_net_yield_usd: float) -> Optional[float]:
    """
    Days until cumulative yield covers entry cost.
    Returns None if daily yield is non-positive.
    """
    if daily_net_yield_usd <= 0:
        return None
    return entry_cost_usd / daily_net_yield_usd


# ─── ETH Price Path Generators ───────────────────────────────────────────────

def generate_price_path(config) -> np.ndarray:
    """
    Generate a daily ETH spot price series for the given scenario config.
    Returns an array of length (days + 1) including day 0.
    """
    n = config.days + 1
    prices = np.zeros(n)
    prices[0] = config.eth_entry_price

    rng = np.random.default_rng(config.seed)

    if config.eth_price_path == "flat":
        prices[:] = config.eth_entry_price

    elif config.eth_price_path == "trend_up":
        for i in range(1, n):
            prices[i] = prices[i - 1] * (1 + config.eth_trend_daily)

    elif config.eth_price_path == "trend_down":
        for i in range(1, n):
            prices[i] = prices[i - 1] * (1 + config.eth_trend_daily)

    elif config.eth_price_path == "gbm":
        # Geometric Brownian Motion: dS = S(μdt + σdW)
        dt = 1 / 365
        for i in range(1, n):
            z = rng.standard_normal()
            daily_return = (
                (config.eth_drift - 0.5 * config.eth_volatility ** 2) * dt
                + config.eth_volatility * np.sqrt(dt) * z
            )
            prices[i] = prices[i - 1] * np.exp(daily_return)
    else:
        raise ValueError(f"Unknown price path: {config.eth_price_path}")

    return prices


def generate_funding_path(config, rng: np.random.Generator) -> np.ndarray:
    """
    Generate daily funding rate series.
    For GBM scenario, adds Gaussian noise around the mean.
    """
    rates = np.full(config.days + 1, config.daily_funding_rate_bps)
    if config.funding_noise_std_bps > 0:
        noise = rng.normal(0, config.funding_noise_std_bps, config.days + 1)
        rates += noise
    return rates
