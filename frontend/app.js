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

const LOCAL_EXPLORER = "http://127.0.0.1:8545";
const SEPOLIA_EXPLORER = "https://sepolia.etherscan.io";
const ABI_PATHS = {
  MockUSDC: "./contracts/MockUSDC.json",
  ArbitrageToken: "./contracts/ArbitrageToken.json",
  StrategyVault: "./contracts/StrategyVault.json",
  MockPerpEngine: "./contracts/MockPerpEngine.json",
  MockPriceOracle: "./contracts/MockPriceOracle.json",
  ChainlinkPriceOracle: "./contracts/ChainlinkPriceOracle.json",
};

// ─── Globals ──────────────────────────────────────────────────────────────────
let provider = null;
let signer   = null;
let vault    = null;
let usdc     = null;
let oracle   = null;
let contractsConfig = null;
let explorerBaseUrl = LOCAL_EXPLORER;

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
  try {
    await initContracts();
    await refreshAll();
  } catch (e) {
    console.error(e);
    logTx(`Setup error: ${e.message}`);
    alert(e.message);
  }
}

async function initContracts() {
  const addresses = await loadAddresses();
  const network = await provider.getNetwork();
  explorerBaseUrl = network.chainId === 11155111n ? SEPOLIA_EXPLORER : LOCAL_EXPLORER;

  const [
    vaultArtifact,
    usdcArtifact,
    oracleArtifact,
    engineArtifact,
    tokenArtifact,
  ] = await Promise.all([
    loadArtifact(ABI_PATHS.StrategyVault),
    loadArtifact(ABI_PATHS.MockUSDC),
    loadArtifact(
      network.chainId === 11155111n
        ? ABI_PATHS.ChainlinkPriceOracle
        : ABI_PATHS.MockPriceOracle
    ),
    loadArtifact(ABI_PATHS.MockPerpEngine),
    loadArtifact(ABI_PATHS.ArbitrageToken),
  ]);

  contractsConfig = {
    MockUSDC: { address: addresses.MockUSDC, abi: usdcArtifact.abi },
    ArbitrageToken: { address: addresses.ArbitrageToken, abi: tokenArtifact.abi },
    StrategyVault: { address: addresses.StrategyVault, abi: vaultArtifact.abi },
    MockPerpEngine: { address: addresses.MockPerpEngine, abi: engineArtifact.abi },
    PriceOracle: {
      address: network.chainId === 11155111n
        ? addresses.ChainlinkPriceOracle
        : addresses.MockPriceOracle,
      abi: oracleArtifact.abi,
    },
  };

  vault  = new ethers.Contract(contractsConfig.StrategyVault.address, contractsConfig.StrategyVault.abi, signer);
  usdc   = new ethers.Contract(contractsConfig.MockUSDC.address, contractsConfig.MockUSDC.abi, signer);
  oracle = new ethers.Contract(contractsConfig.PriceOracle.address, contractsConfig.PriceOracle.abi, provider);
}

async function loadAddresses() {
  const network = await provider.getNetwork();
  if (network.chainId === 11155111n) {
    return {
      MockUSDC:             "0x84EAb608016e21E4618c63B01F7b3b043F4f457e",
      ArbitrageToken:       "0xd2E7bA891e0Ecd142695d04e8Ed79e0C4947922F",
      ChainlinkPriceOracle: "0x27768a80Fb849F6c1bB941C8de62F417Cd968e35",
      MockPerpEngine:       "0x478832D03495390E47aFD238A9bA11414096A452",
      StrategyVault:        "0x036EA2E331994a04d853B54Ad19D05524eC5b399"
    };
  }
  // local hardhat
  const response = await fetch("./contracts/addresses.local.json");
  if (!response.ok) {
    throw new Error(
      `Could not load addresses file. Deploy locally first and generate addresses.local.json.`
    );
  }
  return response.json();
}

async function loadArtifact(path) {
  const response = await fetch(path);
  if (!response.ok) {
    throw new Error(`Could not load ABI file: ${path}`);
  }
  return response.json();
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
      contractsConfig.StrategyVault.address,
      ethers.MaxUint256
    );
    logTx(`Approving USDC... <a href="${explorerBaseUrl}/tx/${tx.hash}" target="_blank">${tx.hash.slice(0,12)}…</a>`);
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
    logTx(`Depositing $${amountStr} USDC... <a href="${explorerBaseUrl}/tx/${tx.hash}" target="_blank">${tx.hash.slice(0,12)}…</a>`);
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
    logTx(`Withdrawing... <a href="${explorerBaseUrl}/tx/${tx.hash}" target="_blank">${tx.hash.slice(0,12)}…</a>`);
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
    logTx(`Opening hedge... <a href="${explorerBaseUrl}/tx/${tx.hash}" target="_blank">${tx.hash.slice(0,12)}…</a>`);
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
    logTx(`Closing hedge... <a href="${explorerBaseUrl}/tx/${tx.hash}" target="_blank">${tx.hash.slice(0,12)}…</a>`);
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
  if (!contractsConfig) {
    return;
  }
  for (const [name, { address }] of Object.entries(contractsConfig)) {
    const row = document.createElement("tr");
    row.innerHTML = `
      <td>${name}</td>
      <td style="font-family:monospace;font-size:0.78rem">${address}</td>
      <td><a href="${explorerBaseUrl}/address/${address}" target="_blank">View ↗</a></td>
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
