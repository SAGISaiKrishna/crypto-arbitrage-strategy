"""
export.py
─────────
Writes all simulation outputs to the excel/ folder as CSV files.
These CSVs are the primary data deliverable for the course submission.
"""

import os
import pandas as pd

EXCEL_DIR = os.path.join(os.path.dirname(__file__), "..", "excel")
os.makedirs(EXCEL_DIR, exist_ok=True)


def _write(df: pd.DataFrame, filename: str) -> None:
    path = os.path.join(EXCEL_DIR, filename)
    df.to_csv(path, index=False)
    print(f"  Saved: {path}  ({len(df)} rows × {len(df.columns)} cols)")


def export_all(
    results: dict[str, pd.DataFrame],
    summary_df: pd.DataFrame,
    grid_df: pd.DataFrame,
) -> None:
    print("\nExporting CSVs to excel/...")

    # 1. Per-scenario daily position data
    name_map = {
        "Favorable":    "daily_positions_favorable.csv",
        "Neutral":      "daily_positions_neutral.csv",
        "Backwardation":"daily_positions_backwardation.csv",
        "GBM Volatile": "daily_positions_gbm_volatile.csv",
    }
    for name, df in results.items():
        filename = name_map.get(name, f"daily_positions_{name.lower().replace(' ', '_')}.csv")
        _write(df, filename)

    # 2. Scenario summary (one row per scenario)
    _write(summary_df, "scenario_summary.csv")

    # 3. Break-even analysis grid
    _write(grid_df.reset_index().rename(columns={"index": "daily_funding_bps"}),
           "break_even_analysis.csv")

    # 4. Margin health (margin ratio + health factor, all scenarios combined)
    margin_rows = []
    for name, df in results.items():
        sub = df[["day", "margin_ratio_bps", "health_factor"]].copy()
        sub.insert(0, "scenario", name)
        margin_rows.append(sub)
    _write(pd.concat(margin_rows, ignore_index=True), "margin_health.csv")

    # 5. Assumptions / parameters table
    from config import SCENARIOS
    param_rows = []
    for cfg in SCENARIOS:
        param_rows.append({
            "scenario":                cfg.name,
            "days":                    cfg.days,
            "initial_capital_usd":     cfg.initial_capital_usd,
            "eth_price_path":          cfg.eth_price_path,
            "eth_entry_price":         cfg.eth_entry_price,
            "eth_drift":               cfg.eth_drift,
            "eth_volatility":          cfg.eth_volatility,
            "lending_apy_bps":         cfg.lending_apy_bps,
            "daily_funding_rate_bps":  cfg.daily_funding_rate_bps,
            "funding_noise_std_bps":   cfg.funding_noise_std_bps,
            "spread_bps":              cfg.spread_bps,
            "collateral_pct":          cfg.collateral_pct,
            "entry_cost_bps":          cfg.entry_cost_bps,
            "maintenance_margin_bps":  cfg.maintenance_margin_bps,
        })
    _write(pd.DataFrame(param_rows), "assumptions.csv")

    print(f"All CSVs saved to {EXCEL_DIR}/")
