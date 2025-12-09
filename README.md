# Shogun L2 Bridge App

Una semplice applicazione web per gestire depositi, prelievi e trasferimenti di ETH tra L1 (Base Sepolia) e L2 (GunDB) utilizzando il bridge Shogun.

**Network**: Base Sepolia (Chain ID: 84532)

## Funzionalità

- **Deposito (L1 → L2)**: Deposita ETH dal tuo wallet L1 al bridge contract
- **Prelievo (L2 → L1)**: Richiedi il prelievo di ETH da L2 a L1 usando Merkle proofs
- **Trasferimento (L2 → L2)**: Trasferisci ETH tra utenti su L2
- **Visualizzazione Saldi**: Mostra saldi L1, L2 e del bridge contract
- **Pending Withdrawals**: Visualizza e gestisci i prelievi in attesa

## Requisiti

- Node.js 18+
- MetaMask o altro wallet compatibile con EIP-1193
- Un relay Shogun in esecuzione (default: `http://localhost:8765`)

## Installazione

```bash
npm install
```

## Sviluppo

```bash
npm run dev
```

L'app sarà disponibile su `http://localhost:3001`

## Build

```bash
npm run build
```

I file compilati saranno in `dist/`

## Utilizzo

1. **Connetti Wallet**: Clicca su "Connect Wallet" e approva la connessione
2. **Deposita**: Inserisci l'importo e clicca "Deposit" per depositare ETH da L1 a L2
3. **Prelieva**: Inserisci importo e nonce, clicca "Request Withdrawal", poi "Check Proof & Withdraw" quando il batch è pronto
4. **Trasferisci**: Inserisci indirizzo destinatario e importo per trasferire ETH su L2

## Architettura

L'app utilizza:
- **Shogun Contracts SDK**: Per interagire con il contratto `GunL2Bridge`
- **Shogun Relay SDK**: Per interagire con le API del relay (balance, transfer, withdraw, proof)
- **Shogun Core**: Per derivare il keypair GunDB dal wallet Ethereum
- **GunDB SEA**: Per le firme duali (SEA + Ethereum) richieste per trasferimenti e prelievi

## Sicurezza

- Le operazioni L2 richiedono firme duali (SEA + Ethereum) per dimostrare il controllo sia del wallet che del keypair GunDB
- I prelievi utilizzano Merkle proofs per garantire che siano verificabili matematicamente
- Il nonce previene attacchi di replay

## Note

- I depositi vengono processati automaticamente dal relay listener quando il contratto emette l'evento `Deposit`
- I prelievi richiedono che il sequencer invii un batch prima che la proof sia disponibile
- I saldi vengono aggiornati automaticamente ogni 30 secondi

