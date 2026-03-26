# Design and Analysis of a Crypto Arbitrage Strategy Using Perpetual Futures Hedging

> A proof-of-concept strategy platform and quantitative analysis framework.
> Implements on-chain perpetual hedging mechanics with USDC collateral and simulates
> carry/funding arbitrage profitability across multiple market scenarios.

---

## Project Overview

This project designs and analyzes a crypto arbitrage strategy that exploits the funding
rate premium present in perpetual futures markets. A vault accepts USDC deposits, accrues
lending yield on idle capital, and allocates margin to a short ETH perpetual position that
earns funding income when the market is in contango. The strategy is rule-based: it enters
only when projected carry exceeds estimated costs, and exits when margin health or funding
conditions deteriorate.

The project combines:
- On-chain smart contracts (Solidity, Sepolia testnet)
- A Chainlink price oracle integration
- A quantitative Python simulation across multiple market scenarios
- A written research report analyzing strategy viability

---

## Repository Structure

```
contracts/       Solidity contracts (vault, perp engine, oracle, token, math library)
test/            Unit and integration tests (Hardhat + TypeScript)
scripts/         Deployment and interaction scripts (local + Sepolia)
simulation/      Python scenario analysis, metrics, charts, CSV export
frontend/        Minimal web interface (wallet connect, deposit, hedge controls)
docs/            Architecture diagrams, strategy notes, formula reference
report/          Final written submission
excel/           Auto-generated CSV outputs from simulation
charts/          Auto-generated chart PNGs from simulation
screenshots/     Etherscan and terminal screenshots for submission
```

---

## Setup

```bash
# Install dependencies
npm install

# Copy environment file and fill in values
cp .env.example .env

# Compile contracts
npx hardhat compile

# Run tests
npx hardhat test

# Deploy locally
npx hardhat run scripts/deploy-local.ts --network localhost

# Deploy to Sepolia
npx hardhat run scripts/deploy-sepolia.ts --network sepolia
```

---

## Contracts

| Contract | Purpose |
|---|---|
| `ArbitrageToken.sol` | ERC20 token (CARB) — course deployment requirement |
| `MockUSDC.sol` | Mintable USDC for local and testnet testing |
| `MockPriceOracle.sol` | Hardcoded/settable price for local testing |
| `ChainlinkPriceOracle.sol` | Chainlink ETH/USD feed wrapper (Sepolia) |
| `MockPerpEngine.sol` | Simulated perpetual short engine (position, funding, margin) |
| `StrategyVault.sol` | Main vault: deposits, lending yield, hedge lifecycle, PnL reporting |
| `ArbitrageMath.sol` | Pure math library: carry score, margin ratio, break-even |

---

## Simulation

```bash
cd simulation
pip install -r requirements.txt
python main.py
```

Outputs CSVs to `excel/` and charts to `charts/`.

---

## Environment Variables

See `.env.example` for required variables:
- `PRIVATE_KEY`
- `SEPOLIA_RPC_URL`
- `ETHERSCAN_API_KEY`

---

## Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Compile contracts
npx hardhat compile

# 3. Run tests
npx hardhat test

# 4. Run simulation (generates CSVs + charts)
cd simulation
pip install -r requirements.txt
python main.py
cd ..

# 5. Deploy to local Hardhat node (two terminals)
npx hardhat node
npx hardhat run scripts/deploy-local.ts --network localhost

# 6. Deploy to Sepolia (fill .env first)
npx hardhat run scripts/deploy-sepolia.ts --network sepolia

# 7. Verify on Etherscan (run from same wallet as deployment)
npx hardhat run scripts/verify-sepolia.ts --network sepolia

# 8. Run interaction demo (fill ADDRESSES in scripts/interact.ts first)
npx hardhat run scripts/interact.ts --network sepolia
```

---

## Known Limitations

- **Lending yield is an accounting abstraction.** In this proof-of-concept, lending yield is computed and tracked on-chain per second but is not backed by real USDC in the vault. In a production system, deposited USDC would be supplied to a protocol such as Aave, with interest funded by borrowers and returned as yield-bearing tokens.
- **Simulation uses assumed parameters.** The Python scenario analysis uses hardcoded rates (funding, APY, volatility) rather than live market data. Results are illustrative of strategy mechanics under specific conditions, not a historical backtest.
- **MockPerpEngine is not a real exchange.** The perpetual engine simulates position mechanics (funding accrual, mark-to-market PnL, margin ratio) but does not model order books, slippage, counterparty risk, or settlement delays.