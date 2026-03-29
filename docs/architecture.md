# Architecture

## Contract Dependency Map

```
IPriceOracle (interface)
    ├── MockPriceOracle          ← local testing
    └── ChainlinkPriceOracle     ← Sepolia (real ETH/USD feed)

IPerpEngine (interface)
    └── MockPerpEngine
            ├── uses: IPriceOracle
            └── uses: ArbitrageMath (library)

IStrategyVault (interface)
    └── StrategyVault
            ├── holds: MockUSDC (IERC20)
            ├── calls: IPerpEngine → MockPerpEngine
            ├── reads: IPriceOracle
            └── uses:  ArbitrageMath (library)

ArbitrageToken (CARB)   ← standalone ERC20, no dependencies
ArbitrageMath           ← pure library, no external dependencies
```

---

## Lifecycle

```
User
 │ deposit(usdcAmount)
 ▼
StrategyVault
 │ tracks shares and deposit timestamp
 │ accrues lending yield (simple interest per second)
 │
 └─► owner calls openHedge(notional, collateral, fundingRateBps)
         │
         ├── ArbitrageMath.calcCarryScore() — check viability
         ├── approve MockPerpEngine for collateral spend
         └── MockPerpEngine.openShort(notional, collateral)
                 └── reads oracle price → stores Position

     [time passes, funding accrues via block.timestamp]

 └─► anyone calls MockPerpEngine.accrueFunding(vault)
         └── cumulativeFunding += calcFundingPayment()

 └─► view: getVaultState(), getUserValue(), getUnrealizedPnL()

 └─► owner calls closeHedge()
         └── MockPerpEngine.closeShort()
                 ├── reads current oracle price
                 ├── computes price PnL + cumulative funding
                 └── returns (collateral ± PnL) to StrategyVault

 └─► user calls withdraw(shares)
         └── returns proportional USDC + accrued yield
```

---

## Key design decisions

| Decision | Choice | Reason |
|---|---|---|
| Oracle abstraction | Interface (Mock / Chainlink) | Swap at deploy time without changing vault code |
| Access control | Owner-only for openHedge / closeHedge | Manager controls strategy timing |
| ERC20 requirement | ArbitrageToken (CARB) | Course requirement; separate from vault shares |
| Perp exchange | MockPerpEngine | No real exchange on testnet; proof-of-concept |
| Share accounting | Internal mapping | Simpler than a separate share token |

---

## What is real vs mocked

| Component | Status |
|---|---|
| ETH/USD price feed (Sepolia) | Real — Chainlink oracle |
| Perpetual exchange | Mock — `MockPerpEngine` (no order book) |
| USDC | Mock — `MockUSDC` (mintable for testing) |
| Backtest data | Real — Bybit ETHUSDT hourly, 2021–2026 |

The backtest and smart contracts are independent layers. The contracts implement
the same carry-gate logic as the backtest but do not read from the historical dataset.
