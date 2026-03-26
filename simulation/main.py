"""
main.py
───────
Entry point for the full simulation pipeline.

Run with:
    cd simulation
    pip install -r requirements.txt
    python main.py

Outputs:
  ../excel/    — 7 CSV files (daily positions, summary, break-even, margin, assumptions)
  ../charts/   — 6 PNG charts

These outputs are directly referenced in the final report.
"""

from scenarios import run_all_scenarios
from metrics   import compute_all_summaries, build_break_even_grid
from plots     import generate_all_charts
from export    import export_all


def main() -> None:
    print("=" * 60)
    print(" Crypto Arbitrage Strategy — Simulation Pipeline")
    print("=" * 60)

    # ── 1. Run all 4 scenarios ────────────────────────────────────────────────
    print("\nRunning scenarios...")
    results = run_all_scenarios()

    # ── 2. Compute summary metrics ────────────────────────────────────────────
    print("\nComputing metrics...")
    summary_df = compute_all_summaries(results)

    print("\n─── Scenario Summary ────────────────────────────────────────")
    print(summary_df[[
        "scenario",
        "final_net_pnl_usd",
        "annualized_return_pct",
        "sharpe_ratio",
        "max_drawdown_usd",
        "break_even_days",
        "days_at_liquidation_risk",
    ]].to_string(index=False))
    print("─────────────────────────────────────────────────────────────\n")

    # ── 3. Build break-even grid ──────────────────────────────────────────────
    grid_df = build_break_even_grid()

    # ── 4. Export CSVs ────────────────────────────────────────────────────────
    export_all(results, summary_df, grid_df)

    # ── 5. Generate charts ────────────────────────────────────────────────────
    generate_all_charts(results, summary_df, grid_df)

    print("\n" + "=" * 60)
    print(" Simulation complete.")
    print(" CSVs   → excel/")
    print(" Charts → charts/")
    print("=" * 60 + "\n")


if __name__ == "__main__":
    main()
