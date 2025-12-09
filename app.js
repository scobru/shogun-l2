// Shogun Protocol - L2 Bridge App
// Uses Shogun Contracts SDK for contract interactions
// Uses Shogun Relay SDK for relay API interactions

import { ShogunSDK } from 'shogun-contracts-sdk';
import ShogunRelaySDK from 'shogun-relay-sdk';

// Contract addresses and RPC endpoints
// Base Sepolia (chainId: 84532)
const CONTRACTS = {
  84532: {
    name: 'Base Sepolia',
    gunL2Bridge: '0x429E4559e154E9F9fb86A9587769E99F65aFc1dE',
    rpc: 'https://sepolia.base.org',
    explorer: 'https://sepolia.basescan.org',
  },
};

// Default relay endpoint (can be changed by user)
const DEFAULT_RELAY_ENDPOINT = 'http://localhost:8765';

// State
let provider = null;
let signer = null;
let connectedAddress = null;
let currentChainId = 84532; // Base Sepolia
let sdk = null; // ShogunSDK instance
let gunL2Bridge = null; // GunL2Bridge instance from SDK
let relaySDK = null; // ShogunRelaySDK instance
let currentRelayEndpoint = DEFAULT_RELAY_ENDPOINT;
let shogunCore = null; // ShogunCore instance for key derivation
let gunKeypair = null; // GunDB keypair for encryption (derived from wallet signature)

// ============================================
// UTILITY FUNCTIONS
// ============================================

/**
 * Initialize or get relay SDK instance for a given endpoint
 */
function getRelaySDK(endpoint) {
  if (!endpoint) {
    throw new Error('Relay endpoint is required');
  }
  
  if (relaySDK && currentRelayEndpoint === endpoint) {
    return relaySDK;
  }
  
  relaySDK = new ShogunRelaySDK({
    baseURL: endpoint,
    timeout: 30000,
  });
  currentRelayEndpoint = endpoint;
  
  return relaySDK;
}

/**
 * Show message to user
 */
function showMessage(type, message) {
  const messageEl = document.getElementById('message');
  if (!messageEl) return;
  
  messageEl.className = `message ${type}`;
  messageEl.textContent = message;
  messageEl.style.display = 'block';
  
  setTimeout(() => {
    messageEl.style.display = 'none';
  }, 5000);
}

/**
 * Show loading state on a button
 */
function setButtonLoading(buttonId, loadingText = 'Loading...') {
  const btn = document.getElementById(buttonId);
  if (!btn) return () => {};
  
  const originalHTML = btn.innerHTML;
  const originalDisabled = btn.disabled;
  
  btn.disabled = true;
  btn.innerHTML = `<span class="loading-spinner mr-2"></span>${loadingText}`;
  
  return () => {
    btn.disabled = originalDisabled;
    btn.innerHTML = originalHTML;
  };
}

/**
 * Format ETH amount
 */
function formatEth(wei) {
  return ethers.formatEther(wei);
}

/**
 * Truncate address
 */
function truncateAddress(address) {
  if (!address) return 'N/A';
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

/**
 * Derive GunDB keypair from wallet signature
 */
async function deriveGunKeypair() {
  if (!connectedAddress || !signer) {
    console.warn('Cannot derive keypair: wallet not connected');
    return;
  }

  try {
    if (!window.ShogunCore) {
      throw new Error('ShogunCore not loaded');
    }

    if (!shogunCore) {
      const gunInstance = window.Gun({
        peers: [],
        localStorage: false,
      });

      shogunCore = new window.ShogunCore.ShogunCore({
        gunInstance: gunInstance,
        web3: { enabled: true },
      });

      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    const web3Plugin = shogunCore.getPlugin('web3');
    if (!web3Plugin) {
      throw new Error('Web3 plugin not available');
    }

    const connectionResult = await web3Plugin.connectMetaMask();
    if (!connectionResult.success || !connectionResult.address) {
      throw new Error('Failed to connect MetaMask through ShogunCore');
    }

    const credentials = await web3Plugin.generateCredentials(connectedAddress);
    
    gunKeypair = {
      pub: credentials.pub,
      priv: credentials.priv,
      epub: credentials.epub,
      epriv: credentials.epriv,
    };
    
    console.log('✅ GunDB keypair derived successfully');
  } catch (error) {
    console.error('Failed to derive GunDB keypair:', error);
    showMessage('error', `Failed to derive keypair: ${error.message}`);
  }
}

/**
 * Create dual signatures (SEA + Ethereum) for a message
 */
async function createDualSignatures(message) {
  if (!gunKeypair || !signer) {
    throw new Error('GunDB keypair and signer required for dual signatures');
  }

  // 1. Create SEA signature (GunDB)
  const seaSignature = await window.Gun.SEA.sign(message, gunKeypair);
  
  // 2. Create Ethereum signature (EIP-191)
  const ethSignature = await signer.signMessage(message);
  
  return {
    seaSignature,
    ethSignature,
    gunPubKey: gunKeypair.pub,
  };
}

// ============================================
// INITIALIZATION
// ============================================

/**
 * Initialize network configuration
 */
async function loadNetworkConfig() {
  // Force Base Sepolia
  currentChainId = 84532;
  const config = CONTRACTS[currentChainId];
  if (!config || !config.gunL2Bridge) {
    showMessage('error', `GunL2Bridge not deployed on Base Sepolia`);
    return;
  }

  // Use BrowserProvider if wallet is connected, otherwise JsonRpcProvider
  if (window.ethereum && !provider) {
    provider = new ethers.BrowserProvider(window.ethereum);
  } else if (!provider) {
    provider = new ethers.JsonRpcProvider(config.rpc);
  }
  
  try {
    sdk = new ShogunSDK({
      provider,
      signer: signer || undefined,
      chainId: currentChainId
    });
    
    gunL2Bridge = sdk.getGunL2Bridge();
    
    if (signer && provider instanceof ethers.BrowserProvider) {
      // Update signer if using BrowserProvider
      signer = await provider.getSigner();
      if (sdk) {
        sdk.setSigner(signer);
        gunL2Bridge = sdk.getGunL2Bridge();
      }
    }
  } catch (error) {
    console.error('Failed to initialize SDK:', error);
    showMessage('error', `Failed to initialize SDK: ${error.message}`);
    return;
  }
  
  // Initialize relay SDK
  getRelaySDK(currentRelayEndpoint);
  
  await updateBalances();
}

/**
 * Update all balances
 */
async function updateBalances() {
  if (!connectedAddress) return;
  
  try {
    // L1 Balance
    if (provider) {
      const l1Balance = await provider.getBalance(connectedAddress);
      document.getElementById('l1Balance').textContent = `${formatEth(l1Balance)} ETH`;
    }
    
    // L2 Balance
    const relay = getRelaySDK(currentRelayEndpoint);
    const balanceResult = await relay.bridge.getBalance(connectedAddress);
    if (balanceResult.success) {
      document.getElementById('l2Balance').textContent = `${balanceResult.balanceEth} ETH`;
    }
    
    // Bridge Contract Balance
    if (gunL2Bridge) {
      const bridgeBalance = await gunL2Bridge.getBalance();
      document.getElementById('bridgeBalance').textContent = `${formatEth(bridgeBalance)} ETH`;
    }
  } catch (error) {
    console.error('Failed to update balances:', error);
  }
}

// ============================================
// WALLET CONNECTION
// ============================================

document.getElementById('connectWallet').addEventListener('click', connectWallet);

async function connectWallet() {
  if (!window.ethereum) {
    showMessage('error', 'MetaMask not detected. Please install MetaMask.');
    return;
  }

  try {
    const restoreButton = setButtonLoading('connectWallet', 'Connecting...');
    
    // Initialize provider with BrowserProvider for wallet connection
    if (!provider || !(provider instanceof ethers.BrowserProvider)) {
      provider = new ethers.BrowserProvider(window.ethereum);
    }
    
    // Request account access
    const accounts = await window.ethereum.request({ method: 'eth_requestAccounts' });
    if (accounts.length === 0) {
      throw new Error('No accounts found');
    }

    connectedAddress = accounts[0];
    signer = await provider.getSigner();
    
    if (sdk) {
      sdk.setSigner(signer);
      gunL2Bridge = sdk.getGunL2Bridge();
    }

    // Update SDK with signer
    if (sdk) {
      sdk.setSigner(signer);
      gunL2Bridge = sdk.getGunL2Bridge();
    }

    // Update UI
    document.getElementById('walletAddress').textContent = truncateAddress(connectedAddress);
    document.getElementById('connectWallet').textContent = 'Connected';
    document.getElementById('connectWallet').disabled = true;

    // Derive GunDB keypair
    await deriveGunKeypair();
    
    // Update balances
    await updateBalances();
    
    restoreButton();
    showMessage('success', 'Wallet connected successfully');
  } catch (error) {
    console.error('Failed to connect wallet:', error);
    showMessage('error', `Failed to connect wallet: ${error.message}`);
  }
}

// ============================================
// TAB MANAGEMENT
// ============================================

document.querySelectorAll('.tab-button').forEach(btn => {
  btn.addEventListener('click', () => {
    const tabName = btn.dataset.tab;
    
    // Update button states
    document.querySelectorAll('.tab-button').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    
    // Show/hide tab content
    document.querySelectorAll('.tab-content').forEach(content => {
      content.classList.add('hidden');
    });
    document.getElementById(`tab-${tabName}`).classList.remove('hidden');
  });
});

// ============================================
// DEPOSIT (L1 → L2)
// ============================================

document.getElementById('depositBtn').addEventListener('click', handleDeposit);

async function handleDeposit() {
  if (!connectedAddress || !gunL2Bridge) {
    showMessage('error', 'Please connect wallet first');
    return;
  }

  try {
    const amountInput = document.getElementById('depositAmount');
    const amountEth = parseFloat(amountInput.value);
    
    if (!amountEth || amountEth <= 0) {
      showMessage('error', 'Please enter a valid amount');
      return;
    }

    const restoreButton = setButtonLoading('depositBtn', 'Depositing...');
    const amountWei = ethers.parseEther(amountEth.toString());
    
    // Check L1 balance
    const l1Balance = await provider.getBalance(connectedAddress);
    if (l1Balance < amountWei) {
      restoreButton();
      showMessage('error', 'Insufficient L1 balance');
      return;
    }

    // Deposit to bridge contract
    const tx = await gunL2Bridge.deposit(amountWei);
    showMessage('info', `Transaction sent: ${tx.hash}. Waiting for confirmation...`);
    
    const receipt = await tx.wait();
    
    restoreButton();
    showMessage('success', `Deposit successful! TX: ${receipt.hash}`);
    
    // Clear input
    amountInput.value = '';
    
    // Update balances after a delay (wait for event listener to process)
    setTimeout(() => {
      updateBalances();
    }, 5000);
  } catch (error) {
    console.error('Deposit failed:', error);
    showMessage('error', `Deposit failed: ${error.message}`);
  }
}

// ============================================
// WITHDRAW (L2 → L1)
// ============================================

let currentWithdrawalNonce = null;

document.getElementById('requestWithdrawBtn').addEventListener('click', handleRequestWithdraw);
document.getElementById('checkProofBtn').addEventListener('click', handleCheckProofAndWithdraw);

async function handleRequestWithdraw() {
  if (!connectedAddress || !gunKeypair) {
    showMessage('error', 'Please connect wallet and ensure keypair is derived');
    return;
  }

  try {
    const amountInput = document.getElementById('withdrawAmount');
    const nonceInput = document.getElementById('withdrawNonce');
    
    const amountEth = parseFloat(amountInput.value);
    const nonce = BigInt(nonceInput.value || Date.now().toString());
    
    if (!amountEth || amountEth <= 0) {
      showMessage('error', 'Please enter a valid amount');
      return;
    }

    const restoreButton = setButtonLoading('requestWithdrawBtn', 'Requesting...');
    const amountWei = ethers.parseEther(amountEth.toString());
    
    // Check L2 balance
    const relay = getRelaySDK(currentRelayEndpoint);
    const balanceResult = await relay.bridge.getBalance(connectedAddress);
    if (!balanceResult.success || BigInt(balanceResult.balance) < amountWei) {
      restoreButton();
      showMessage('error', 'Insufficient L2 balance');
      return;
    }

    // Create message for dual signatures
    const message = JSON.stringify({
      ethereumAddress: connectedAddress.toLowerCase(),
      amount: amountWei.toString(),
      nonce: nonce.toString(),
      timestamp: Date.now(),
      type: 'withdrawal',
    });

    // Create dual signatures
    const { seaSignature, ethSignature, gunPubKey } = await createDualSignatures(message);

    // Request withdrawal
    const result = await relay.bridge.withdraw({
      user: connectedAddress,
      amount: amountWei.toString(),
      nonce: nonce.toString(),
      message,
      seaSignature,
      ethSignature,
      gunPubKey,
    });

    if (!result.success) {
      throw new Error(result.error || 'Withdrawal request failed');
    }

    currentWithdrawalNonce = nonce;
    
    restoreButton();
    showMessage('success', 'Withdrawal requested. Waiting for batch submission...');
    
    // Show proof section
    document.getElementById('withdrawProofSection').classList.remove('hidden');
    
    // Clear inputs
    amountInput.value = '';
    nonceInput.value = '';
    
    // Update balances
    await updateBalances();
  } catch (error) {
    console.error('Withdrawal request failed:', error);
    showMessage('error', `Withdrawal request failed: ${error.message}`);
  }
}

async function handleCheckProofAndWithdraw() {
  if (!connectedAddress || !currentWithdrawalNonce) {
    showMessage('error', 'No withdrawal to process');
    return;
  }

  try {
    const restoreButton = setButtonLoading('checkProofBtn', 'Checking...');
    
    const relay = getRelaySDK(currentRelayEndpoint);
    const amountInput = document.getElementById('withdrawAmount');
    const amountWei = ethers.parseEther(amountInput.value || '0');
    
    // Get proof
    const proofResult = await relay.bridge.getProof(
      connectedAddress,
      amountWei.toString(),
      currentWithdrawalNonce.toString()
    );

    if (!proofResult.success || !proofResult.proof) {
      restoreButton();
      showMessage('error', 'Proof not available yet. Please wait for batch submission.');
      return;
    }

    // Withdraw on-chain
    const tx = await gunL2Bridge.withdraw(
      amountWei,
      currentWithdrawalNonce,
      proofResult.proof.proof
    );

    showMessage('info', `Transaction sent: ${tx.hash}. Waiting for confirmation...`);
    
    const receipt = await tx.wait();
    
    restoreButton();
    showMessage('success', `Withdrawal successful! TX: ${receipt.hash}`);
    
    // Hide proof section
    document.getElementById('withdrawProofSection').classList.add('hidden');
    currentWithdrawalNonce = null;
    
    // Update balances
    await updateBalances();
  } catch (error) {
    console.error('Withdrawal failed:', error);
    showMessage('error', `Withdrawal failed: ${error.message}`);
  }
}

// ============================================
// TRANSFER (L2 → L2)
// ============================================

document.getElementById('transferBtn').addEventListener('click', handleTransfer);

async function handleTransfer() {
  if (!connectedAddress || !gunKeypair) {
    showMessage('error', 'Please connect wallet and ensure keypair is derived');
    return;
  }

  try {
    const toInput = document.getElementById('transferTo');
    const amountInput = document.getElementById('transferAmount');
    
    const toAddress = toInput.value.trim();
    const amountEth = parseFloat(amountInput.value);
    
    if (!toAddress || !ethers.isAddress(toAddress)) {
      showMessage('error', 'Please enter a valid recipient address');
      return;
    }
    
    if (!amountEth || amountEth <= 0) {
      showMessage('error', 'Please enter a valid amount');
      return;
    }

    const restoreButton = setButtonLoading('transferBtn', 'Transferring...');
    const amountWei = ethers.parseEther(amountEth.toString());
    
    // Check L2 balance
    const relay = getRelaySDK(currentRelayEndpoint);
    const balanceResult = await relay.bridge.getBalance(connectedAddress);
    if (!balanceResult.success || BigInt(balanceResult.balance) < amountWei) {
      restoreButton();
      showMessage('error', 'Insufficient L2 balance');
      return;
    }

    // Create message for dual signatures
    const message = JSON.stringify({
      ethereumAddress: connectedAddress.toLowerCase(),
      to: ethers.getAddress(toAddress).toLowerCase(),
      amount: amountWei.toString(),
      timestamp: Date.now(),
      type: 'transfer',
    });

    // Create dual signatures
    const { seaSignature, ethSignature, gunPubKey } = await createDualSignatures(message);

    // Transfer
    const result = await relay.bridge.transfer({
      from: connectedAddress,
      to: toAddress,
      amount: amountWei.toString(),
      message,
      seaSignature,
      ethSignature,
      gunPubKey,
    });

    if (!result.success) {
      throw new Error(result.error || 'Transfer failed');
    }

    restoreButton();
    showMessage('success', `Transfer successful! TX: ${result.transfer.txHash}`);
    
    // Clear inputs
    toInput.value = '';
    amountInput.value = '';
    
    // Update balances
    await updateBalances();
  } catch (error) {
    console.error('Transfer failed:', error);
    showMessage('error', `Transfer failed: ${error.message}`);
  }
}

// ============================================
// PENDING WITHDRAWALS
// ============================================

document.getElementById('refreshWithdrawalsBtn').addEventListener('click', loadPendingWithdrawals);

async function loadPendingWithdrawals() {
  if (!connectedAddress) {
    showMessage('error', 'Please connect wallet first');
    return;
  }

  try {
    const restoreButton = setButtonLoading('refreshWithdrawalsBtn', 'Loading...');
    
    const relay = getRelaySDK(currentRelayEndpoint);
    const result = await relay.bridge.getPendingWithdrawals();
    
    restoreButton();
    
    const listEl = document.getElementById('withdrawalsList');
    listEl.innerHTML = '';
    
    if (!result.success || result.withdrawals.length === 0) {
      listEl.innerHTML = '<p class="text-gray-400 text-center py-8">No pending withdrawals</p>';
      return;
    }

    // Filter withdrawals for current user
    const userWithdrawals = result.withdrawals.filter(
      w => w.user.toLowerCase() === connectedAddress.toLowerCase()
    );

    if (userWithdrawals.length === 0) {
      listEl.innerHTML = '<p class="text-gray-400 text-center py-8">No pending withdrawals for your address</p>';
      return;
    }

    // Get bridge state to check if batch is ready
    const stateResult = await relay.bridge.getState();
    const latestBatchId = stateResult.success ? stateResult.state.currentBatchId : null;

    userWithdrawals.forEach(withdrawal => {
      const item = document.createElement('div');
      item.className = 'withdrawal-item pending';
      
      const amountEth = formatEth(BigInt(withdrawal.amount));
      const date = new Date(withdrawal.timestamp).toLocaleString();
      
      item.innerHTML = `
        <div class="flex justify-between items-center">
          <div>
            <p class="text-white font-semibold">${amountEth} ETH</p>
            <p class="text-gray-400 text-sm">Nonce: ${withdrawal.nonce}</p>
            <p class="text-gray-400 text-sm">${date}</p>
          </div>
          <button class="btn btn-sm btn-secondary check-proof-btn" 
                  data-amount="${withdrawal.amount}" 
                  data-nonce="${withdrawal.nonce}">
            Check Proof
          </button>
        </div>
      `;
      
      listEl.appendChild(item);
    });

    // Add event listeners to check proof buttons
    document.querySelectorAll('.check-proof-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const amount = btn.dataset.amount;
        const nonce = btn.dataset.nonce;
        
        try {
          const proofResult = await relay.bridge.getProof(connectedAddress, amount, nonce);
          
          if (proofResult.success && proofResult.proof) {
            // Proof available, can withdraw
            const amountWei = BigInt(amount);
            const nonceBigInt = BigInt(nonce);
            
            const tx = await gunL2Bridge.withdraw(
              amountWei,
              nonceBigInt,
              proofResult.proof.proof
            );
            
            showMessage('info', `Transaction sent: ${tx.hash}`);
            
            const receipt = await tx.wait();
            showMessage('success', `Withdrawal successful! TX: ${receipt.hash}`);
            
            await updateBalances();
            await loadPendingWithdrawals();
          } else {
            showMessage('info', 'Proof not available yet. Please wait for batch submission.');
          }
        } catch (error) {
          console.error('Failed to check proof:', error);
          showMessage('error', `Failed to check proof: ${error.message}`);
        }
      });
    });
  } catch (error) {
    console.error('Failed to load withdrawals:', error);
    showMessage('error', `Failed to load withdrawals: ${error.message}`);
  }
}

// ============================================
// INITIALIZE ON LOAD
// ============================================

document.addEventListener('DOMContentLoaded', async () => {
  await loadNetworkConfig();
  
  // Auto-refresh balances every 30 seconds
  setInterval(() => {
    if (connectedAddress) {
      updateBalances();
    }
  }, 30000);
});

