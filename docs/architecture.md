# Architecture

## Contract Dependency Map

```
IPriceOracle (interface)
    ├── MockPriceOracle          ← local testing
    └── ChainlinkPriceOracle     ← Sepolia production

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

ArbitrageToken              ← standalone ERC20, no dependencies
ArbitrageMath               ← pure library, no external dependencies
```

## Data Flow

```
User
 │ deposit(usdcAmount)
 ▼
StrategyVault
 │ tracks: shares, principal, depositTimestamp
 │ accrues: lending yield (simple interest per second)
 │ holds:   USDC balance
 │
 └─► [owner calls openHedge(notional, collateral, fundingRateBps)]
         │
         ├── ArbitrageMath.calcCarryScore() → check viability
         │
         ├── approve MockPerpEngine to spend collateral USDC
         │
         └── MockPerpEngine.openShort(notional, collateral)
                 │
                 ├── reads IPriceOracle.getPrice() → entryPrice
                 └── stores Position struct

         [time passes — funding accrues per second via block.timestamp]

 └─► [anyone calls MockPerpEngine.accrueFunding(vault)]
         └── checkpoints cumulativeFunding += calcFundingPayment()

 └─► [view calls: getVaultState(), getUserValue(), getUnrealizedPnL()]
         └── reads oracle, computes current PnL, margin ratio

 └─► [owner calls closeHedge()]
         └── MockPerpEngine.closeShort()
                 ├── reads current oracle price
                 ├── computes: price PnL + cumulative funding
                 └── transfers (collateral ± PnL) back to StrategyVault

 └─► [user calls withdraw(shares)]
         ├── settles lending yield
         └── returns proportional USDC to user
```

## Key Design Decisions

| Decision | Choice | Reason |
|----------|--------|--------|
| Share accounting | Internal mapping (uint256) | Simpler than ERC20 shares; avoids aUSDC token complexity |
| Lending yield | On-chain simple interest | Honest, testable, shows on Etherscan |
| Oracle | Interface abstraction | Swap Mock ↔ Chainlink at deploy time |
| Access control | Owner-only openHedge/closeHedge | Cleaner; manager controls strategy timing |
| LendingVault | Not a separate contract | Lending yield lives in StrategyVault |
| aUSDC | Not minted | CARB satisfies ERC20 requirement |
