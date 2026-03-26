/**
 * app.js
 * ──────
 * Minimal frontend for the Crypto Arbitrage Strategy.
 * Uses ethers.js v6 (loaded via CDN in index.html).
 *
 * SETUP:
 *   1. Deploy contracts (scripts/deploy-sepolia.ts or deploy-local.ts).
 *   2. Fill in CONTRACTS addresses below.
 *   3. Copy ABIs from artifacts/ into frontend/contracts/ after compiling.
 *   4. Open index.html in a browser with MetaMask installed.
 */

// ─── Contract Addresses ───────────────────────────────────────────────────────
// TODO: fill these in after deployment

const CONTRACTS = {
  MockUSDC:        { address: "0x...", abi: null },
  ArbitrageToken:  { address: "0x...", abi: null },
  StrategyVault:   { address: "0x...", abi: null },
  MockPerpEngine:  { address: "0x...", abi: null },
  PriceOracle:     { address: "0x...", abi: null },
};

const SEPOLIA_EXPLORER = "https://sepolia.etherscan.io";

// ─── Globals ──────────────────────────────────────────────────────────────────
let provider = null;
let signer   = null;
let vault    = null;
let usdc     = null;
let oracle   = null;

// ─── Wallet ───────────────────────────────────────────────────────────────────

async function connectWallet() {
  if (!window.ethereum) {
    alert("MetaMask not detected. Please install MetaMask.");
    return;
  }

  provider = new ethers.BrowserProvider(window.ethereum);
  await provider.send("eth_requestAccounts", []);
  signer = await provider.getSigner();

  const address = await signer.getAddress();
  document.getElementById("wallet-address").textContent = truncateAddress(address);
  document.getElementById("btn-connect").textContent = "Connected";

  logTx(`Wallet connected: ${address}`);
  await initContracts();
  await refreshAll();
}

async function initContracts() {
  // Load ABIs from frontend/contracts/ directory
  // TODO: copy ABIs here after running `npx hardhat compile`
  // Example (if using a local server):
  //   const vaultAbi  = await fetch("./contracts/StrategyVault.json").then(r => r.json());

  // Placeholder — replace with actual ABI loading
  console.warn("ABIs not loaded. Copy artifacts to frontend/contracts/ and update initContracts().");

  // vault  = new ethers.Contract(CONTRACTS.StrategyVault.address, vaultAbi.abi, signer);
  // usdc   = new ethers.Contract(CONTRACTS.MockUSDC.address,       usdcAbi.abi,  signer);
  // oracle = new ethers.Contract(CONTRACTS.PriceOracle.address,    oracleAbi.abi,provider);
}

// ─── Oracle ───────────────────────────────────────────────────────────────────

async function refreshOracle() {
  if (!oracle) { showNotReady(); return; }
  try {
    const price = await oracle.getPrice();
    document.getElementById("eth-price").textContent =
      `$${(Number(price) / 1e18).toFixed(2)}`;

    const viable = await vault.isCarryViable(3n); // 3 bps/day as example
    document.getElementById("carry-viable").textContent =
      viable ? "✓ Yes" : "✗ No";
    document.getElementById("carry-viable").style.color =
      viable ? "#4CAF50" : "#F44336";
  } catch (e) {
    console.error(e);
  }
}

// ─── Vault ────────────────────────────────────────────────────────────────────

async function refreshVault() {
  if (!vault) { showNotReady(); return; }
  try {
    const state = await vault.getVaultState();

    set("total-deposited",  `$${(Number(state.totalDeposited) / 1e6).toFixed(2)}`);
    set("hedge-open",       state.hedgeIsOpen ? "✓ Yes" : "No");
    set("hedge-collateral", `$${(Number(state.hedgeCollateral) / 1e6).toFixed(2)}`);
    set("carry-score",      `${state.carryScore.toString()} bps`);
    set("margin-ratio",     `${state.marginRatioBps.toString()} bps`);
    set("margin-healthy",   state.marginIsHealthy ? "✓ Healthy" : "⚠ At Risk");

    document.getElementById("margin-healthy").style.color =
      state.marginIsHealthy ? "#4CAF50" : "#F44336";
  } catch (e) {
    console.error("refreshVault error:", e);
  }
}

async function refreshUserValue() {
  if (!vault || !signer) { showNotReady(); return; }
  try {
    const addr  = await signer.getAddress();
    const value = await vault.getUserValue(addr);
    set("user-value", `$${(Number(value) / 1e6).toFixed(4)}`);
  } catch (e) {
    console.error(e);
  }
}

async function refreshAll() {
  await refreshOracle();
  await refreshVault();
  await refreshUserValue();
  populateContractTable();
}

// ─── Deposit / Withdraw ───────────────────────────────────────────────────────

async function approveUSDC() {
  if (!usdc) { showNotReady(); return; }
  try {
    const tx = await usdc.approve(
      CONTRACTS.StrategyVault.address,
      ethers.MaxUint256
    );
    logTx(`Approving USDC... <a href="${SEPOLIA_EXPLORER}/tx/${tx.hash}" target="_blank">${tx.hash.slice(0,12)}…</a>`);
    await tx.wait();
    logTx("USDC approved ✓");
  } catch (e) {
    console.error(e);
    logTx(`Error: ${e.message}`);
  }
}

async function deposit() {
  if (!vault || !usdc) { showNotReady(); return; }
  const amountStr = document.getElementById("deposit-amount").value;
  if (!amountStr || isNaN(amountStr)) { alert("Enter a valid USDC amount."); return; }

  try {
    const amount = BigInt(Math.floor(parseFloat(amountStr) * 1e6));
    const tx = await vault.deposit(amount);
    logTx(`Depositing $${amountStr} USDC... <a href="${SEPOLIA_EXPLORER}/tx/${tx.hash}" target="_blank">${tx.hash.slice(0,12)}…</a>`);
    await tx.wait();
    logTx(`Deposited $${amountStr} USDC ✓`);
    await refreshVault();
    await refreshUserValue();
  } catch (e) {
    console.error(e);
    logTx(`Error: ${e.message}`);
  }
}

async function withdrawAll() {
  if (!vault || !signer) { showNotReady(); return; }
  try {
    const addr = await signer.getAddress();
    const info = await vault.userInfo(addr);
    if (info.shares === 0n) { alert("No shares to withdraw."); return; }

    const tx = await vault.withdraw(info.shares);
    logTx(`Withdrawing... <a href="${SEPOLIA_EXPLORER}/tx/${tx.hash}" target="_blank">${tx.hash.slice(0,12)}…</a>`);
    await tx.wait();
    logTx("Withdrawal complete ✓");
    await refreshVault();
    await refreshUserValue();
  } catch (e) {
    console.error(e);
    logTx(`Error: ${e.message}`);
  }
}

// ─── Hedge (Owner Only) ───────────────────────────────────────────────────────

async function openHedge() {
  if (!vault) { showNotReady(); return; }
  const notional  = BigInt(Math.floor(parseFloat(document.getElementById("hedge-notional").value) * 1e6));
  const collat    = BigInt(Math.floor(parseFloat(document.getElementById("hedge-collateral-input").value) * 1e6));
  const funding   = BigInt(document.getElementById("hedge-funding-rate").value);

  try {
    const tx = await vault.openHedge(notional, collat, funding);
    logTx(`Opening hedge... <a href="${SEPOLIA_EXPLORER}/tx/${tx.hash}" target="_blank">${tx.hash.slice(0,12)}…</a>`);
    await tx.wait();
    logTx("Hedge opened ✓");
    await refreshVault();
  } catch (e) {
    console.error(e);
    logTx(`Error: ${e.reason || e.message}`);
  }
}

async function closeHedge() {
  if (!vault) { showNotReady(); return; }
  try {
    const tx = await vault.closeHedge();
    logTx(`Closing hedge... <a href="${SEPOLIA_EXPLORER}/tx/${tx.hash}" target="_blank">${tx.hash.slice(0,12)}…</a>`);
    await tx.wait();
    logTx("Hedge closed ✓");
    await refreshVault();
  } catch (e) {
    console.error(e);
    logTx(`Error: ${e.reason || e.message}`);
  }
}

// ─── Contract Table ───────────────────────────────────────────────────────────

function populateContractTable() {
  const tbody = document.getElementById("contract-list");
  tbody.innerHTML = "";
  for (const [name, { address }] of Object.entries(CONTRACTS)) {
    const row = document.createElement("tr");
    row.innerHTML = `
      <td>${name}</td>
      <td style="font-family:monospace;font-size:0.78rem">${address}</td>
      <td><a href="${SEPOLIA_EXPLORER}/address/${address}" target="_blank">View ↗</a></td>
    `;
    tbody.appendChild(row);
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function set(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}

function logTx(message) {
  const log = document.getElementById("tx-log");
  const li  = document.createElement("li");
  li.innerHTML = `[${new Date().toLocaleTimeString()}] ${message}`;
  log.prepend(li);
}

function showNotReady() {
  alert("Connect your wallet first.");
}

function truncateAddress(addr) {
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}
