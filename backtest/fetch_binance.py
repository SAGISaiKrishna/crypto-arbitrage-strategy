"""
fetch_binance.py
────────────────
Downloads 5 years of ETHUSDT data (spot + perp + funding rate) from OKX
and saves a combined hourly CSV to data/raw/ in the exact format the
backtest expects.

No API key required — uses OKX public REST endpoints only.

Usage:
    python3 backtest/fetch_binance.py

Output:
    data/raw/eth_cash_carry_binance_spot_perp_5yr.csv
"""

import os
import time
import requests
import numpy as np
import pandas as pd
from datetime import datetime, timezone

# ─── Config ───────────────────────────────────────────────────────────────────

START_DATE  = "2020-01-01"
END_DATE    = datetime.now(timezone.utc).strftime("%Y-%m-%d")

BASE_URL    = "https://www.okx.com"
CANDLE_URL  = BASE_URL + "/api/v5/market/history-candles"
RECENT_URL  = BASE_URL + "/api/v5/market/candles"
# OKX only keeps ~3 months of funding history via public API.
# Binance futures keeps 5+ years of funding history and is accessible
# even when Binance spot is geo-blocked.
FUNDING_URL     = BASE_URL + "/api/v5/public/funding-rate-history"   # fallback
BINANCE_FUND_URL = "https://fapi.binance.com/fapi/v1/fundingRate"    # primary

SPOT_ID     = "ETH-USDT"
PERP_ID     = "ETH-USDT-SWAP"
BAR         = "1H"
LIMIT       = 100       # OKX max per request for historical candles
SLEEP_S     = 0.2

ROOT        = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_DIR     = os.path.join(ROOT, "data", "raw")
OUT_FILE    = os.path.join(OUT_DIR, "eth_cash_carry_binance_spot_perp_5yr.csv")

HEADERS     = {"User-Agent": "Mozilla/5.0 (research backtest script)"}


# ─── Helpers ──────────────────────────────────────────────────────────────────

def _ts_ms(date_str: str) -> int:
    dt = datetime.strptime(date_str, "%Y-%m-%d").replace(tzinfo=timezone.utc)
    return int(dt.timestamp() * 1000)


def fetch_candles(inst_id: str, start_ms: int, end_ms: int) -> pd.DataFrame:
    """
    Fetch all 1-hour candles for inst_id between start_ms and end_ms.
    OKX history-candles paginates backwards using 'after' (older than this ts).
    """
    rows = []
    after = str(end_ms)     # start from the end, page backwards
    label = inst_id
    print(f"  Fetching candles ({label})...")

    while True:
        params = {
            "instId": inst_id,
            "bar":    BAR,
            "after":  after,
            "limit":  LIMIT,
        }
        resp = requests.get(CANDLE_URL, params=params, headers=HEADERS, timeout=15)
        resp.raise_for_status()
        data = resp.json()

        if data.get("code") != "0":
            raise RuntimeError(f"OKX API error: {data.get('msg')} — {data}")

        candles = data.get("data", [])
        if not candles:
            break

        # Each candle: [ts, open, high, low, close, vol, volCcy, volCcyQuote, confirm]
        for c in candles:
            ts = int(c[0])
            if ts < start_ms:
                break
            rows.append(c)
        else:
            # Move pagination cursor to oldest candle fetched
            oldest_ts = int(candles[-1][0])
            if oldest_ts <= start_ms:
                break
            after = str(oldest_ts)
            print(f"    ... {len(rows):,} bars so far", end="\r")
            time.sleep(SLEEP_S)
            continue
        break

    print(f"    Total: {len(rows):,} bars          ")

    if not rows:
        raise RuntimeError(f"No candle data returned for {inst_id}")

    df = pd.DataFrame(rows, columns=["ts","open","high","low","close","vol","volCcy","volCcyQuote","confirm"])
    df["timestamp"] = pd.to_datetime(df["ts"].astype(int), unit="ms", utc=True)
    for col in ["open","high","low","close","vol"]:
        df[col] = df[col].astype(float)
    df = df.sort_values("timestamp").drop_duplicates("timestamp").reset_index(drop=True)
    return df[["timestamp","open","high","low","close","vol"]].copy()


def fetch_funding_binance(symbol: str, start_ms: int, end_ms: int) -> pd.DataFrame:
    """Fetch 8-hourly funding rates from Binance futures (5+ years of history)."""
    rows    = []
    current = start_ms
    print(f"  Fetching funding rates from Binance futures ({symbol})...")

    while current < end_ms:
        params = {
            "symbol":    symbol,
            "startTime": current,
            "endTime":   end_ms,
            "limit":     1000,
        }
        resp = requests.get(BINANCE_FUND_URL, params=params, timeout=15)
        resp.raise_for_status()
        data = resp.json()
        if not data:
            break
        rows.extend(data)
        current = int(data[-1]["fundingTime"]) + 1
        print(f"    ... {len(rows):,} records so far", end="\r")
        time.sleep(SLEEP_S)

    print(f"    Total: {len(rows):,} funding records")
    df = pd.DataFrame(rows)
    df["timestamp"]    = pd.to_datetime(df["fundingTime"].astype(int), unit="ms", utc=True)
    df["funding_rate"] = df["fundingRate"].astype(float)
    df = df.sort_values("timestamp").drop_duplicates("timestamp").reset_index(drop=True)
    return df[["timestamp", "funding_rate"]].copy()


def fetch_funding_okx(inst_id: str, start_ms: int, end_ms: int) -> pd.DataFrame:
    """Fallback: fetch funding rates from OKX (last ~3 months only)."""
    rows  = []
    after = str(end_ms)
    print(f"  Fetching funding rates from OKX ({inst_id})...")

    while True:
        params = {"instId": inst_id, "after": after, "limit": 100}
        resp   = requests.get(FUNDING_URL, params=params, headers=HEADERS, timeout=15)
        resp.raise_for_status()
        data    = resp.json()
        records = data.get("data", [])
        if not records:
            break
        for r in records:
            ts = int(r["fundingTime"])
            if ts < start_ms:
                break
            rows.append(r)
        else:
            oldest_ts = int(records[-1]["fundingTime"])
            if oldest_ts <= start_ms:
                break
            after = str(oldest_ts)
            time.sleep(SLEEP_S)
            continue
        break

    df = pd.DataFrame(rows)
    df["timestamp"]    = pd.to_datetime(df["fundingTime"].astype(int), unit="ms", utc=True)
    df["funding_rate"] = df["fundingRate"].astype(float)
    df = df.sort_values("timestamp").drop_duplicates("timestamp").reset_index(drop=True)
    return df[["timestamp", "funding_rate"]].copy()


def fetch_funding(inst_id: str, start_ms: int, end_ms: int) -> pd.DataFrame:
    """Try Binance futures first (5yr history); fall back to OKX if blocked."""
    try:
        df = fetch_funding_binance("ETHUSDT", start_ms, end_ms)
        if len(df) > 500:   # Binance worked and has real history
            return df
        print("    Binance returned limited data, trying OKX...")
    except Exception as e:
        print(f"    Binance funding failed ({e}), falling back to OKX...")
    return fetch_funding_okx(inst_id, start_ms, end_ms)


# ─── Main ─────────────────────────────────────────────────────────────────────

def main():
    os.makedirs(OUT_DIR, exist_ok=True)

    start_ms = _ts_ms(START_DATE)
    end_ms   = int(datetime.now(timezone.utc).timestamp() * 1000)

    print(f"\n=== Data Fetch (OKX) ===")
    print(f"  Period : {START_DATE} → {END_DATE}")
    print(f"  Source : OKX public API (no key required)\n")

    # ── 1. Spot ──────────────────────────────────────────────────────────────
    spot = fetch_candles(SPOT_ID, start_ms, end_ms)
    spot = spot.rename(columns={
        "open":  "spot_price_open",
        "high":  "spot_price_high",
        "low":   "spot_price_low",
        "close": "spot_price_close",
        "vol":   "spot_volume_traded",
    })

    # ── 2. Perp ──────────────────────────────────────────────────────────────
    perp = fetch_candles(PERP_ID, start_ms, end_ms)
    perp = perp.rename(columns={
        "open":  "perp_price_open",
        "high":  "perp_price_high",
        "low":   "perp_price_low",
        "close": "perp_price_close",
        "vol":   "perp_volume_traded",
    })

    # ── 3. Funding ───────────────────────────────────────────────────────────
    funding = fetch_funding(PERP_ID, start_ms, end_ms)

    # ── 4. Merge ─────────────────────────────────────────────────────────────
    print("\n  Merging spot + perp...")
    df = pd.merge(spot, perp, on="timestamp", how="inner")

    print("  Spreading funding rates to hourly bars...")
    funding_hourly = pd.merge_asof(
        df[["timestamp"]].sort_values("timestamp"),
        funding.sort_values("timestamp"),
        on="timestamp",
        direction="backward",
    )
    # Each OKX funding rate is per 8 hours → divide by 8 for per-hour rate
    funding_hourly["funding_rate"] = funding_hourly["funding_rate"].fillna(0.0) / 8.0
    df = pd.merge(df, funding_hourly, on="timestamp", how="left")

    # ── 5. Derived columns ───────────────────────────────────────────────────
    print("  Computing basis columns...")
    df["basis_abs"]     = df["perp_price_close"] - df["spot_price_close"]
    df["basis_pct"]     = (df["basis_abs"] / df["spot_price_close"]) * 100
    df["log_basis_bps"] = np.log(df["perp_price_close"] / df["spot_price_close"]) * 10_000

    df = df.dropna(subset=["spot_price_close","perp_price_close"])
    df = df[(df["spot_price_close"] > 0) & (df["perp_price_close"] > 0)]
    df = df.sort_values("timestamp").reset_index(drop=True)

    # ── 6. Save ──────────────────────────────────────────────────────────────
    df.to_csv(OUT_FILE, index=False)

    print(f"\n=== Done ===")
    print(f"  Rows   : {len(df):,} hourly bars")
    print(f"  Period : {df['timestamp'].min()} → {df['timestamp'].max()}")
    print(f"  File   : {OUT_FILE}")
    print(f"\n  Now run:  python3 backtest/run_backtest.py\n")


if __name__ == "__main__":
    main()
