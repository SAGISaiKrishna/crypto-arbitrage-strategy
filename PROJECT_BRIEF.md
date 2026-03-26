# PROJECT BRIEF — Crypto Arbitrage: Lending + Perpetual Futures Hedging
> Copy this file into your new repo root. In a new Claude Code session, say:
> "Read PROJECT_BRIEF.md and ask me any clarifying questions before we start building."

---

## 1. Who We Are

- 3-person student team
- Final project for a university crypto/blockchain course
- Timeline: 3 days to build, test, deploy, and write the report
- Goal: strong submission AND something useful on a quant trading / quant research resume

---

## 2. Professor-Approved Project Title

**"Design and Analysis of an Arbitrage Strategy Using Crypto Lending and Perpetual Futures Hedging"**

This was a custom project proposal submitted by email and explicitly approved by the professor.
Do NOT rename it. Do NOT reframe it as a "vault product" or "DeFi protocol."
It is a **strategy study with a proof-of-concept on-chain implementation.**

---

## 3. Course Requirements (from the official rubric)

The professor requires ALL of the following for maximum marks:

### Mandatory deliverables:
- [ ] Deploy a fully functional Solidity smart contract on testnet (Sepolia)
- [ ] Mint and deploy a new ERC20 token (or NFT) — we are doing ERC20
- [ ] Etherscan links to all deployed contracts — verified on-chain
- [ ] Screenshots of contract execution
- [ ] Complete source code (Solidity) with documentation
- [ ] Excel/CSV data showing: unrealized P&L, positions, trades, funding rates, collateral, margin — with plot diagrams
- [ ] Written report: methodology, assumptions, what you learned, P&L strategy summary
- [ ] Report AND/OR video demo

### Grading rubric (each out of 5):
1. Rigor of methodology
2. Originality of project
3. Amount of work
4. Clarity of presentation
5. Quality of code
6. Advanced functionality (see below)

### Advanced functionality (bonus points, aim for all):
- Chainlink oracle inside the smart contract (bring in external ETH/USD price data)
- Reference to DeFi L2 protocols like Aave for lending (professor specifically named Aave)
- Front-end interactive design with navigation
- Gas fees measured and optimized
- Creative token utility

### This project falls under option 2 from the professor's list:
> "Create and deploy a hedging strategy based on perpetual swaps (perpetual bitcoin inverse futures)"
> — but with our custom extension: lending is combined with the hedge for an arbitrage study.

---

## 4. The Strategy We Are Building

### Plain English
A user deposits USDC. That USDC goes into a mock lending pool (simulating Aave) and earns a lending yield. The same capital also acts as margin for a perpetual futures short position, which earns a funding rate payment (because in crypto, long traders pay short traders when the market is in contango). The position is delta-neutral — if ETH price goes up or down, the spot and short cancel each other out. The only profit comes from the two yield streams: lending income and funding income. The question the project answers is: is that combined yield enough to beat the costs?

### The Arbitrage Condition
```
Net daily yield = (lending_APY / 365) + daily_funding_rate_bps/10000 - daily_cost

Trade is ON  when: lending_APY + annualized_funding > execution_costs
Trade is OFF when: funding turns negative (backwardation) and erodes the lending yield
```

### Cash Flow Diagram
```
User deposits USDC
        │
        ▼
LendingVault.sol  ──── issues aUSDC (yield-bearing receipt) ──── earns lending APY %
        │
        ▼ (aUSDC used as margin)
PerpHedge.sol  ─────── short ETH perpetual ─────────────────── earns funding rate (if contango)
        │
        ▼
ArbitrageStrategy.sol (orchestrator)
        │
        ├── tracks: lending income (separate)
        ├── tracks: funding income (separate)
        ├── tracks: price hedge P&L (should be ~0, delta neutral)
        ├── tracks: margin ratio (liquidation health)
        └── exposes: isArbitrageViable(lendingAPY, fundingRate, costs) → bool
```

### Why Two Separate Yield Streams Matter
The SAME capital does two jobs simultaneously:
- Job 1: Sits in LendingVault → someone else is borrowing it → you earn interest
- Job 2: Backs a perpetual short → long traders pay you funding every 8 hours (in contango)

Neither yield requires price direction. Combined = market-neutral return. That is the arbitrage.

### Key Financial Formulas
```
Lending Income     = principal × lendingAPY × (days / 365)
Daily Funding      = notional × (dailyFundingRateBps / 10000)
Short Price P&L    = notional × (entryPrice - currentPrice) / entryPrice
Margin Ratio       = (collateral + short P&L + cumulative funding) / notional
Health Factor      = marginRatio / maintenanceMargin   (>1 = safe, <1 = liquidatable)
Net Arbitrage P&L  = lendingIncome + cumulativeFunding + priceP&L - fees - gas - slippage
```

### What "Delta Neutral" Means Here
```
If ETH goes up $200:   short loses $200, spot gains $200 → net $0
If ETH goes down $200: short gains $200, spot loses $200 → net $0
Price direction is irrelevant. Only the yield spread matters.
```

---

## 5. What We Are NOT Building

**Do NOT build any of these — they are distractions:**
- A governance token with voting rights and a treasury
- A DeFi "vault product" for passive retail investors
- A React frontend as the main deliverable (simple frontend is fine, but it is not the focus)
- A real Aave or real dYdX integration (mock contracts are correct for a class project)
- A live trading bot
- A real historical backtest using Binance API data (scenario simulation with assumed data is correct)
- Anything called "Delta-Neutral Vault" — that was the old project we are NOT using

---

## 6. Exact Repository Structure to Build

```
crypto-arbitrage-lending-perp/
├── contracts/
│   ├── token/
│   │   └── ArbitrageToken.sol          ← ERC20, symbol: CARB, name: "Crypto Arbitrage Token"
│   ├── core/
│   │   ├── LendingVault.sol            ← Mock Aave: deposit USDC → mint aUSDC → accrue interest
│   │   ├── PerpHedge.sol               ← Mock perp exchange: open/close short, accrue funding
│   │   └── ArbitrageStrategy.sol       ← Orchestrator: ties both together, exposes P&L + viability
│   ├── oracle/
│   │   └── PriceOracle.sol             ← Chainlink ETH/USD wrapper (Sepolia feed)
│   ├── libraries/
│   │   └── ArbitrageMath.sol           ← Pure math: P&L, margin, break-even, health factor
│   └── interfaces/
│       ├── ILendingVault.sol
│       └── IPerpHedge.sol
├── test/
│   ├── ArbitrageToken.test.ts
│   ├── LendingVault.test.ts
│   ├── PerpHedge.test.ts
│   ├── ArbitrageStrategy.test.ts
│   └── Integration.test.ts             ← Full lifecycle: deposit → lend → short → earn → close
├── scripts/
│   ├── deploy-local.ts
│   └── deploy-sepolia.ts
├── simulation/
│   ├── arbitrage_analysis.py           ← Core: 4 scenarios, daily P&L decomposition
│   ├── metrics.py                      ← Sharpe ratio, max drawdown, break-even analysis
│   ├── plots.py                        ← Charts for the report
│   └── requirements.txt
├── excel/                              ← Auto-generated CSVs (from Python simulation)
├── screenshots/                        ← Etherscan, terminal, frontend screenshots
├── report/
│   └── final_report.md                 ← Written submission
├── hardhat.config.ts
├── package.json
└── .env.example
```

---

## 7. Contract Specifications

### ArbitrageToken.sol
- Standard OpenZeppelin ERC20
- Name: "Crypto Arbitrage Token", Symbol: CARB
- Max supply: 10,000,000 (10 million)
- Functions: mint (owner only), burn (holder)
- Purpose: satisfies the "deploy an ERC20" course requirement
- Optional: holders get fee discounts in ArbitrageStrategy (nice to have, not required)

### LendingVault.sol
- Accepts USDC (6 decimals)
- Mints aUSDC (18 decimals) as yield-bearing receipt — 1 USDC = 1 aUSDC at deposit
- Interest accrues continuously using block.timestamp
- Interest formula: `principal × lendingAPY × elapsed / (365 days)`
- lendingAPY is configurable by owner (default: 500 bps = 5%)
- Key functions:
  - `deposit(uint256 usdcAmount)` → mints aUSDC
  - `redeem(uint256 aUsdcAmount)` → burns aUSDC, returns USDC + interest
  - `getAccruedInterest(address user)` → view
  - `getATokenBalance(address user)` → view
- Security: ReentrancyGuard, SafeERC20

### PerpHedge.sol
- Accepts USDC or aUSDC as margin (keep it simple: just USDC for now)
- Tracks per-user short positions
- Funding accrues pro-rated by elapsed seconds: `notional × dailyFundingRateBps × elapsed / (10000 × 86400)`
- dailyFundingRateBps is signed (int256) — can be negative for backwardation
- Key functions:
  - `openShort(uint256 notionalSize, uint256 collateral)` → opens position
  - `closeShort()` → returns collateral + price P&L + cumulative funding
  - `accrueFunding()` → manually checkpoint funding
  - `getUnrealizedPnL(address user)` → view: price P&L + accrued funding
  - `getMarginRatio(address user)` → view: in basis points
  - `isLiquidatable(address user)` → view: bool
- Default params: dailyFundingRateBps = 3 (0.03%/day), maintenanceMargin = 500 bps (5%)
- Security: ReentrancyGuard

### ArbitrageStrategy.sol (THE CENTERPIECE)
This is the main contract that ties everything together.
```
Key functions:

openArbitragePosition(uint256 usdcAmount, uint256 hedgeNotional)
  1. Transfer USDC from user
  2. Deposit into LendingVault → receive aUSDC
  3. Open short on PerpHedge with same collateral amount
  4. Record: entryTimestamp, entryPrice (from oracle), collateral, notional
  5. Emit: ArbitrageOpened(user, collateral, notional, entryPrice, timestamp)

getArbitragePnL(address user) view returns:
  - lendingIncome     (uint256): from LendingVault.getAccruedInterest()
  - fundingIncome     (int256):  from PerpHedge cumulative funding
  - priceHedgePnL     (int256):  from PerpHedge unrealized P&L (should be ~0)
  - grossPnL          (int256):  sum of above
  - estimatedCosts    (uint256): gas + slippage estimate
  - netArbitragePnL   (int256):  grossPnL - estimatedCosts
  - marginRatio       (uint256): from PerpHedge.getMarginRatio()
  - isHealthy         (bool):    marginRatio > maintenanceMargin

isArbitrageViable(uint256 lendingAPYBps, int256 fundingRateBps, uint256 costBps)
  pure returns (bool viable, uint256 netAPRBps, uint256 breakEvenDays)
  → This is the ANALYTICAL CORE. Given rates, is the trade worth putting on?
  → netAPRBps = lendingAPYBps + (fundingRateBps × 365) - costBps
  → viable = netAPRBps > 0
  → breakEvenDays = (entryCost / dailyNetYield) if viable

closeArbitragePosition()
  1. Close short on PerpHedge → get back collateral + funding + price P&L
  2. Redeem aUSDC from LendingVault → get back USDC + interest
  3. Send total to user
  4. Emit: ArbitrageClosed(user, lendingIncome, fundingIncome, priceHedgePnL, netPnL)
```

### PriceOracle.sol
- Wraps Chainlink AggregatorV3Interface
- Sepolia ETH/USD feed: 0x694AA1769357215DE4FAC081bf1f309aDC325306
- Normalizes to 18 decimals
- Staleness check: rejects data older than 1 hour
- Functions: getLatestPrice(), setStalenessThreshold(uint256)

### ArbitrageMath.sol (library)
Pure math functions:
- `calcShortPnL(notional, entryPrice, currentPrice)` → int256
- `calcMarginRatio(collateral, unrealizedPnL, notional)` → uint256 bps
- `calcHealthFactor(marginRatio, maintenanceMarginBps)` → uint256
- `calcLendingIncome(principal, apyBps, elapsedSeconds)` → uint256
- `calcFundingPayment(notional, dailyRateBps, elapsedSeconds)` → int256
- `calcBreakEvenDays(entryCostUSD, dailyNetYield)` → uint256
- `isViable(lendingAPYBps, fundingRateBps, costBps)` → bool

---

## 8. Python Simulation Specifications

### Purpose
Off-chain quantitative analysis. NOT a real backtest. A scenario analysis with assumed parameters.
Answers: "Under what conditions is this arbitrage profitable? By how much? What are the risks?"

### Timeframe
180 days (6 months). Daily granularity. 4 scenarios.

### 4 Scenarios

| Scenario       | ETH Price Path       | Funding Rate      | Lending APY | Key Question                        |
|----------------|----------------------|-------------------|-------------|-------------------------------------|
| Base Case      | Flat at $2,000       | +3 bps/day        | 5%          | Does base case generate profit?     |
| High Funding   | Flat at $2,000       | +6 bps/day        | 5%          | Bull market — how much better?      |
| Backwardation  | -20% to $1,600       | -2 bps/day        | 3%          | Bear market — does trade go negative? |
| GBM Random     | Stochastic (σ=60%)   | 0–5 bps noisy     | 5%          | Realistic volatility scenario        |

### Output Metrics Per Scenario
- Daily P&L decomposed: lending income, funding income, price hedge P&L (≈0), net
- Cumulative P&L
- Sharpe ratio (annualized)
- Max drawdown
- Break-even funding rate (at what funding rate does the trade turn unprofitable?)
- Margin ratio over time
- Days at risk of liquidation (if any)
- Annualized net return %

### CSV Files to Generate (for Excel submission)
```
positions_base_case.csv          ← daily P&L rows, all columns
positions_high_funding.csv
positions_backwardation.csv
positions_gbm_random.csv
scenario_summary.csv             ← 1 row per scenario, all key metrics
break_even_analysis.csv          ← grid: funding rate vs lending APY vs net APR
margin_health.csv                ← margin ratio and health factor over time
assumptions.csv                  ← all parameters used
```

### Charts to Generate (for report)
1. Cumulative P&L by scenario (line chart, 4 lines)
2. Daily P&L decomposition for base case (stacked bar: lending vs funding vs price)
3. Margin ratio over time (all 4 scenarios)
4. Break-even heatmap (x=lending APY, y=funding rate, color=net APR)
5. Sharpe ratio comparison (bar chart by scenario)

---

## 9. Deployment Plan

### Local (Hardhat node)
- MockUSDC (6 decimals, mintable)
- ArbitrageToken (CARB)
- MockOracle (hardcoded ETH price = $2000, updatable)
- LendingVault
- PerpHedge
- ArbitrageStrategy
- Mint 10,000 USDC to deployer for testing

### Sepolia Testnet
- Use real Chainlink oracle (0x694AA1769357215DE4FAC081bf1f309aDC325306)
- Use real MockUSDC deployed on Sepolia (or deploy our own)
- Verify all contracts on Etherscan
- Take screenshots of every transaction

### What to Screenshot for Submission
- [ ] CARB token on Etherscan (verified)
- [ ] ArbitrageStrategy.sol on Etherscan (verified)
- [ ] LendingVault.sol on Etherscan (verified)
- [ ] PerpHedge.sol on Etherscan (verified)
- [ ] Terminal: openArbitragePosition() transaction hash
- [ ] Terminal: getArbitragePnL() output
- [ ] Terminal: isArbitrageViable() output
- [ ] Terminal: closeArbitragePosition() transaction hash
- [ ] Frontend (if built): position dashboard showing live P&L

---

## 10. Frontend (Nice to Have, Not Primary Focus)

Simple React or plain HTML/JS page with:
- Connect MetaMask button
- Input: deposit amount + hedge notional
- Button: Open Arbitrage Position
- Display: live P&L (lending income, funding income, net), margin ratio
- Button: Close Position
- Chainlink oracle price displayed live

This earns the "frontend with navigation" advanced functionality point.
If short on time, a Hardhat script that prints all values to terminal is acceptable.

---

## 11. Report Structure

```
Title: Design and Analysis of an Arbitrage Strategy Using
       Crypto Lending and Perpetual Futures Hedging

1. Introduction (1 page)
   - What is the arbitrage opportunity?
   - Why does it exist in crypto markets?
   - Project objective and scope

2. Strategy Mechanics (1–2 pages)
   - The trade: lend USDC + short perp = delta-neutral yield
   - The arbitrage condition: L + F > costs
   - Why funding rates are structurally positive in crypto (contango bias)
   - Cash flow diagram

3. Mathematical Model (1 page)
   - All formulas (P&L, margin ratio, health factor, break-even)
   - Worked numerical example

4. Quantitative Analysis Results (2–3 pages)
   - 4 scenario results with all plots
   - Sharpe ratio table
   - Break-even analysis
   - Conclusion: under what conditions is this trade viable?

5. Smart Contract Implementation (1–2 pages)
   - Architecture diagram
   - Key functions described (especially isArbitrageViable)
   - Chainlink oracle usage
   - Security measures

6. Deployment and Verification (1 page)
   - Sepolia contract addresses
   - Etherscan screenshots
   - CARB token details
   - Gas costs measured

7. Conclusion (0.5 page)
   - Summary of findings
   - Limitations (mock exchange, static funding, no real Aave)
   - What would be needed for real production use
   - What we learned

Appendix:
   - Full CSV data
   - Complete Solidity source code
   - Assumptions table
   - References
```

---

## 12. 3-Day Build Plan (3 Team Members)

### Day 1 — All Contracts Written and Tested Locally
- Person 1: ArbitrageToken.sol, LendingVault.sol (+ tests)
- Person 2: PerpHedge.sol, ArbitrageMath.sol (+ tests)
- Person 3: ArbitrageStrategy.sol, PriceOracle.sol, deploy-local.ts (+ integration test)

### Day 2 — Deploy, Verify, Simulate
- Person 1: Deploy to Sepolia, verify on Etherscan, take all screenshots
- Person 2: Frontend (simple dashboard)
- Person 3: Python simulation — all 4 scenarios, generate all CSVs and charts

### Day 3 — Report + Final Polish
- All 3: Write report sections, assemble submission, final QA

---

## 13. Technology Stack

- Solidity ^0.8.24
- Hardhat + TypeScript
- OpenZeppelin Contracts (ERC20, Ownable, ReentrancyGuard, SafeERC20)
- Chainlink (AggregatorV3Interface — oracle only)
- Ethers.js v6
- Mocha + Chai (tests)
- Python 3.10+ (simulation: pandas, numpy, matplotlib, scipy)
- React + Vite (optional frontend)
- Sepolia testnet
- Etherscan for verification

### .env variables needed
```
PRIVATE_KEY=
SEPOLIA_RPC_URL=
ETHERSCAN_API_KEY=
```

---

## 14. Key Design Decisions Already Made (Do Not Revisit)

1. **Structure A is correct**: USDC → LendingVault (aUSDC) → margin for PerpHedge short
   (NOT: borrow ETH → sell → long perp. That is Structure B and is wrong for this project.)

2. **Mock contracts only**: No real Aave, no real dYdX. Mocks simulate the mechanics correctly.
   This is appropriate for a 3-day class project.

3. **ERC20 token is CARB** (Crypto Arbitrage Token), NOT a governance token.
   It is a simple ERC20 satisfying the course requirement. Do not add governance/treasury/voting.

4. **Simulation is scenario analysis**, NOT a real backtest with historical data.
   Assumed parameters are explicitly stated in assumptions.csv.

5. **The report leads with arbitrage reasoning**, not vault product features.
   The smart contract is the proof-of-concept. The analysis is the substance.

6. **No governance token, no treasury, no fee structure complexity.**
   These are distractions for a class project.

---

## 15. Clarifying Questions for Claude to Ask Before Starting

If anything below is still unclear, Claude should ask before writing any code:

- [ ] Do you want aUSDC as a real ERC20 token minted by LendingVault, or just an internal accounting balance?
- [ ] Should PerpHedge accept USDC directly as margin, or aUSDC from LendingVault?
- [ ] Do you want a simple HTML frontend or a React frontend?
- [ ] Is MockUSDC needed (for local testing), or will you use a Sepolia USDC faucet?
- [ ] Do you want gas optimization as a priority, or is correctness/clarity more important for grading?
- [ ] Do you want the Python simulation to use real Binance funding rate data (requires API call) or purely assumed parameters?
- [ ] Do you have a Sepolia RPC URL and Etherscan API key ready?
- [ ] Who is building which part (Person 1, 2, 3)?

---

## 16. What This Project Signals on a Resume

When describing this on a resume for quant trading / quant research roles:

> "Designed and implemented a delta-neutral funding rate arbitrage strategy in Solidity.
> Strategy simultaneously earns crypto lending yield and perpetual futures funding income
> with zero directional price exposure. Built Python quantitative simulation across 4 market
> scenarios — including contango, backwardation, and GBM stochastic paths — computing
> Sharpe ratio, max drawdown, and break-even funding rate thresholds. Deployed 5 verified
> smart contracts on Ethereum Sepolia including Chainlink oracle integration."

This signals: arbitrage thinking, hedging logic, understanding of perpetuals/funding,
margin/collateral awareness, quantitative analysis skills, on-chain implementation.

---

## 17. Final Note

This is a 3-day student project. The goal is:
1. A coherent, well-argued arbitrage study (professor is happy)
2. Working smart contracts on Sepolia with Etherscan verification (rubric is satisfied)
3. Clean quantitative analysis with plots and Excel (rubric is satisfied)
4. Something that reads well on a quant finance resume (career goal is served)

It is NOT meant to be a production protocol. Mocks are fine. Simplicity is good.
The smartest version of this project is the simplest version that clearly answers:
"Does this arbitrage work, and when?"
