# Strategy Methodology

## What This Strategy Does

This is a **crypto carry trade** that extracts two simultaneous yield streams from a single USDC deposit:

1. **Lending Yield** — Deposited USDC earns a configurable annual percentage yield (APY), computed on-chain as simple interest accrued per second. This models the income a USDC lender earns in a money market protocol (e.g. Aave).

2. **Funding Rate Income** — A portion of USDC is posted as margin to open a short ETH perpetual futures position. When the market is in *contango* (long demand exceeds short demand), the exchange's funding mechanism transfers periodic payments from long traders to short traders. The vault earns these payments.

The strategy is **rule-based**: it opens a hedge only when the projected annualised carry (lending APY + annualised funding rate − estimated costs) exceeds a configurable threshold. It exits when funding deteriorates or margin health falls below a safety floor.

---

## The Carry Condition

```
carryScore = lendingAPYBps + (dailyFundingRateBps × 365) − costBps

Strategy opens  when: carryScore > minCarryThresholdBps (default: 200 bps)
Strategy closes when: funding turns negative  OR  marginRatio < maintenanceMarginBps
```

**Example** (base case):
- Lending APY: 500 bps (5%)
- Daily funding: 3 bps/day → 1 095 bps/year
- Cost estimate: 50 bps
- **carryScore = 500 + 1 095 − 50 = 1 545 bps (15.45% annualised) → VIABLE**

---

## The Two Yield Streams

The same $100 000 of USDC does two jobs simultaneously:

| Job | Mechanism | Yield |
|-----|-----------|-------|
| 1. Lending yield | Vault accrues interest on principal at `lendingAPYBps` | ~5% APY |
| 2. Funding income | Short perp earns from long traders in contango | ~10.95% APY at 3 bps/day |

Combined gross carry ≈ **15.45% APY** before costs and price risk.

---

## Retained Risk (Important)

This is **NOT** a delta-neutral strategy. The short position has **negative ETH delta**:

- If ETH price **falls**: short position profits (amplifies yield)
- If ETH price **rises**: short position loses (can exceed yield income)
- If ETH rises far enough: margin ratio falls below maintenance threshold → **liquidation risk**

The simulation explicitly models this risk across four scenarios, including a backwardation / bear market scenario where the strategy produces a net loss.

---

## Why "Arbitrage" Is a Valid Framing

The term "arbitrage" here refers to the exploitation of a structural market premium:

> In perpetual futures markets, crypto retail investors exhibit a systematic long bias. This creates persistent contango — the perp mark price trades above the spot price. The funding mechanism enforces convergence by transferring value from longs to shorts. A short seller is effectively *receiving the structural premium* that longs pay for leverage.

This is analogous to a basis trade or carry trade in traditional finance — capturing the spread between a leveraged instrument and its underlying. The profit is not risk-free (hence "carry arbitrage" rather than "pure arbitrage"), but it is structurally motivated and mean-reverting.

---

## Key Assumptions

| Assumption | Value | Notes |
|------------|-------|-------|
| Funding rate persistence | Positive on average | Driven by retail long bias in crypto |
| Lending APY | 5% default | Configurable; realistic for USDC in major protocols |
| Collateral ratio | 20% | 5× leverage on notional |
| Maintenance margin | 5% | Below this, position is liquidatable |
| Gas + slippage | 50 bps round-trip | Conservative estimate for testnet |

---

## Risks That Break the Strategy

1. **Sustained backwardation** — If funding turns persistently negative, the trade loses money even with lending yield.
2. **Sharp ETH price rise** — The short loses mark-to-market; if losses exceed collateral buffer, liquidation occurs.
3. **Lending yield collapse** — If credit demand falls, lending APY drops; carry score may fall below threshold.
4. **Oracle failure** — Stale or manipulated price → incorrect PnL / margin calculations.
5. **Smart contract risk** — MockPerpEngine is a simulation, not a real exchange. Slippage, counterparty risk, and settlement risk are not modelled.
