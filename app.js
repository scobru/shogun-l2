// Shogun Protocol - L2 Bridge App
// Uses Shogun Contracts SDK for contract interactions
// Uses Shogun Relay SDK for relay API interactions

import { ShogunSDK, CONTRACTS_CONFIG, getConfigByChainId } from 'shogun-contracts-sdk';
import ShogunRelaySDK from 'shogun-relay-sdk';

// Default relay endpoint (can be changed by user)
const DEFAULT_RELAY_ENDPOINT = 'http://localhost:8765';

// State
let provider = null;
let signer = null;
let connectedAddress = null;
let currentChainId = 84532; // Base Sepolia
let sdk = null; // ShogunSDK instance
let relayRegistry = null; // RelayRegistry instance from SDK
let gunL2Bridge = null; // GunL2Bridge instance from SDK
let relaySDK = null; // ShogunRelaySDK instance
let currentRelayEndpoint = DEFAULT_RELAY_ENDPOINT;
let availableRelays = []; // List of available relays from registry
let selectedRelayAddress = null; // Currently selected relay address
let shogunCore = null; // ShogunCore instance for key derivation
let gunKeypair = null; // GunDB keypair for encryption (derived from wallet signature)
let currentWithdrawalAmount = null; // Current withdrawal amount in wei (for proof checking)

// ============================================
// BATCHED WITHDRAWALS TRACKING (localStorage)
// ============================================

const BATCHED_WITHDRAWALS_KEY = 'shogun_batched_withdrawals';

/**
 * Get batched withdrawals from localStorage
 */
function getBatchedWithdrawals() {
  try {
    const data = localStorage.getItem(BATCHED_WITHDRAWALS_KEY);
    return data ? JSON.parse(data) : [];
  } catch (e) {
    console.error('Failed to parse batched withdrawals:', e);
    return [];
  }
}

/**
 * Save a withdrawal that was just batched (for later L1 claim)
 */
function saveBatchedWithdrawal(withdrawal) {
  const withdrawals = getBatchedWithdrawals();
  // Avoid duplicates based on user+nonce
  const key = `${withdrawal.user.toLowerCase()}:${withdrawal.nonce}`;
  const existing = withdrawals.findIndex(w => 
    `${w.user.toLowerCase()}:${w.nonce}` === key
  );
  
  if (existing >= 0) {
    withdrawals[existing] = { ...withdrawal, batchedAt: Date.now() };
  } else {
    withdrawals.push({ ...withdrawal, batchedAt: Date.now() });
  }
  
  localStorage.setItem(BATCHED_WITHDRAWALS_KEY, JSON.stringify(withdrawals));
  console.log('Saved batched withdrawal:', withdrawal);
}

/**
 * Remove a withdrawal after it's been claimed on L1
 */
function removeBatchedWithdrawal(user, nonce) {
  const withdrawals = getBatchedWithdrawals();
  const filtered = withdrawals.filter(w => 
    !(w.user.toLowerCase() === user.toLowerCase() && w.nonce === nonce)
  );
  localStorage.setItem(BATCHED_WITHDRAWALS_KEY, JSON.stringify(filtered));
  console.log('Removed batched withdrawal:', { user, nonce });
}

/**
 * Get batched withdrawals for a specific user
 */
function getUserBatchedWithdrawals(userAddress) {
  if (!userAddress) return [];
  return getBatchedWithdrawals().filter(w => 
    w.user.toLowerCase() === userAddress.toLowerCase()
  );
}

/**
 * Manually add a batched withdrawal for recovery
 * This can be called from browser console: window.recoverBatchedWithdrawal(...)
 */
window.recoverBatchedWithdrawal = function(user, amount, nonce, batchId, txHash = null) {
  saveBatchedWithdrawal({
    user: user,
    amount: amount.toString(),
    nonce: nonce.toString(),
    batchId: batchId,
    txHash: txHash,
    timestamp: Date.now()
  });
  console.log('Recovery: Batched withdrawal added to localStorage');
  console.log('Refresh the page and check the Pending Withdrawals tab to claim it.');
  return true;
};

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
  
  // Normalize endpoint
  let normalizedEndpoint = endpoint.trim();
  if (!normalizedEndpoint.match(/^https?:\/\//)) {
    if (normalizedEndpoint.includes('localhost') || normalizedEndpoint.includes('127.0.0.1')) {
      normalizedEndpoint = `http://${normalizedEndpoint}`;
    } else {
      normalizedEndpoint = `https://${normalizedEndpoint}`;
    }
  }
  normalizedEndpoint = normalizedEndpoint.replace(/\/$/, '');
  
  if (relaySDK && currentRelayEndpoint === normalizedEndpoint) {
    return relaySDK;
  }
  
  console.log(`Initializing relay SDK with endpoint: ${normalizedEndpoint}`);
  relaySDK = new ShogunRelaySDK({
    baseURL: normalizedEndpoint,
    timeout: 30000,
  });
  currentRelayEndpoint = normalizedEndpoint;
  
  return relaySDK;
}

/**
 * Get current relay SDK instance (uses selected relay or default)
 */
function getCurrentRelaySDK() {
  // Try to use selected relay
  if (selectedRelayAddress && availableRelays.length > 0) {
    const relay = availableRelays.find(r => r.address.toLowerCase() === selectedRelayAddress.toLowerCase());
    if (relay && relay.endpoint) {
      return getRelaySDK(relay.endpoint);
    }
  }
  
  // Fallback to first available relay
  if (availableRelays.length > 0 && availableRelays[0].endpoint) {
    if (!selectedRelayAddress) {
      selectedRelayAddress = availableRelays[0].address;
      updateRelaySelector();
    }
    return getRelaySDK(availableRelays[0].endpoint);
  }
  
  // Last resort: default endpoint (only if no relays available)
  if (currentRelayEndpoint === DEFAULT_RELAY_ENDPOINT && availableRelays.length === 0) {
    console.warn('No relay available from registry, using default endpoint');
  }
  return getRelaySDK(currentRelayEndpoint);
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
 * Copy text to clipboard
 */
async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (err) {
    // Fallback for older browsers
    try {
      const textArea = document.createElement('textarea');
      textArea.value = text;
      textArea.style.position = 'fixed';
      textArea.style.left = '-999999px';
      textArea.style.top = '-999999px';
      document.body.appendChild(textArea);
      textArea.focus();
      textArea.select();
      const successful = document.execCommand('copy');
      document.body.removeChild(textArea);
      return successful;
    } catch (fallbackErr) {
      console.error('Failed to copy to clipboard:', fallbackErr);
      return false;
    }
  }
}

/**
 * Show copy feedback
 */
function showCopyFeedback(element, originalText) {
  const originalContent = element.innerHTML;
  element.innerHTML = originalText || '✓ Copied!';
  element.style.color = '#22c55e'; // green-500
  
  setTimeout(() => {
    element.innerHTML = originalContent;
    element.style.color = '';
  }, 2000);
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
    
    console.log('GunDB keypair derived successfully');
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
  
  // Get contract configuration from SDK (fallback)
  let config = getConfigByChainId(currentChainId);

  // Try to get confirmation from relay
  try {
    const response = await fetch(`${currentRelayEndpoint}/api/v1/system/contracts`);
    const data = await response.json();
    if (data.success && data.contracts && data.chainId === currentChainId) {
      config = data.contracts;
      console.log('Loaded contracts config from relay');
    }
  } catch (e) {
    console.warn('Failed to load contracts from relay, using SDK default:', e.message);
  }

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
    
    relayRegistry = sdk.getRelayRegistry();
    gunL2Bridge = sdk.getGunL2Bridge();
    
    if (signer && provider instanceof ethers.BrowserProvider) {
      // Update signer if using BrowserProvider
      signer = await provider.getSigner();
      if (sdk) {
        sdk.setSigner(signer);
        relayRegistry = sdk.getRelayRegistry();
        gunL2Bridge = sdk.getGunL2Bridge();
      }
    }
  } catch (error) {
    console.error('Failed to initialize SDK:', error);
    showMessage('error', `Failed to initialize SDK: ${error.message}`);
    return;
  }
  
  // Load available relays from registry
  if (relayRegistry) {
    await loadAvailableRelays();
  }
  
  // Initialize relay SDK with selected relay or default
  await initializeRelaySDK();
  
  await updateBalances();
}

/**
 * Load available relays from registry
 */
async function loadAvailableRelays() {
  if (!relayRegistry) {
    console.warn('Relay registry not initialized');
    return;
  }

  try {
    const addresses = await relayRegistry.getActiveRelays();
    
    if (addresses.length === 0) {
      showMessage('warning', 'No active relays found in registry');
      availableRelays = [];
      updateRelaySelector();
      return;
    }

    availableRelays = [];
    
    for (const addr of addresses) {
      try {
        const info = await relayRegistry.getRelayInfo(addr);
        let endpoint = info.endpoint || '';
        
        // Convert bytes to string if needed
        if (endpoint && typeof endpoint !== 'string') {
          if (Array.isArray(endpoint) || endpoint instanceof Uint8Array) {
            endpoint = new TextDecoder().decode(endpoint);
          } else {
            endpoint = String(endpoint);
          }
        }
        
        // Normalize endpoint - ensure it's a valid URL
        if (endpoint) {
          // Remove null bytes and trim
          endpoint = endpoint.replace(/\0/g, '').trim();
          
          // Add protocol if missing
          if (endpoint && !endpoint.match(/^https?:\/\//)) {
            // Default to https for production, http for localhost
            if (endpoint.includes('localhost') || endpoint.includes('127.0.0.1')) {
              endpoint = `http://${endpoint}`;
            } else {
              endpoint = `https://${endpoint}`;
            }
          }
          
          // Remove trailing slash
          endpoint = endpoint.replace(/\/$/, '');
          
          if (endpoint) {
            availableRelays.push({
              address: addr,
              endpoint: endpoint,
              stakedAmount: info.stakedAmount || 0n,
            });
            console.log(`Loaded relay ${truncateAddress(addr)}: ${endpoint}`);
          }
        }
      } catch (error) {
        console.warn(`Error loading relay info for ${addr}:`, error);
      }
    }

    // Update relay selector if it exists
    updateRelaySelector();
    
    // Auto-select first relay if none selected
    if (availableRelays.length > 0 && !selectedRelayAddress) {
      selectedRelayAddress = availableRelays[0].address;
      updateRelaySelector();
      await initializeRelaySDK();
      console.log(`Auto-selected relay: ${truncateAddress(selectedRelayAddress)}`);
    }
    
    console.log(`Loaded ${availableRelays.length} active relays from registry`);
  } catch (error) {
    console.error('Failed to load relays:', error);
    showMessage('error', `Failed to load relays: ${error.message}`);
  }
}

/**
 * Update relay selector UI
 */
function updateRelaySelector() {
  const selector = document.getElementById('relaySelector');
  const statusEl = document.getElementById('relayStatus');
  const copyRelayBtn = document.getElementById('copyRelayAddressBtn');
  if (!selector) return;

  selector.innerHTML = '';
  
  if (availableRelays.length === 0) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = relayRegistry ? 'No relays available' : 'Connect wallet to load relays...';
    selector.appendChild(option);
    selector.disabled = !relayRegistry;
    if (copyRelayBtn) {
      copyRelayBtn.classList.add('hidden');
    }
    if (statusEl) {
      statusEl.textContent = relayRegistry 
        ? 'No active relays found in registry' 
        : 'Relays are loaded from the on-chain registry';
    }
    return;
  }

  selector.disabled = false;
  
  for (const relay of availableRelays) {
    const option = document.createElement('option');
    option.value = relay.address;
    // Truncate endpoint if too long
    const endpointDisplay = relay.endpoint.length > 40 
      ? relay.endpoint.substring(0, 37) + '...' 
      : relay.endpoint;
    option.textContent = `${truncateAddress(relay.address)} - ${endpointDisplay}`;
    option.selected = selectedRelayAddress && selectedRelayAddress.toLowerCase() === relay.address.toLowerCase();
    selector.appendChild(option);
  }
  
  // Show copy button if a relay is selected
  if (copyRelayBtn && selectedRelayAddress) {
    copyRelayBtn.classList.remove('hidden');
    copyRelayBtn.setAttribute('data-relay-address', selectedRelayAddress);
  } else if (copyRelayBtn) {
    copyRelayBtn.classList.add('hidden');
  }
  
  // Update status
  if (statusEl) {
    const selected = availableRelays.find(r => 
      selectedRelayAddress && r.address.toLowerCase() === selectedRelayAddress.toLowerCase()
    );
    if (selected) {
      statusEl.textContent = `Using relay: ${selected.endpoint}`;
      statusEl.className = 'text-green-400 text-xs mt-1';
    } else {
      statusEl.textContent = `${availableRelays.length} relay(s) available from registry`;
      statusEl.className = 'text-gray-500 text-xs mt-1';
    }
  }
}

/**
 * Initialize relay SDK with selected relay
 */
async function initializeRelaySDK() {
  if (selectedRelayAddress && availableRelays.length > 0) {
    const relay = availableRelays.find(r => r.address.toLowerCase() === selectedRelayAddress.toLowerCase());
    if (relay && relay.endpoint) {
      getRelaySDK(relay.endpoint);
      return;
    }
  }
  
  // Fallback to first available relay
  if (availableRelays.length > 0 && availableRelays[0].endpoint) {
    selectedRelayAddress = availableRelays[0].address;
    getRelaySDK(availableRelays[0].endpoint);
    return;
  }
  
  // Last resort: default endpoint
  getRelaySDK(DEFAULT_RELAY_ENDPOINT);
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
    try {
      const relay = getCurrentRelaySDK();
      console.log(`Fetching L2 balance from relay: ${currentRelayEndpoint}`);
      const balanceResult = await relay.bridge.getBalance(connectedAddress);
      
      if (balanceResult.success) {
        const balanceEth = balanceResult.balanceEth || '0';
        console.log(`L2 balance retrieved: ${balanceEth} ETH`);
        document.getElementById('l2Balance').textContent = `${balanceEth} ETH`;
      } else {
        console.warn('Failed to get L2 balance:', balanceResult.error);
        document.getElementById('l2Balance').textContent = 'Error';
      }
    } catch (error) {
      console.error('Failed to get L2 balance:', error);
      document.getElementById('l2Balance').textContent = 'Error';
      
      // Show helpful error message for network issues
      if (error.code === 'ERR_NETWORK' || error.message?.includes('Network Error')) {
        const relay = availableRelays.find(r => 
          selectedRelayAddress && r.address.toLowerCase() === selectedRelayAddress.toLowerCase()
        ) || availableRelays[0];
        
        if (relay) {
          console.error(`Cannot connect to relay at ${relay.endpoint}. This might be a CORS issue or the relay might be down.`);
        } else {
          console.error('No relay available or relay endpoint is invalid.');
        }
      } else if (error.response) {
        // Axios error with response
        console.error('Relay API error:', error.response.status, error.response.data);
      }
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
    
    // Check network - must be Base Sepolia (84532)
    const network = await provider.getNetwork();
    const expectedChainId = 84532; // Base Sepolia
    
    if (Number(network.chainId) !== expectedChainId) {
      restoreButton();
      showMessage('error', `Please switch to Base Sepolia (Chain ID: ${expectedChainId})`);
      
      // Try to switch network
      try {
        await window.ethereum.request({
          method: 'wallet_switchEthereumChain',
          params: [{ chainId: `0x${expectedChainId.toString(16)}` }],
        });
        // Retry connection after switch
        setTimeout(() => connectWallet(), 1000);
        return;
      } catch (switchError) {
        // If switch fails, try to add network
        if (switchError.code === 4902) {
          try {
            await window.ethereum.request({
              method: 'wallet_addEthereumChain',
              params: [{
                chainId: `0x${expectedChainId.toString(16)}`,
                chainName: 'Base Sepolia',
                nativeCurrency: {
                  name: 'ETH',
                  symbol: 'ETH',
                  decimals: 18,
                },
                rpcUrls: ['https://sepolia.base.org'],
                blockExplorerUrls: ['https://sepolia.basescan.org'],
              }],
            });
            // Retry connection after adding
            setTimeout(() => connectWallet(), 1000);
            return;
          } catch (addError) {
            showMessage('error', 'Please add Base Sepolia network manually in MetaMask');
            return;
          }
        }
        showMessage('error', 'Please switch to Base Sepolia network manually');
        return;
      }
    }

    // Update SDK with signer
    if (sdk) {
      sdk.setSigner(signer);
      relayRegistry = sdk.getRelayRegistry();
      gunL2Bridge = sdk.getGunL2Bridge();
    }

    // Update UI
    const walletAddressEl = document.getElementById('walletAddress');
    walletAddressEl.textContent = truncateAddress(connectedAddress);
    walletAddressEl.setAttribute('data-full-address', connectedAddress);
    
    // Show copy button
    const copyWalletBtn = document.getElementById('copyWalletAddressBtn');
    if (copyWalletBtn) {
      copyWalletBtn.classList.remove('hidden');
    }
    
    document.getElementById('connectWallet').textContent = 'Connected';
    document.getElementById('connectWallet').disabled = true;

    // Derive GunDB keypair
    await deriveGunKeypair();
    
    // Load available relays from registry
    if (relayRegistry) {
      await loadAvailableRelays();
    }
    
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
    
    // Update bridge contract balance immediately (deposit increases it)
    await updateBalances();
    
    // Clear input
    amountInput.value = '';
    
    // Poll for L2 balance update (relay needs time to process the deposit event)
    let pollCount = 0;
    const maxPolls = 20; // Poll for up to 60 seconds (20 * 3s)
    const pollInterval = 3000; // 3 seconds
    
    const pollBalance = async () => {
      pollCount++;
      
      try {
        const relay = getCurrentRelaySDK();
        const balanceResult = await relay.bridge.getBalance(connectedAddress);
        
        if (balanceResult.success) {
          const currentBalance = parseFloat(balanceResult.balanceEth || '0');
          const expectedBalance = parseFloat(formatEth(amountWei));
          
          // Check if balance has been updated (allowing for small rounding differences)
          if (currentBalance >= expectedBalance * 0.99) {
            console.log(`L2 balance updated: ${balanceResult.balanceEth} ETH`);
            await updateBalances();
            showMessage('success', `L2 balance updated! Your deposit is now available.`);
            return; // Stop polling
          } else {
            console.log(`Waiting for L2 balance update... (current: ${balanceResult.balanceEth} ETH, expected: ~${expectedBalance} ETH)`);
          }
        }
      } catch (error) {
        console.warn(`Balance poll attempt ${pollCount} failed:`, error.message);
      }
      
      // Continue polling if we haven't reached max attempts
      if (pollCount < maxPolls) {
        setTimeout(pollBalance, pollInterval);
      } else {
        console.warn('Balance polling timeout. The deposit may still be processing.');
        await updateBalances(); // Final update attempt
        showMessage('info', 'Deposit confirmed on L1. L2 balance may take a few more moments to update.');
      }
    };
    
    // Start polling after initial delay (give relay time to process event)
    setTimeout(pollBalance, 5000);
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
    
    const amountEth = parseFloat(amountInput.value);
    
    if (!amountEth || amountEth <= 0) {
      showMessage('error', 'Please enter a valid amount');
      return;
    }

    const restoreButton = setButtonLoading('requestWithdrawBtn', 'Requesting...');
    const amountWei = ethers.parseEther(amountEth.toString());
    
    // Check L2 balance
    const relay = getCurrentRelaySDK();
    const balanceResult = await relay.bridge.getBalance(connectedAddress);
    if (!balanceResult.success || BigInt(balanceResult.balance) < amountWei) {
      restoreButton();
      showMessage('error', 'Insufficient L2 balance');
      return;
    }

    // Get next nonce from relay before creating signed message
    let nextNonce = null;
    try {
      const nonceResult = await relay.bridge.getNonce(connectedAddress);
      if (nonceResult.success && nonceResult.nextNonce) {
        nextNonce = nonceResult.nextNonce;
        console.log(`Got next nonce from relay: ${nextNonce}`);
      } else {
        throw new Error('Failed to get next nonce');
      }
    } catch (error) {
      console.warn('Failed to get next nonce, will let relay auto-generate:', error);
      // Fallback: let relay auto-generate (will fail verification but we'll fix in next attempt)
      nextNonce = null;
    }

    // Create message for dual signatures (include nonce if we have it)
    const messageData = {
      ethereumAddress: connectedAddress.toLowerCase(),
      amount: amountWei.toString(),
      timestamp: Date.now(),
      type: 'withdrawal',
    };
    
    // Include nonce in message if we have it (required for signature verification)
    if (nextNonce) {
      messageData.nonce = nextNonce;
    }
    
    const message = JSON.stringify(messageData);

    // Create dual signatures
    const { seaSignature, ethSignature, gunPubKey } = await createDualSignatures(message);

    // Request withdrawal (include nonce if we have it)
    const withdrawPayload = {
      user: connectedAddress,
      amount: amountWei.toString(),
      message,
      seaSignature,
      ethSignature,
      gunPubKey,
    };
    
    // Include nonce if we have it
    if (nextNonce) {
      withdrawPayload.nonce = nextNonce;
    }
    
    const result = await relay.bridge.withdraw(withdrawPayload);

    if (!result.success) {
      throw new Error(result.error || 'Withdrawal request failed');
    }

    // Save withdrawal details for proof checking (get nonce from response)
    const responseNonce = result.withdrawal?.nonce || result.nonce;
    currentWithdrawalNonce = responseNonce ? BigInt(responseNonce) : null;
    currentWithdrawalAmount = amountWei;
    
    restoreButton();
    showMessage('success', 'Withdrawal requested. Waiting for batch submission...');
    
    // Show proof section
    document.getElementById('withdrawProofSection').classList.remove('hidden');
    
    // Clear input
    amountInput.value = '';
    
    // Update balances
    await updateBalances();
  } catch (error) {
    console.error('Withdrawal request failed:', error);
    showMessage('error', `Withdrawal request failed: ${error.message}`);
  }
}

async function handleCheckProofAndWithdraw() {
  if (!connectedAddress || !currentWithdrawalNonce || !currentWithdrawalAmount) {
    showMessage('error', 'No withdrawal to process');
    return;
  }

  try {
    const restoreButton = setButtonLoading('checkProofBtn', 'Checking...');
    
    const relay = getCurrentRelaySDK();
    
    // Use saved withdrawal amount instead of reading from input (which is cleared)
    const amountWei = currentWithdrawalAmount;
    
    // Get proof
    const proofResult = await relay.bridge.getProof(
      connectedAddress,
      amountWei.toString(),
      currentWithdrawalNonce.toString()
    );

    if (!proofResult.success || !proofResult.proof) {
      restoreButton();
      showMessage('info', 'Proof not available yet. Please wait for batch submission.');
      return;
    }

    // Withdraw on-chain
    const batchIdBigInt = BigInt(proofResult.batchId);
    const tx = await gunL2Bridge.withdraw(
      amountWei,
      currentWithdrawalNonce,
      batchIdBigInt,
      proofResult.proof
    );

    showMessage('info', `Transaction sent: ${tx.hash}. Waiting for confirmation...`);
    
    const receipt = await tx.wait();
    
    restoreButton();
    showMessage('success', `Withdrawal successful! TX: ${receipt.hash}`);
    
    // Update bridge contract balance immediately (withdrawal decreases it)
    await updateBalances();
    
    // Hide proof section
    document.getElementById('withdrawProofSection').classList.add('hidden');
    currentWithdrawalNonce = null;
    currentWithdrawalAmount = null;
  } catch (error) {
    console.error('Withdrawal failed:', error);
    
    // Check if it's a 404 (proof not ready)
    if (error.response?.status === 404 || error.message?.includes('404')) {
      showMessage('info', 'Proof not available yet. Please wait for batch submission.');
    } else {
      showMessage('error', `Withdrawal failed: ${error.message}`);
    }
  }
}

/**
 * Start polling for proof availability
 */
function startProofPolling(user, amount, nonce, buttonId) {
  // Clear any existing polling for this button
  if (window.proofPollingIntervals) {
    if (window.proofPollingIntervals[buttonId]) {
      clearInterval(window.proofPollingIntervals[buttonId]);
    }
  } else {
    window.proofPollingIntervals = {};
  }
  
  let attempts = 0;
  const maxAttempts = 60; // Poll for up to 5 minutes (60 * 5 seconds)
  const pollInterval = 5000; // Check every 5 seconds
  
  const poll = async () => {
    attempts++;
    
    try {
      const relay = getCurrentRelaySDK();
      const proofResult = await relay.bridge.getProof(user, amount, nonce);
      
      if (proofResult.success && proofResult.proof) {
        // Proof is available! Stop polling and enable withdrawal
        clearInterval(window.proofPollingIntervals[buttonId]);
        delete window.proofPollingIntervals[buttonId];
        
        const btn = window.proofPollingButtons?.[buttonId];
        if (btn) {
          btn.disabled = false;
          btn.textContent = 'Withdraw Now';
          showMessage('success', 'Proof is now available! Click "Withdraw Now" to complete the withdrawal.');
        }
      } else if (attempts >= maxAttempts) {
        // Timeout
        clearInterval(window.proofPollingIntervals[buttonId]);
        delete window.proofPollingIntervals[buttonId];
        
        const btn = window.proofPollingButtons?.[buttonId];
        if (btn) {
          btn.disabled = false;
          btn.textContent = 'Check Proof';
          showMessage('warning', 'Proof polling timed out. Please try again later.');
        }
      }
      // Otherwise, continue polling
    } catch (error) {
      // If it's still a 404, continue polling
      if (error.response?.status === 404 || error.message?.includes('404')) {
        if (attempts >= maxAttempts) {
          clearInterval(window.proofPollingIntervals[buttonId]);
          delete window.proofPollingIntervals[buttonId];
          
          const btn = window.proofPollingButtons?.[buttonId];
          if (btn) {
            btn.disabled = false;
            btn.textContent = 'Check Proof';
            showMessage('warning', 'Proof polling timed out. Please try again later.');
          }
        }
      } else {
        // Other error - stop polling
        clearInterval(window.proofPollingIntervals[buttonId]);
        delete window.proofPollingIntervals[buttonId];
        
        const btn = window.proofPollingButtons?.[buttonId];
        if (btn) {
          btn.disabled = false;
          btn.textContent = 'Check Proof';
          showMessage('error', `Error checking proof: ${error.message}`);
        }
      }
    }
  };
  
  // Start polling
  window.proofPollingIntervals[buttonId] = setInterval(poll, pollInterval);
  
  // Also check immediately
  poll();
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
    const relay = getCurrentRelaySDK();
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

document.getElementById('submitBatchBtn')?.addEventListener('click', async () => {
  const button = document.getElementById('submitBatchBtn');
  if (!button) return;
  
  const restoreButton = setButtonLoading('submitBatchBtn', 'Submitting batch...');
  
  try {
    const relay = getCurrentRelaySDK();
    
    // Get pending withdrawals BEFORE submitting batch (so we can save them to localStorage)
    const pendingResult = await relay.bridge.getPendingWithdrawals();
    const pendingWithdrawals = pendingResult.success ? pendingResult.withdrawals : [];
    
    const result = await relay.bridge.submitBatch();
    
    if (result.success) {
      // Save the batched withdrawals to localStorage so user can claim them later
      const batchId = result.batch.batchId;
      const txHash = result.batch.txHash;
      
      pendingWithdrawals.forEach(w => {
        saveBatchedWithdrawal({
          user: w.user,
          amount: w.amount,
          nonce: w.nonce,
          batchId: batchId,
          txHash: txHash,
          timestamp: w.timestamp || Date.now()
        });
      });
      
      showMessage('success', `Batch submitted successfully! Batch ID: ${batchId}, TX: ${txHash}`);
      // Reload pending withdrawals to update the list (will now also show batched ones)
      await loadPendingWithdrawals();
      // Also update balances
      await updateBalances();
    } else {
      showMessage('error', `Failed to submit batch: ${result.error || 'Unknown error'}`);
    }
  } catch (error) {
    console.error('Failed to submit batch:', error);
    const errorMsg = error.response?.data?.error || error.message || 'Unknown error';
    
    if (error.response?.status === 403) {
      showMessage('error', 'You are not authorized to submit batches. Only the sequencer can submit batches.');
    } else if (error.response?.status === 400 && errorMsg.includes('No pending withdrawals')) {
      showMessage('warning', 'No pending withdrawals to batch.');
    } else {
      showMessage('error', `Failed to submit batch: ${errorMsg}`);
    }
  } finally {
    restoreButton();
  }
});

async function loadPendingWithdrawals() {
  if (!connectedAddress) {
    showMessage('error', 'Please connect wallet first');
    return;
  }

  try {
    // Stop all proof polling when reloading
    if (window.proofPollingIntervals) {
      Object.values(window.proofPollingIntervals).forEach(interval => clearInterval(interval));
      window.proofPollingIntervals = {};
    }
    window.proofPollingButtons = {};
    
    const restoreButton = setButtonLoading('refreshWithdrawalsBtn', 'Loading...');
    
    const relay = getCurrentRelaySDK();
    const result = await relay.bridge.getPendingWithdrawals();
    
    restoreButton();
    
    const listEl = document.getElementById('withdrawalsList');
    listEl.innerHTML = '';
    
    // Get batched withdrawals from localStorage (ready to claim)
    const batchedWithdrawals = getUserBatchedWithdrawals(connectedAddress);
    
    // Check if we have any visible withdrawals
    const hasPending = result.success && result.withdrawals && result.withdrawals.length > 0;
    const hasBatched = batchedWithdrawals && batchedWithdrawals.length > 0;
    
    if (!hasPending && !hasBatched) {
      listEl.innerHTML = '<p class="text-gray-400 text-center py-8">No pending withdrawals</p>';
      document.getElementById('submitBatchBtn')?.classList.add('hidden');
      return;
    }

    // Show submit batch button if there are any pending withdrawals (sequencer can submit)
    const submitBatchBtn = document.getElementById('submitBatchBtn');
    if (submitBatchBtn) {
      if (hasPending) {
        submitBatchBtn.classList.remove('hidden');
      } else {
        submitBatchBtn.classList.add('hidden');
      }
    }

    // Filter pending withdrawals for current user
    const userWithdrawals = hasPending ? result.withdrawals.filter(
      w => w.user.toLowerCase() === connectedAddress.toLowerCase()
    ) : [];
    
    // Display "Ready to Claim" section for batched withdrawals
    if (hasBatched) {
      const readySection = document.createElement('div');
      readySection.className = 'mb-6';
      readySection.innerHTML = '<h3 class="text-green-400 font-semibold mb-3">Ready to Claim (On-Chain)</h3>';
      
      batchedWithdrawals.forEach(withdrawal => {
        const item = document.createElement('div');
        item.className = 'withdrawal-item ready';
        
        const amountEth = formatEth(BigInt(withdrawal.amount));
        const date = new Date(withdrawal.batchedAt || withdrawal.timestamp).toLocaleString();
        
        item.innerHTML = `
          <div class="flex justify-between items-center">
            <div>
              <p class="text-white font-semibold">${amountEth} ETH</p>
              <p class="text-gray-400 text-sm">Batch: ${withdrawal.batchId}</p>
              <p class="text-gray-400 text-sm">Nonce: ${withdrawal.nonce}</p>
              <p class="text-gray-400 text-sm">${date}</p>
            </div>
            <button class="btn btn-sm btn-primary claim-btn" 
                    data-amount="${withdrawal.amount}" 
                    data-nonce="${withdrawal.nonce}"
                    data-batch="${withdrawal.batchId}">
              Withdraw Now
            </button>
          </div>
        `;
        
        readySection.appendChild(item);
      });
      
      listEl.appendChild(readySection);
      
      // Add event listeners to claim buttons
      readySection.querySelectorAll('.claim-btn').forEach(btn => {
        btn.addEventListener('click', () => handleClaimWithdrawal(btn));
      });
    }
    
    // Display pending withdrawals section
    if (userWithdrawals.length === 0 && !hasBatched) {
      listEl.innerHTML = '<p class="text-gray-400 text-center py-8">No pending withdrawals for your address</p>';
      // Still show submit batch button if there are other users' withdrawals
      return;
    }
    
    if (userWithdrawals.length > 0) {
      const pendingSection = document.createElement('div');
      pendingSection.innerHTML = '<h3 class="text-yellow-400 font-semibold mb-3">Pending (Waiting for Batch)</h3>';

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
        
        pendingSection.appendChild(item);
      });
      
      listEl.appendChild(pendingSection);

      // Add event listeners to check proof buttons
      document.querySelectorAll('.check-proof-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
        const amount = btn.dataset.amount;
        const nonce = btn.dataset.nonce;
        const buttonId = `proof-btn-${nonce}`;
        
        // Store button reference for polling
        if (!window.proofPollingButtons) {
          window.proofPollingButtons = {};
        }
        window.proofPollingButtons[buttonId] = btn;
        
        // If button says "Withdraw Now", it means proof is available - proceed directly to withdrawal
        if (btn.textContent === 'Withdraw Now') {
          try {
            btn.disabled = true;
            btn.textContent = 'Withdrawing...';
            
            const relay = getCurrentRelaySDK();
            const proofResult = await relay.bridge.getProof(connectedAddress, amount, nonce);
            
            // Check if it's a pending status (202 response)
            if (proofResult.status === 'pending') {
              btn.disabled = false;
              btn.textContent = 'Waiting for batch...';
              showMessage('info', `Withdrawal is pending. ${proofResult.message || 'Waiting for batch submission.'}`);
              return;
            }

            // Check if already processed
            if (proofResult.status === 'already_processed') {
              btn.disabled = false;
              btn.textContent = 'Already Processed';
              showMessage('success', proofResult.message || 'This withdrawal has already been processed. Check your wallet!');
              await updateBalances();
              await loadPendingWithdrawals();
              return;
            }

            if (proofResult.success && proofResult.proof) {
              const amountWei = BigInt(amount);
              const nonceBigInt = BigInt(nonce);
              
              const batchIdBigInt = BigInt(proofResult.batchId);
              console.log('Calling withdraw on-chain:', { amount, nonce, batchId: batchIdBigInt.toString(), proofLength: proofResult.proof.length });
              const tx = await gunL2Bridge.withdraw(
                amountWei,
                nonceBigInt,
                batchIdBigInt,
                proofResult.proof
              );
              
              showMessage('info', `Transaction sent: ${tx.hash}. Waiting for confirmation...`);
              console.log('Withdraw transaction sent:', tx.hash);
              
              const receipt = await tx.wait();
              console.log('Withdraw transaction confirmed:', receipt);
              
              if (receipt.status === 1) {
                showMessage('success', `Withdrawal successful! TX: ${receipt.hash}`);
              } else {
                showMessage('error', `Withdrawal transaction failed. TX: ${receipt.hash}`);
                console.error('Transaction failed:', receipt);
              }
              
              await updateBalances();
              await loadPendingWithdrawals();
            } else {
              btn.disabled = false;
              btn.textContent = 'Check Proof';
              showMessage('error', 'Proof no longer available. Please try again.');
            }
          } catch (error) {
            console.error('Failed to withdraw:', error);
            btn.disabled = false;
            btn.textContent = 'Withdraw Now';
            const errorMsg = error.reason || error.message || 'Unknown error';
            showMessage('error', `Withdrawal failed: ${errorMsg}`);
            
            // Check for specific error cases
            if (error.code === 'ACTION_REJECTED') {
              showMessage('warning', 'Transaction was rejected by user');
            } else if (error.code === 'INSUFFICIENT_FUNDS') {
              showMessage('error', 'Insufficient funds for gas fees');
            } else if (error.message?.includes('proof')) {
              showMessage('error', 'Invalid proof. Please try again after batch submission.');
            }
          }
          return;
        }
        
        try {
          // Disable button and show loading
          btn.disabled = true;
          btn.textContent = 'Checking...';
          
          const relay = getCurrentRelaySDK();
          const proofResult = await relay.bridge.getProof(connectedAddress, amount, nonce);
          
          // Check if it's a pending status (202 response)
          if (proofResult.status === 'pending') {
            btn.textContent = 'Waiting for batch...';
            showMessage('info', `Withdrawal is pending. ${proofResult.message || 'Waiting for batch submission.'}`);
            
            // Start polling for proof
            startProofPolling(connectedAddress, amount, nonce, buttonId);
            return;
          }

          // Check if already processed
          if (proofResult.status === 'already_processed') {
            btn.disabled = false;
            btn.textContent = 'Already Processed';
            showMessage('success', proofResult.message || 'This withdrawal has already been processed. Check your wallet!');
            await updateBalances();
            await loadPendingWithdrawals();
            return;
          }

          if (proofResult.success && proofResult.proof) {
            // Proof available, can withdraw
            btn.textContent = 'Withdrawing...';
            const amountWei = BigInt(amount);
            const nonceBigInt = BigInt(nonce);
            
            const batchIdBigInt = BigInt(proofResult.batchId);
            console.log('Calling withdraw on-chain:', { amount, nonce, batchId: batchIdBigInt.toString(), proofLength: proofResult.proof.length });
            const tx = await gunL2Bridge.withdraw(
              amountWei,
              nonceBigInt,
              batchIdBigInt,
              proofResult.proof
            );
            
            showMessage('info', `Transaction sent: ${tx.hash}. Waiting for confirmation...`);
            console.log('Withdraw transaction sent:', tx.hash);
            
            const receipt = await tx.wait();
            console.log('Withdraw transaction confirmed:', receipt);
            
            if (receipt.status === 1) {
              showMessage('success', `Withdrawal successful! TX: ${receipt.hash}`);
            } else {
              showMessage('error', `Withdrawal transaction failed. TX: ${receipt.hash}`);
              console.error('Transaction failed:', receipt);
            }
            
            await updateBalances();
            await loadPendingWithdrawals();
          } else {
            // Proof not available yet - start polling
            btn.textContent = 'Waiting for batch...';
            showMessage('info', 'Proof not available yet. Waiting for batch submission...');
            
            // Start polling for proof
            startProofPolling(connectedAddress, amount, nonce, buttonId);
          }
        } catch (error) {
          console.error('Failed to check proof:', error);
          
          // Check if it's a 404 (proof not ready) or another error
          if (error.response?.status === 404 || error.message?.includes('404')) {
            btn.textContent = 'Waiting for batch...';
            showMessage('info', 'Proof not available yet. Please submit a batch first using the "Submit Batch" button.');
            
            // Start polling for proof
            startProofPolling(connectedAddress, amount, nonce, buttonId);
          } else {
            btn.disabled = false;
            btn.textContent = 'Check Proof';
            const errorMsg = error.response?.data?.error || error.message || 'Unknown error';
            showMessage('error', `Failed to check proof: ${errorMsg}`);
          }
        }
      });
      });
    } // End of if (userWithdrawals.length > 0)
  } catch (error) {
    console.error('Failed to load withdrawals:', error);
    showMessage('error', `Failed to load withdrawals: ${error.message}`);
  }
}

/**
 * Handle claiming a batched withdrawal (from localStorage)
 * This is called when user clicks "Withdraw Now" on a ready-to-claim withdrawal
 */
async function handleClaimWithdrawal(btn) {
  const amount = btn.dataset.amount;
  const nonce = btn.dataset.nonce;
  const batchId = btn.dataset.batch;
  
  console.log('Claiming withdrawal:', { amount, nonce, batchId });
  
  try {
    btn.disabled = true;
    btn.textContent = 'Claiming...';
    
    const relay = getCurrentRelaySDK();
    const proofResult = await relay.bridge.getProof(connectedAddress, amount, nonce);
    
    if (!proofResult.success || !proofResult.proof) {
      btn.disabled = false;
      btn.textContent = 'Withdraw Now';
      showMessage('error', proofResult.error || 'Failed to get proof for withdrawal');
      return;
    }
    
    // Check if already processed
    if (proofResult.status === 'already_processed') {
      // Remove from localStorage since it's already done
      removeBatchedWithdrawal(connectedAddress, nonce);
      showMessage('success', 'This withdrawal has already been processed. Check your wallet!');
      await updateBalances();
      await loadPendingWithdrawals();
      return;
    }
    
    // Execute on-chain withdrawal
    btn.textContent = 'Withdrawing...';
    const amountWei = BigInt(amount);
    const nonceBigInt = BigInt(nonce);
    
    const batchIdBigInt = BigInt(proofResult.batchId);
    console.log('Calling withdraw on-chain:', { amount, nonce, batchId: batchIdBigInt.toString(), proofLength: proofResult.proof.length });
    const tx = await gunL2Bridge.withdraw(
      amountWei,
      nonceBigInt,
      batchIdBigInt,
      proofResult.proof
    );
    
    showMessage('info', `Transaction sent: ${tx.hash}. Waiting for confirmation...`);
    console.log('Withdraw transaction sent:', tx.hash);
    
    const receipt = await tx.wait();
    console.log('Withdraw transaction confirmed:', receipt);
    
    if (receipt.status === 1) {
      // Success! Remove from localStorage
      removeBatchedWithdrawal(connectedAddress, nonce);
      showMessage('success', `Withdrawal successful! TX: ${receipt.hash}`);
    } else {
      showMessage('error', `Withdrawal transaction failed. TX: ${receipt.hash}`);
      console.error('Transaction failed:', receipt);
    }
    
    await updateBalances();
    await loadPendingWithdrawals();
  } catch (error) {
    console.error('Failed to claim withdrawal:', error);
    btn.disabled = false;
    btn.textContent = 'Withdraw Now';
    
    const errorMsg = error.reason || error.message || 'Unknown error';
    showMessage('error', `Withdrawal failed: ${errorMsg}`);
    
    if (error.code === 'ACTION_REJECTED') {
      showMessage('warning', 'Transaction was rejected by user');
    } else if (error.code === 'INSUFFICIENT_FUNDS') {
      showMessage('error', 'Insufficient funds for gas fees');
    }
  }
}

// ============================================
// RELAY SELECTION
// ============================================


document.getElementById('refreshRelaysBtn')?.addEventListener('click', async () => {
  if (!relayRegistry) {
    showMessage('error', 'Please connect wallet first to load relays from registry');
    return;
  }
  
  const restoreButton = setButtonLoading('refreshRelaysBtn', 'Refreshing...');
  try {
    await loadAvailableRelays();
    await initializeRelaySDK();
    await updateBalances();
    showMessage('success', 'Relays refreshed successfully');
  } catch (error) {
    console.error('Failed to refresh relays:', error);
    showMessage('error', `Failed to refresh relays: ${error.message}`);
  } finally {
    restoreButton();
  }
});

// Copy wallet address to clipboard
document.getElementById('copyWalletAddressBtn')?.addEventListener('click', async () => {
  const walletAddressEl = document.getElementById('walletAddress');
  const fullAddress = walletAddressEl?.getAttribute('data-full-address');
  
  if (!fullAddress || fullAddress === 'Not connected') {
    return;
  }
  
  const success = await copyToClipboard(fullAddress);
  if (success) {
    showCopyFeedback(walletAddressEl, '✓ Copied!');
    showMessage('success', 'Address copied to clipboard');
  } else {
    showMessage('error', 'Failed to copy address');
  }
});

// Click on wallet address to copy
document.getElementById('walletAddress')?.addEventListener('click', async () => {
  const walletAddressEl = document.getElementById('walletAddress');
  const fullAddress = walletAddressEl?.getAttribute('data-full-address');
  
  if (!fullAddress || fullAddress === 'Not connected') {
    return;
  }
  
  const success = await copyToClipboard(fullAddress);
  if (success) {
    showCopyFeedback(walletAddressEl, '✓ Copied!');
    showMessage('success', 'Address copied to clipboard');
  } else {
    showMessage('error', 'Failed to copy address');
  }
});

// Copy relay address to clipboard
document.getElementById('copyRelayAddressBtn')?.addEventListener('click', async () => {
  const copyBtn = document.getElementById('copyRelayAddressBtn');
  const relayAddress = copyBtn?.getAttribute('data-relay-address');
  
  if (!relayAddress) {
    return;
  }
  
  const success = await copyToClipboard(relayAddress);
  if (success) {
    const icon = copyBtn.querySelector('svg');
    if (icon) {
      const originalColor = icon.getAttribute('class');
      icon.setAttribute('class', originalColor.replace('text-gray-400', 'text-green-400'));
      setTimeout(() => {
        icon.setAttribute('class', originalColor);
      }, 2000);
    }
    showMessage('success', 'Relay address copied to clipboard');
  } else {
    showMessage('error', 'Failed to copy relay address');
  }
});

// Update copy button when relay selection changes
document.getElementById('relaySelector')?.addEventListener('change', async (e) => {
  const selectedAddress = e.target.value;
  if (!selectedAddress) {
    const copyRelayBtn = document.getElementById('copyRelayAddressBtn');
    if (copyRelayBtn) {
      copyRelayBtn.classList.add('hidden');
    }
    return;
  }
  
  selectedRelayAddress = selectedAddress;
  const copyRelayBtn = document.getElementById('copyRelayAddressBtn');
  if (copyRelayBtn) {
    copyRelayBtn.classList.remove('hidden');
    copyRelayBtn.setAttribute('data-relay-address', selectedAddress);
  }
  
  await initializeRelaySDK();
  await updateBalances();
  showMessage('success', 'Relay changed successfully');
});

// ============================================
// SYNC DEPOSITS
// ============================================

document.getElementById('syncDepositsBtn')?.addEventListener('click', () => handleSyncDeposits());
document.getElementById('processDepositBtn')?.addEventListener('click', () => handleProcessDeposit());
document.getElementById('reconcileBalanceBtn')?.addEventListener('click', () => handleReconcileBalance());
document.getElementById('reconcileBalanceBtnQuick')?.addEventListener('click', () => handleReconcileBalance('quick'));
document.getElementById('reconcileBalanceBtnFromDeposit')?.addEventListener('click', () => handleReconcileBalance('deposit'));

async function handleReconcileBalance(source = 'default') {
  if (!connectedAddress) {
    showMessage('error', 'Please connect wallet first');
    return;
  }

  // Determine which button was clicked
  let buttonId = 'reconcileBalanceBtn';
  if (source === 'quick') {
    buttonId = 'reconcileBalanceBtnQuick';
  } else if (source === 'deposit') {
    buttonId = 'reconcileBalanceBtnFromDeposit';
  }

  try {
    const restoreButton = setButtonLoading(buttonId, 'Reconciling...');
    
    showMessage('info', 'Reconciling balance. This may take a moment...');
    
    const relay = getCurrentRelaySDK();
    const result = await relay.bridge.reconcileBalance(connectedAddress);

    if (result.success) {
      // Show results in the detailed section if it exists (only in sync tab)
      const reconcileResults = document.getElementById('reconcileResults');
      if (reconcileResults) {
        reconcileResults.classList.remove('hidden');
        const currentBalanceEl = document.getElementById('reconcileCurrentBalance');
        const calculatedBalanceEl = document.getElementById('reconcileCalculatedBalance');
        const messageDiv = document.getElementById('reconcileMessage');
        
        if (currentBalanceEl) {
          currentBalanceEl.textContent = 
            `${ethers.formatEther(result.currentBalance)} ETH (${result.currentBalance} wei)`;
        }
        if (calculatedBalanceEl) {
          calculatedBalanceEl.textContent = 
            `${ethers.formatEther(result.calculatedBalance)} ETH (${result.calculatedBalance} wei)`;
        }
        if (messageDiv) {
          if (result.corrected) {
            messageDiv.className = 'mt-2 text-sm text-green-400';
            messageDiv.textContent = `Success: ${result.message}`;
          } else {
            messageDiv.className = 'mt-2 text-sm text-blue-400';
            messageDiv.textContent = `Info: ${result.message}`;
          }
        }
      }
      
      // Show message
      if (result.corrected) {
        showMessage('success', result.message);
      } else {
        showMessage('info', result.message);
      }

      // Update balances
      await updateBalances();
    } else {
      showMessage('error', `Reconciliation failed: ${result.error || 'Unknown error'}`);
    }

    restoreButton();
  } catch (error) {
    console.error('Reconcile balance failed:', error);
    showMessage('error', `Reconciliation failed: ${error.message}`);
    const restoreButton = setButtonLoading(buttonId, source === 'quick' ? 'Reconcile Balance' : (source === 'deposit' ? 'Reconcile L2 Balance' : 'Reconcile My Balance'));
    restoreButton();
  }
}

async function handleSyncDeposits() {
  if (!connectedAddress) {
    showMessage('error', 'Please connect wallet first');
    return;
  }

  try {
    const syncAllDeposits = document.getElementById('syncAllDeposits').checked;
    const syncMyDeposits = document.getElementById('syncMyDeposits').checked;
    const fromBlockInput = document.getElementById('syncFromBlock').value;
    const toBlockInput = document.getElementById('syncToBlock').value;

    const params = {};
    
    if (fromBlockInput) {
      const fromBlock = parseInt(fromBlockInput, 10);
      if (isNaN(fromBlock) || fromBlock < 0) {
        showMessage('error', 'Invalid from block number');
        return;
      }
      params.fromBlock = fromBlock;
    }

    if (toBlockInput) {
      if (toBlockInput.toLowerCase() === 'latest') {
        params.toBlock = 'latest';
      } else {
        const toBlock = parseInt(toBlockInput, 10);
        if (isNaN(toBlock) || toBlock < 0) {
          showMessage('error', 'Invalid to block number');
          return;
        }
        params.toBlock = toBlock;
      }
    }

    if (syncMyDeposits && !syncAllDeposits) {
      params.user = connectedAddress;
    }

    const restoreButton = setButtonLoading('syncDepositsBtn', 'Syncing...');
    
    showMessage('info', 'Starting deposit sync. This may take a while...');
    
    const relay = getCurrentRelaySDK();
    const result = await relay.bridge.syncDeposits(params);

    if (result.success) {
      // Show results
      document.getElementById('syncResults').classList.remove('hidden');
      document.getElementById('syncTotal').textContent = result.results.total;
      document.getElementById('syncProcessed').textContent = result.results.processed;
      document.getElementById('syncSkipped').textContent = result.results.skipped;
      document.getElementById('syncFailed').textContent = result.results.failed;

      if (result.results.errors && result.results.errors.length > 0) {
        document.getElementById('syncErrors').classList.remove('hidden');
        const errorsDiv = document.getElementById('syncErrors').querySelector('div');
        errorsDiv.textContent = result.results.errors.join('\n');
      } else {
        document.getElementById('syncErrors').classList.add('hidden');
      }

      // Update balances
      await updateBalances();

      if (result.results.processed > 0) {
        showMessage('success', `Sync completed! ${result.results.processed} deposit(s) processed.`);
      } else if (result.results.skipped > 0) {
        showMessage('info', 'All deposits were already processed.');
      } else {
        showMessage('info', 'No deposits found to sync.');
      }
    } else {
      showMessage('error', `Sync failed: ${result.error || 'Unknown error'}`);
    }

    restoreButton();
  } catch (error) {
    console.error('Sync deposits failed:', error);
    showMessage('error', `Sync failed: ${error.message}`);
  }
}

async function handleProcessDeposit() {
  if (!connectedAddress) {
    showMessage('error', 'Please connect wallet first');
    return;
  }

  const txHash = document.getElementById('processTxHash').value.trim();
  
  if (!txHash || !txHash.startsWith('0x') || txHash.length !== 66) {
    showMessage('error', 'Please enter a valid transaction hash (0x...)');
    return;
  }

  try {
    const restoreButton = setButtonLoading('processDepositBtn', 'Processing...');
    
    showMessage('info', 'Processing deposit...');
    
    const relay = getCurrentRelaySDK();
    const result = await relay.bridge.processDeposit(txHash);

    // Show results
    document.getElementById('processResult').classList.remove('hidden');
    const resultContent = document.getElementById('processResultContent');
    
    if (result.success) {
      if (result.message) {
        resultContent.innerHTML = `
          <div class="text-green-400 mb-2">${result.message}</div>
          ${result.deposit ? `
            <div class="space-y-1 text-sm">
              <div class="flex justify-between items-center">
                <span class="text-gray-400">User:</span>
                <div class="flex items-center gap-2">
                  <span class="text-white font-mono cursor-pointer hover:text-indigo-400 transition-colors copy-address" data-address="${result.deposit.user}" title="Click to copy">${result.deposit.user}</span>
                  <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4 text-gray-500 hover:text-indigo-400 copy-address-icon cursor-pointer" data-address="${result.deposit.user}" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                  </svg>
                </div>
              </div>
              <div class="flex justify-between">
                <span class="text-gray-400">Amount:</span>
                <span class="text-white">${result.deposit.amountEth} ETH</span>
              </div>
              <div class="flex justify-between">
                <span class="text-gray-400">Block:</span>
                <span class="text-white">${result.deposit.blockNumber}</span>
              </div>
              ${result.balance ? `
                <div class="flex justify-between mt-2 pt-2 border-t border-gray-700">
                  <span class="text-gray-400">New Balance:</span>
                  <span class="text-green-400 font-semibold">${result.balance.eth} ETH</span>
                </div>
              ` : ''}
            </div>
          ` : ''}
        `;
        
        // Add click handlers for copy functionality
        resultContent.querySelectorAll('.copy-address, .copy-address-icon').forEach(element => {
          element.addEventListener('click', async () => {
            const address = element.getAttribute('data-address');
            if (address) {
              const success = await copyToClipboard(address);
              if (success) {
                const addressSpan = resultContent.querySelector('.copy-address');
                if (addressSpan) {
                  showCopyFeedback(addressSpan, '✓ Copied!');
                }
                showMessage('success', 'Address copied to clipboard');
              } else {
                showMessage('error', 'Failed to copy address');
              }
            }
          });
        });
      } else {
        resultContent.innerHTML = `
          <div class="text-green-400">Deposit processed successfully!</div>
          ${result.balance ? `
            <div class="mt-2 text-sm">
              <span class="text-gray-400">New Balance: </span>
              <span class="text-green-400 font-semibold">${result.balance.eth} ETH</span>
            </div>
          ` : ''}
        `;
      }

      // Update balances
      await updateBalances();

      showMessage('success', 'Deposit processed successfully!');
    } else {
      resultContent.innerHTML = `
        <div class="text-red-400">Processing failed</div>
        <div class="text-sm text-gray-400 mt-1">${result.error || 'Unknown error'}</div>
      `;
      showMessage('error', `Processing failed: ${result.error || 'Unknown error'}`);
    }

    restoreButton();
  } catch (error) {
    console.error('Process deposit failed:', error);
    showMessage('error', `Processing failed: ${error.message}`);
    document.getElementById('processResult').classList.remove('hidden');
    document.getElementById('processResultContent').innerHTML = `
      <div class="text-red-400">Error</div>
      <div class="text-sm text-gray-400 mt-1">${error.message}</div>
    `;
  }
}

// ============================================
// INITIALIZE ON LOAD
// ============================================

// ============================================
// MANUAL BALANCE REFRESH
// ============================================

function setupBalanceRefreshButton() {
  const refreshBtn = document.getElementById('refreshL2BalanceBtn');
  if (refreshBtn) {
    refreshBtn.addEventListener('click', async () => {
      if (!connectedAddress) {
        showMessage('error', 'Please connect wallet first');
        return;
      }
      
      const restoreButton = setButtonLoading('refreshL2BalanceBtn', '');
      try {
        await updateBalances();
        showMessage('success', 'Balance refreshed');
      } catch (error) {
        console.error('Failed to refresh balance:', error);
        showMessage('error', `Failed to refresh balance: ${error.message}`);
      } finally {
        restoreButton();
      }
    });
  }
}

// ============================================
// FORCE WITHDRAWAL (Anti-Censorship) HANDLERS
// ============================================

async function handleForceWithdraw() {
  if (!sdk || !connectedAddress) {
    showMessage('error', 'Please connect wallet first');
    return;
  }

  const amountInput = document.getElementById('forceWithdrawAmount');
  const nonceInput = document.getElementById('forceWithdrawNonce');
  
  const amount = amountInput.value;
  const nonce = nonceInput.value;

  if (!amount || parseFloat(amount) <= 0) {
    showMessage('error', 'Please enter a valid amount');
    return;
  }
  
  if (!nonce || parseInt(nonce) < 0) {
    showMessage('error', 'Please enter a valid nonce');
    return;
  }

  const restoreButton = setButtonLoading('forceWithdrawBtn', 'Processing...');
  
  try {
    const amountWei = ethers.parseEther(amount);
    const bridge = sdk.getGunL2Bridge();
    
    showMessage('info', 'Initiating force withdrawal on L1...');
    
    const tx = await bridge.initiateForceWithdrawal(amountWei, BigInt(nonce));
    const receipt = await tx.wait();
    
    showMessage('success', `Force withdrawal initiated! TX: ${receipt.hash}. You have 24 hours to wait for sequencer to process it.`);
    
    // Update bridge contract balance (force withdrawal may affect contract state)
    await updateBalances();
    
  } catch (error) {
    console.error('Force withdraw error:', error);
    showMessage('error', `Force withdrawal failed: ${error.message}`);
  } finally {
    restoreButton();
  }
}

async function handleProveCensorship() {
  if (!sdk || !connectedAddress) {
    showMessage('error', 'Please connect wallet first');
    return;
  }

  const amountInput = document.getElementById('forceWithdrawAmount');
  const nonceInput = document.getElementById('forceWithdrawNonce');
  
  const amount = amountInput.value;
  const nonce = nonceInput.value;

  if (!amount || parseFloat(amount) <= 0) {
    showMessage('error', 'Please enter the amount from your force withdrawal request');
    return;
  }
  
  if (!nonce || parseInt(nonce) < 0) {
    showMessage('error', 'Please enter the nonce from your force withdrawal request');
    return;
  }

  const restoreButton = setButtonLoading('proveCensorshipBtn', 'Processing...');
  
  try {
    const amountWei = ethers.parseEther(amount);
    const bridge = sdk.getGunL2Bridge();
    
    showMessage('info', 'Proving censorship and freezing bridge...');
    
    const tx = await bridge.proveCensorship(connectedAddress, amountWei, BigInt(nonce));
    const receipt = await tx.wait();
    
    showMessage('success', `Censorship proven! Bridge is now frozen. TX: ${receipt.hash}`);
    
  } catch (error) {
    console.error('Prove censorship error:', error);
    showMessage('error', `Failed to prove censorship: ${error.message}`);
  } finally {
    restoreButton();
  }
}

function setupForceWithdrawHandlers() {
  const forceWithdrawBtn = document.getElementById('forceWithdrawBtn');
  if (forceWithdrawBtn) {
    forceWithdrawBtn.addEventListener('click', handleForceWithdraw);
  }
  
  const proveCensorshipBtn = document.getElementById('proveCensorshipBtn');
  if (proveCensorshipBtn) {
    proveCensorshipBtn.addEventListener('click', handleProveCensorship);
  }
}

// ============================================
// TRANSACTION EXPLORER
// ============================================

async function loadTransactions() {
  if (!connectedAddress) {
    const listEl = document.getElementById('transactionsList');
    if (listEl) {
      listEl.innerHTML = '<p class="text-gray-400 text-center py-8">Connect your wallet to view transaction history</p>';
    }
    return;
  }

  try {
    const listEl = document.getElementById('transactionsList');
    const summaryEl = document.getElementById('transactionsSummary');
    
    if (listEl) {
      listEl.innerHTML = '<p class="text-gray-400 text-center py-8">Loading transactions...</p>';
    }

    const relay = getCurrentRelaySDK();
    const result = await relay.bridge.getTransactions(connectedAddress);

    if (!result.success) {
      throw new Error(result.error || 'Failed to load transactions');
    }

    // Update summary
    if (summaryEl && result.summary) {
      summaryEl.classList.remove('hidden');
      document.getElementById('summaryDeposits').textContent = result.summary.deposits;
      document.getElementById('summaryWithdrawals').textContent = result.summary.withdrawals;
      document.getElementById('summaryTransfers').textContent = result.summary.transfers;
    }

    // Display transactions
    if (listEl) {
      if (result.transactions.length === 0) {
        listEl.innerHTML = '<p class="text-gray-400 text-center py-8">No transactions found</p>';
        return;
      }

      listEl.innerHTML = '';
      result.transactions.forEach(tx => {
        const item = document.createElement('div');
        item.className = 'card p-4 hover:bg-gray-800/50 transition-colors';
        
        const typeColors = {
          deposit: 'text-blue-400',
          withdrawal: 'text-purple-400',
          transfer: 'text-cyan-400'
        };
        
        const typeIcons = {
          deposit: '⬇️',
          withdrawal: '⬆️',
          transfer: '↔️'
        };
        
        const statusBadges = {
          pending: '<span class="badge badge-warning badge-sm">Pending</span>',
          completed: '<span class="badge badge-success badge-sm">Completed</span>',
          batched: '<span class="badge badge-info badge-sm">Batched</span>'
        };

        const date = new Date(tx.timestamp).toLocaleString();
        const isOutgoing = tx.type === 'withdrawal' || (tx.type === 'transfer' && tx.from?.toLowerCase() === connectedAddress.toLowerCase());
        const otherAddress = isOutgoing ? tx.to : tx.from;
        
        item.innerHTML = `
          <div class="flex items-start justify-between gap-4">
            <div class="flex items-start gap-3 flex-1">
              <div class="text-2xl">${typeIcons[tx.type]}</div>
              <div class="flex-1">
                <div class="flex items-center gap-2 mb-1">
                  <span class="${typeColors[tx.type]} font-semibold uppercase text-sm">${tx.type}</span>
                  ${statusBadges[tx.status] || ''}
                </div>
                <p class="text-white font-semibold text-lg">${isOutgoing ? '-' : '+'}${tx.amountEth} ETH</p>
                ${otherAddress ? `<p class="text-gray-400 text-sm mt-1">${isOutgoing ? 'To' : 'From'}: ${truncateAddress(otherAddress)}</p>` : ''}
                ${tx.blockNumber ? `<p class="text-gray-500 text-xs mt-1">Block: ${tx.blockNumber}</p>` : ''}
                <p class="text-gray-500 text-xs mt-1">${date}</p>
              </div>
            </div>
            <div class="text-right">
              ${tx.txHash ? `
                <button class="btn btn-sm btn-ghost text-xs copy-tx-hash" data-tx="${tx.txHash}" title="Copy TX Hash">
                  ${truncateAddress(tx.txHash, 8)}
                </button>
              ` : '<span class="text-gray-500 text-xs">No hash</span>'}
            </div>
          </div>
        `;
        
        listEl.appendChild(item);
      });

      // Add copy handlers
      listEl.querySelectorAll('.copy-tx-hash').forEach(btn => {
        btn.addEventListener('click', () => {
          const txHash = btn.dataset.tx;
          navigator.clipboard.writeText(txHash).then(() => {
            showMessage('success', 'Transaction hash copied to clipboard');
          });
        });
      });
    }
  } catch (error) {
    console.error('Error loading transactions:', error);
    const listEl = document.getElementById('transactionsList');
    if (listEl) {
      listEl.innerHTML = `<p class="text-red-400 text-center py-8">Error loading transactions: ${error.message}</p>`;
    }
    showMessage('error', `Failed to load transactions: ${error.message}`);
  }
}

async function searchTransaction() {
  const input = document.getElementById('searchTxHash');
  const modal = document.getElementById('txDetailsModal');
  const content = document.getElementById('txDetailsContent');
  
  if (!input || !modal || !content) return;
  
  const txHash = input.value.trim();
  if (!txHash) {
    showMessage('error', 'Please enter a transaction hash');
    return;
  }

  try {
    content.innerHTML = '<p class="text-gray-400 text-center py-8">Searching...</p>';
    modal.classList.remove('hidden');
    
    const relay = getCurrentRelaySDK();
    const result = await relay.bridge.getTransaction(txHash);

    if (!result.success || !result.transaction) {
      content.innerHTML = `
        <div class="text-center py-8">
          <p class="text-red-400 mb-2">Transaction not found</p>
          <p class="text-gray-400 text-sm">${result.error || 'The transaction hash does not match any deposits, withdrawals, or transfers.'}</p>
        </div>
      `;
      return;
    }

    const tx = result.transaction;
    const typeColors = {
      deposit: 'text-blue-400',
      withdrawal: 'text-purple-400',
      transfer: 'text-cyan-400'
    };
    
    const date = new Date(tx.timestamp).toLocaleString();
    
    content.innerHTML = `
      <div class="space-y-4">
        <div class="flex items-center gap-2">
          <span class="${typeColors[tx.type]} font-semibold uppercase">${tx.type}</span>
          <span class="badge badge-${tx.status === 'completed' ? 'success' : tx.status === 'pending' ? 'warning' : 'info'} badge-sm">${tx.status}</span>
        </div>
        
        <div class="grid grid-cols-2 gap-4">
          <div>
            <p class="text-gray-400 text-sm mb-1">Amount</p>
            <p class="text-white font-semibold text-lg">${tx.amountEth} ETH</p>
            <p class="text-gray-500 text-xs">${tx.amount} wei</p>
          </div>
          <div>
            <p class="text-gray-400 text-sm mb-1">Date</p>
            <p class="text-white">${date}</p>
          </div>
        </div>
        
        ${tx.from ? `
          <div>
            <p class="text-gray-400 text-sm mb-1">From</p>
            <p class="text-white font-mono text-sm">${tx.from}</p>
          </div>
        ` : ''}
        
        ${tx.to ? `
          <div>
            <p class="text-gray-400 text-sm mb-1">To</p>
            <p class="text-white font-mono text-sm">${tx.to}</p>
          </div>
        ` : ''}
        
        ${tx.blockNumber ? `
          <div>
            <p class="text-gray-400 text-sm mb-1">Block Number</p>
            <p class="text-white">${tx.blockNumber}</p>
          </div>
        ` : ''}
        
        ${tx.nonce ? `
          <div>
            <p class="text-gray-400 text-sm mb-1">Nonce</p>
            <p class="text-white">${tx.nonce}</p>
          </div>
        ` : ''}
        
        <div>
          <p class="text-gray-400 text-sm mb-1">Transaction Hash</p>
          <div class="flex items-center gap-2">
            <p class="text-white font-mono text-sm break-all">${tx.txHash || 'N/A'}</p>
            ${tx.txHash ? `
              <button class="btn btn-sm btn-ghost copy-btn" data-text="${tx.txHash}">
                <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                </svg>
              </button>
            ` : ''}
          </div>
        </div>
      </div>
    `;
    
    // Add copy handler
    const copyBtn = content.querySelector('.copy-btn');
    if (copyBtn) {
      copyBtn.addEventListener('click', () => {
        const text = copyBtn.dataset.text;
        navigator.clipboard.writeText(text).then(() => {
          showMessage('success', 'Copied to clipboard');
        });
      });
    }
  } catch (error) {
    console.error('Error searching transaction:', error);
    content.innerHTML = `
      <div class="text-center py-8">
        <p class="text-red-400 mb-2">Error</p>
        <p class="text-gray-400 text-sm">${error.message}</p>
      </div>
    `;
  }
}

function setupTransactionHandlers() {
  // Refresh button
  const refreshBtn = document.getElementById('refreshTransactionsBtn');
  if (refreshBtn) {
    refreshBtn.addEventListener('click', loadTransactions);
  }

  // Search button
  const searchBtn = document.getElementById('searchTxBtn');
  if (searchBtn) {
    searchBtn.addEventListener('click', searchTransaction);
  }

  // Search on Enter key
  const searchInput = document.getElementById('searchTxHash');
  if (searchInput) {
    searchInput.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') {
        searchTransaction();
      }
    });
  }

  // Close modal
  const closeModal = document.getElementById('closeTxModal');
  if (closeModal) {
    closeModal.addEventListener('click', () => {
      const modal = document.getElementById('txDetailsModal');
      if (modal) {
        modal.classList.add('hidden');
      }
    });
  }

  // Close modal on backdrop click
  const modal = document.getElementById('txDetailsModal');
  if (modal) {
    modal.addEventListener('click', (e) => {
      if (e.target === modal) {
        modal.classList.add('hidden');
      }
    });
  }

  // Load transactions when tab is opened
  document.querySelectorAll('.tab-button').forEach(btn => {
    btn.addEventListener('click', () => {
      if (btn.dataset.tab === 'transactions') {
        loadTransactions();
      }
    });
  });
}

// ============================================
// INITIALIZE ON LOAD
// ============================================

document.addEventListener('DOMContentLoaded', async () => {
  await loadNetworkConfig();
  setupBalanceRefreshButton();
  setupForceWithdrawHandlers();
  setupTransactionHandlers();
});

