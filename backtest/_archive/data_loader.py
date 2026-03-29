"""
data_loader.py
──────────────
Loads the combined hourly spot + perp dataset from data/raw/.

Expected file (place in data/raw/ before running):

  A single combined CSV file matching the pattern:
    eth_cash_carry_*.csv

  Format: 1-hour bars, sources Coinbase spot ETH/USD + Deribit perp ETH/USD
  Key columns used:
    timestamp           — hourly UTC timestamps
    spot_price_close    — ETH/USD spot close price (Coinbase)
    perp_price_close    — ETH/USD perp close price (Deribit)
    basis_pct           — (perp − spot) / spot × 100  [clean, no NaN]
    log_basis_bps       — ln(perp / spot) × 10 000    [clean, no NaN]
    funding_rate        — hourly funding rate sum (may contain NaN)

Output:
  data/processed/merged_daily.csv
    Columns: date, spot_close, perp_close, basis_pct_mean,
             log_basis_bps_mean, funding_rate_daily
"""

import glob
import os

import numpy as np
import pandas as pd


# ─── Paths ────────────────────────────────────────────────────────────────────

ROOT          = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW_DIR       = os.path.join(ROOT, "data", "raw")
PROCESSED_DIR = os.path.join(ROOT, "data", "processed")
OUTPUT_FILE   = os.path.join(PROCESSED_DIR, "merged_daily.csv")


# ─── File detection ───────────────────────────────────────────────────────────

def _find_combined_file(raw_dir: str = RAW_DIR) -> str:
    """
    Auto-detect the combined CSV file in data/raw/.
    Matches any file beginning with 'eth_cash_carry' or 'eth_'.
    Raises FileNotFoundError with a helpful message if nothing found.
    """
    patterns = [
        os.path.join(raw_dir, "eth_cash_carry*.csv"),
        os.path.join(raw_dir, "eth_*.csv"),
    ]
    for pattern in patterns:
        matches = sorted(glob.glob(pattern))
        if matches:
            return matches[-1]  # use the most recently named file if multiple

    raise FileNotFoundError(
        f"No combined dataset found in {raw_dir}\n"
        "Expected a file matching: eth_cash_carry*.csv\n"
        "Columns required: timestamp, spot_price_close, perp_price_close,\n"
        "                  basis_pct, log_basis_bps\n"
        "See data/README.md for the expected format."
    )


# ─── Loader ───────────────────────────────────────────────────────────────────

def load_combined(path: str = None) -> pd.DataFrame:
    """
    Load and parse the combined hourly spot + perp CSV.

    Returns a DataFrame with one row per hour and columns:
        timestamp, spot_price_close, perp_price_close,
        basis_pct, log_basis_bps, funding_rate
    """
    if path is None:
        path = _find_combined_file()

    print(f"  Loading: {os.path.basename(path)}")
    df = pd.read_csv(path)
    df.columns = [c.strip() for c in df.columns]

    # Parse timestamp (handles timezone-aware strings)
    df["timestamp"] = pd.to_datetime(df["timestamp"], utc=True)

    # Required columns
    required = ["spot_price_close", "perp_price_close", "basis_pct", "log_basis_bps"]
    missing  = [c for c in required if c not in df.columns]
    if missing:
        raise ValueError(
            f"Missing required columns in {path}: {missing}\n"
            f"Available: {list(df.columns)}"
        )

    # funding_rate is optional — fill NaN with 0
    if "funding_rate" not in df.columns:
        df["funding_rate"] = 0.0
    else:
        n_nan = df["funding_rate"].isna().sum()
        if n_nan > 0:
            df["funding_rate"] = df["funding_rate"].fillna(0.0)

    df = df.sort_values("timestamp").reset_index(drop=True)
    return df[[
        "timestamp", "spot_price_close", "perp_price_close",
        "basis_pct", "log_basis_bps", "funding_rate",
    ]]


# ─── Hourly → Daily aggregation ───────────────────────────────────────────────

def aggregate_daily(hourly: pd.DataFrame) -> pd.DataFrame:
    """
    Aggregate 1-hour bars to daily bars.

    Aggregation rules:
        spot_close          — last spot_price_close of the day
        perp_close          — last perp_price_close of the day
        basis_pct_mean      — mean basis_pct  (clean proxy for daily carry level)
        log_basis_bps_mean  — mean log_basis_bps (annualised carry in bps when × 365)
        funding_rate_daily  — sum of hourly funding_rate values
    """
    hourly = hourly.copy()
    hourly["date"] = hourly["timestamp"].dt.normalize()

    daily = (
        hourly.groupby("date")
        .agg(
            spot_close         = ("spot_price_close",  "last"),
            perp_close         = ("perp_price_close",  "last"),
            basis_pct_mean     = ("basis_pct",         "mean"),
            log_basis_bps_mean = ("log_basis_bps",     "mean"),
            funding_rate_daily = ("funding_rate",      "sum"),
        )
        .reset_index()
    )

    daily["date"] = pd.to_datetime(daily["date"])
    daily = daily.sort_values("date").reset_index(drop=True)
    return daily


# ─── Main entry point ─────────────────────────────────────────────────────────

def load_and_merge(
    raw_path:    str = None,
    output_path: str = OUTPUT_FILE,
) -> pd.DataFrame:
    """
    Load the combined hourly CSV, aggregate to daily, save to processed/.

    Returns a daily DataFrame with columns:
        date, spot_close, perp_close,
        basis_pct_mean, log_basis_bps_mean, funding_rate_daily
    """
    hourly = load_combined(raw_path)
    daily  = aggregate_daily(hourly)

    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    daily.to_csv(output_path, index=False)

    date_min = daily["date"].min().date()
    date_max = daily["date"].max().date()
    n_days   = len(daily)
    avg_basis = daily["log_basis_bps_mean"].mean()
    ann_basis = avg_basis * 365

    print(f"  {n_days} days of data  ({date_min} → {date_max})")
    print(f"  Avg daily log-basis : {avg_basis:.2f} bps/day")
    print(f"  Annualised basis    : {ann_basis:.1f} bps/year")
    print(f"  Saved: {output_path}")

    return daily


# ─── Convenience re-loader ────────────────────────────────────────────────────

def load_processed(path: str = OUTPUT_FILE) -> pd.DataFrame:
    """Load the pre-aggregated daily CSV. Run load_and_merge() first."""
    if not os.path.exists(path):
        raise FileNotFoundError(
            f"Processed data not found at {path}.\n"
            "Run backtest/main.py or call load_and_merge() first."
        )
    df = pd.read_csv(path, parse_dates=["date"])
    return df.sort_values("date").reset_index(drop=True)
