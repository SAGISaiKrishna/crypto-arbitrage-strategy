"""
config.py
─────────
Scenario configuration for the arbitrage strategy simulation.

Each ScenarioConfig defines a single simulation run. The 4 scenarios below
represent the key market regimes analysed in the final report:

  1. Favorable   — high funding, positive spread: "best case"
  2. Neutral     — moderate funding: "base case"
  3. Backwardation — negative funding: "bear market / worst case"
  4. GBM Volatile  — stochastic ETH price with noisy funding: "realistic"

All rate parameters are in basis points (bps) unless noted.
1 bps = 0.01%  →  100 bps = 1%  →  10 000 bps = 100%
"""

from dataclasses import dataclass, field
from typing import Literal


@dataclass
class ScenarioConfig:
    # ── Identity ──────────────────────────────────────────────────────────────
    name: str
    label: str  # short label for chart legends

    # ── Time horizon ──────────────────────────────────────────────────────────
    days: int = 30

    # ── Capital ───────────────────────────────────────────────────────────────
    initial_capital_usd: float = 100_000.0   # USDC deposited into vault
    hedge_notional_pct:  float = 1.0          # notional as fraction of capital
    collateral_pct:      float = 0.20         # margin / notional (20% = 5x leverage)

    # ── ETH price path ────────────────────────────────────────────────────────
    eth_price_path: Literal["flat", "trend_up", "trend_down", "gbm"] = "flat"
    eth_entry_price: float = 2_000.0          # USD at position open
    eth_drift:       float = 0.0              # annualised drift for GBM
    eth_volatility:  float = 0.60             # annualised vol for GBM (60% = realistic crypto)
    eth_trend_daily: float = 0.0              # daily % change for trend scenarios

    # ── Strategy rates ────────────────────────────────────────────────────────
    lending_apy_bps:         float = 500.0    # 5% APY on deposited USDC
    daily_funding_rate_bps:  float = 3.0      # baseline daily funding (bps)
    funding_noise_std_bps:   float = 0.0      # std dev of funding noise for GBM scenario
    spread_bps:              float = 5.0      # initial basis spread (mark - spot)
    spread_convergence_daily: float = 0.0     # daily change in spread (negative = converging)

    # ── Cost estimates ────────────────────────────────────────────────────────
    entry_cost_bps:    float = 5.0            # one-time entry cost (gas + slippage)
    daily_cost_bps:    float = 0.0            # ongoing daily carry cost

    # ── Risk parameters ───────────────────────────────────────────────────────
    maintenance_margin_bps: float = 500.0     # 5% — liquidation threshold

    # ── Random seed ───────────────────────────────────────────────────────────
    seed: int = 42


# ─── 4 Scenarios ──────────────────────────────────────────────────────────────

SCENARIOS: list[ScenarioConfig] = [
    ScenarioConfig(
        name  = "Favorable",
        label = "Favorable (High Funding)",
        days  = 30,
        eth_price_path         = "flat",
        eth_entry_price        = 2_000.0,
        lending_apy_bps        = 500.0,   # 5% APY
        daily_funding_rate_bps = 5.0,     # 0.05%/day — bull market contango
        spread_bps             = 15.0,
        entry_cost_bps         = 5.0,
        maintenance_margin_bps = 500.0,
    ),
    ScenarioConfig(
        name  = "Neutral",
        label = "Neutral (Base Case)",
        days  = 30,
        eth_price_path         = "flat",
        eth_entry_price        = 2_000.0,
        lending_apy_bps        = 500.0,
        daily_funding_rate_bps = 3.0,     # 0.03%/day — moderate contango
        spread_bps             = 5.0,
        entry_cost_bps         = 5.0,
        maintenance_margin_bps = 500.0,
    ),
    ScenarioConfig(
        name  = "Backwardation",
        label = "Backwardation (Bear Market)",
        days  = 30,
        eth_price_path         = "trend_down",
        eth_entry_price        = 2_000.0,
        eth_trend_daily        = -0.007,  # ~-0.7%/day → roughly -20% over 30 days
        lending_apy_bps        = 300.0,   # lending demand falls in bear market
        daily_funding_rate_bps = -2.0,    # -0.02%/day — backwardation
        spread_bps             = -5.0,
        entry_cost_bps         = 5.0,
        maintenance_margin_bps = 500.0,
    ),
    ScenarioConfig(
        name  = "GBM Volatile",
        label = "GBM Volatile (Stochastic)",
        days  = 30,
        eth_price_path         = "gbm",
        eth_entry_price        = 2_000.0,
        eth_drift              = 0.10,    # 10% annualised drift
        eth_volatility         = 0.60,    # 60% annualised vol
        lending_apy_bps        = 500.0,
        daily_funding_rate_bps = 2.0,     # mean funding rate
        funding_noise_std_bps  = 1.5,     # noisy funding ± 1.5 bps/day
        spread_bps             = 5.0,
        entry_cost_bps         = 5.0,
        maintenance_margin_bps = 500.0,
        seed                   = 42,
    ),
]
