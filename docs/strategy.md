# Strategy

## Overview

This is a delta-neutral ETH carry strategy. It holds two equal-notional legs simultaneously:

- **Long leg**: ETH spot exposure
- **Short leg**: ETHUSDT perpetual futures for the same notional

Because the legs are equal and opposite, ETH price moves cancel out. The only remaining
income is the perpetual funding rate — the periodic payment that long traders pay to short
traders when the market is in contango (perp price > spot price).

## Entry condition (carry gate)

The position only opens when expected carry exceeds the opportunity cost and transaction costs:

```
7-day rolling annualised funding rate > 250 bps
```

The 250 bps threshold = 200 bps opportunity cost (2% annual) + 50 bps estimated costs.
The signal is lagged one day to avoid look-ahead bias.

This mirrors the carry gate in `StrategyVault.sol`.

## PnL mechanics

Per hourly bar (t ≥ 1):

```
spot_pnl    =  position_size × (spot_t − spot_{t-1})
perp_pnl    = −position_size × (perp_t − perp_{t-1})
funding_pnl =  position_size × perp_t × funding_rate_{t-1}
```

Spot and perp legs cancel on price moves. Net income comes from `funding_pnl`.

## Transaction costs

0.20% of capital per entry and exit. Deducted at each gate transition.

## Exit condition

Gate closes when the 7-day rolling annualised funding drops below 250 bps.
The strategy sits in cash until conditions improve.

## Results summary (Bybit dataset, 2021–2026)

| Metric | Value |
|---|---|
| Period | Jan 2021 – Mar 2026 |
| Net PnL on $10k | +$18,442 |
| Annualised return | 35.2% |
| Max drawdown | -$1,326 (-13%) |
| Sharpe (daily) | 6.59 |
| Time invested | 79% of days |

**Sharpe note**: the high Sharpe is driven by 2021 (42% ann. funding). From 2022–2026
alone, the Sharpe was approximately 0.4 — the strategy is weaker in bear/flat markets.

## Limitations

- Assumes perfect fills at hourly close prices with no slippage
- No intra-position rebalancing; position size is fixed at entry
- Smart contracts are a proof-of-concept, not connected to a real exchange
