# Harvesting Alpha: Delta-Neutral Funding Rate Arbitrage on ETH Perpetual Futures

A final project combining a Python backtest and an on-chain proof-of-concept for a
delta-neutral long-spot / short-perpetual ETH carry strategy.

---

## 🚀 Live App
👉 [Open the Vercel App][(https://crypto-arbitrage-strategy.vercel.app/)]

## What This Project Does

The strategy runs two equal-notional legs simultaneously:

| Leg | Position |
|-----|----------|
| Long spot | ETH spot exposure (via index price) |
| Short perp | ETHUSDT perpetual futures |

Because the legs are equal and opposite, ETH price moves largely cancel out. The income
comes from the perpetual funding rate — paid by long traders to short traders when the
market is in contango.

**Net carry = funding income − benchmark opportunity cost − transaction costs**

The project has three independent layers:

- **Backtest** — Python, runs on the provided Bybit historical dataset
- **Smart contracts** — Solidity proof-of-concept deployed on Sepolia
- **Frontend** — lightweight demo UI connecting to the contracts via MetaMask

---

## Repository Structure

```
backtest/
  run_backtest.py       main entry point — run this for the backtest
  _archive/             legacy scripts (not part of final workflow)

data/
  raw/                  bybit_eth_usdt_1h.csv (required for backtest)
  processed/            empty

contracts/
  core/                 StrategyVault.sol, MockPerpEngine.sol, ArbitrageMath.sol
  token/                ArbitrageToken.sol (CARB ERC20)
  oracles/              ChainlinkPriceOracle.sol (Sepolia ETH/USD)
  mocks/                MockUSDC.sol, MockPriceOracle.sol
  interfaces/           IStrategyVault, IPerpEngine, IPriceOracle

scripts/                deploy-local.ts, deploy-sepolia.ts, verify-sepolia.ts
test/                   unit + integration tests
docs/                   strategy.md, formulas.md, architecture.md
frontend/               index.html, app.js, style.css, contracts/
output/
  charts/               backtest charts (generated)
  tables/               backtest CSVs (generated)
report/                 final_report.md
```

---

## Quick Start

### Dependencies

```bash
npm install
pip install pandas numpy matplotlib
```

Copy `.env.example` to `.env` and fill in your own values before deploying.

---

### Run the backtest

The dataset (`data/raw/bybit_eth_usdt_1h.csv`) must be present. Then:

```bash
python3 backtest/run_backtest.py
```

Outputs written to `output/`:
- `tables/backtest_hourly.csv`
- `tables/backtest_metrics.csv`
- `charts/chart1_cumulative_pnl.png`
- `charts/chart2_drawdown.png`
- `charts/chart3_pnl_decomposition.png`

---

### Run the tests

```bash
npx hardhat test
```

Expected: **76 tests passing**.

---

### Run the frontend locally

**Step 1** — start a local Hardhat node:
```bash
npx hardhat node
```

**Step 2** — deploy contracts locally (new terminal):
```bash
npx hardhat run scripts/deploy-local.ts --network localhost
```

**Step 3** — serve the frontend:
```bash
cd frontend && python3 -m http.server 8080
```

Open `http://127.0.0.1:8080` in a browser with MetaMask installed.

MetaMask network settings for local:
- RPC URL: `http://127.0.0.1:8545`
- Chain ID: `31337`

Import one of the Hardhat test accounts shown in the node terminal.

> These test accounts are for local development only. Do not use them on Sepolia or mainnet.

---

### Deploy to Sepolia

```bash
npx hardhat run scripts/deploy-sepolia.ts --network sepolia
npx hardhat run scripts/verify-sepolia.ts  --network sepolia
```

---

## Smart Contract Addresses (Sepolia)

| Contract | Address | Etherscan |
|----------|---------|-----------|
| MockUSDC | `0x84EAb608016e21E4618c63B01F7b3b043F4f457e` | [View ↗](https://sepolia.etherscan.io/address/0x84EAb608016e21E4618c63B01F7b3b043F4f457e) |
| ArbitrageToken (CARB) | `0xd2E7bA891e0Ecd142695d04e8Ed79e0C4947922F` | [View ↗](https://sepolia.etherscan.io/address/0xd2E7bA891e0Ecd142695d04e8Ed79e0C4947922F) |
| ChainlinkPriceOracle | `0x27768a80Fb849F6c1bB941C8de62F417Cd968e35` | [View ↗](https://sepolia.etherscan.io/address/0x27768a80Fb849F6c1bB941C8de62F417Cd968e35) |
| MockPerpEngine | `0x478832D03495390E47aFD238A9bA11414096A452` | [View ↗](https://sepolia.etherscan.io/address/0x478832D03495390E47aFD238A9bA11414096A452) |
| StrategyVault | `0x036EA2E331994a04d853B54Ad19D05524eC5b399` | [View ↗](https://sepolia.etherscan.io/address/0x036EA2E331994a04d853B54Ad19D05524eC5b399) |

---

## What Is Real vs Mocked

| Component | Status |
|-----------|--------|
| Backtest prices | Real — Bybit ETHUSDT hourly, 2021–2026 |
| Backtest funding rates | Real — Bybit 8h settlement rates |
| ETH/USD oracle (Sepolia) | Real — Chainlink ETH/USD feed |
| Perpetual exchange | Mock — `MockPerpEngine` (no real order book) |
| USDC | Mock — `MockUSDC` (mintable for testing) |

---

## Backtest Results (summary)

| Metric | Value |
|--------|-------|
| Period | Jan 2021 – Mar 2026 |
| Net PnL on $10k | +$18,442 |
| Annualised return | 35.2% |
| Max drawdown | -$1,326 (-13%) |
| Sharpe (daily, 2% rf) | 6.59 |

**Note on Sharpe**: the result is heavily influenced by elevated funding rates during the
2021 bull market. From 2022 onwards in a flat/bear environment, the Sharpe drops to
approximately 0.4. Treat the full-period figure as context, not a stable forward estimate.

---

## Strategy Details

### Carry gate

Position only opens when the 7-day rolling annualised funding rate exceeds 250 bps
(2% opportunity cost + ~0.5% estimated costs). Checked once per day using prior-day data.

### On-chain carry score (ArbitrageMath.sol)

```
carryScore = (dailyFundingRate × 365) − benchmarkRate − costs
```

Entry allowed when `carryScore > threshold`.

### Auto-exit conditions (StrategyVault.sol)

1. Perp margin ratio drops below 800 bps
2. Net loss exceeds 10% of collateral
3. Carry score turns negative
4. Position held longer than 30 days

---

## Limitations

- `MockPerpEngine` does not model slippage, liquidation mechanics, or counterparty risk
- Backtest assumes perfect fills at hourly close prices with no rebalancing
- The contracts and backtest are independent — the vault does not read historical data
- Backtest covers one market cycle; results are not a forecast of future performance

---

## Gas Report

Run `npm run test:gas` to regenerate `gas-report.txt`.

Key operations (approximate):
- `openHedge()` — ~333k gas
- `deposit()` — ~170k gas
- `closeHedge()` — ~110k gas
- `withdraw()` — ~66k gas

---

## Environment Variables

```bash
PRIVATE_KEY=           # wallet private key (without 0x prefix)
SEPOLIA_RPC_URL=       # Alchemy or Infura Sepolia endpoint
ETHERSCAN_API_KEY=     # for contract verification
```

Never commit `.env`. Each teammate should use their own credentials.
