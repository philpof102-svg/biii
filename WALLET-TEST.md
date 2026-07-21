# BIII — the first real USDC test (Rabby → the till, end-to-end)

The one thing tests can't prove offline: a real customer pays real USDC on Base and the till verifies it
field-for-field, shows **Payé ✓**, and hands over a re-checkable receipt. This is that test.

**Non-custodial by construction:** the till holds no key. YOU (Rabby) sign and send; the chain — not the
server — says "paid". Use a tiny amount (0.10 USDC is plenty).

## 1. Run the till with YOUR address as the merchant

```bash
cd D:/Users/VolKov/veilleIA/biii
BIII_MERCHANT=0x<your Base address> npm run serve
#   → BIII server → http://127.0.0.1:4700 · merchant 0x<you>
# optional, if mainnet.base.org rate-limits you: BASE_RPC_URL=https://<your Base RPC> BIII_MERCHANT=0x… npm run serve
```

The server now serves the till **and** the API at the same URL (same-origin — the `?api=` hole is closed).

## 2. Open the till and create a charge

- On the SAME machine: open **http://127.0.0.1:4700**.
- To use your **phone** (real QR scan): find the laptop's LAN IP (`ipconfig`), open
  `http://<laptop-ip>:4700` on the phone on the same Wi-Fi. (Or run the server on a host the phone can reach.)
- Tap an amount — e.g. **0.10** — then **Encaisser ▶**. A QR appears (EIP-681:
  `ethereum:USDC@8453/transfer?address=<you>&uint256=100000`). The till starts polling `/status`.

## 3. Pay it with Rabby (real USDC on Base)

- **Scan the QR** with a wallet that reads EIP-681 (Base App / Coinbase Wallet / MetaMask mobile), OR
- **Rabby (desktop/extension)**: send **0.10 USDC** on **Base** to the merchant address shown. USDC on Base
  is `0x833589fcd6edb6e08f4c7c32d4f71b54bda02913`. Send the exact amount (over-pay just becomes a tip).

Because the till binds the charge to its creation time, only a payment that lands **after** you pressed
Encaisser counts — a prior transfer to the same address will not false-trigger it.

## 4. Watch it verify

Within a few seconds of the transfer confirming (1 conf on Base ≈ 2s), the till flips to **Payé ✓** with the
verified amount, the payer, and the tier. Tap **Reçu** → the bon-de-caisse with a **Basescan verify link**
(the real on-chain proof anyone can re-check).

## 5. (Optional) MainStreet on your wallet

Your Rabby address through the reputation oracle:

```bash
curl -s -H "x-ms-monitor: 1" "https://avisradar-production.up.railway.app/api/agent/preflight/0x<your address>"
#   → decision (PROCEED / CAUTION / BLOCK) + trustShield. A clean wallet is not known-bad; a sanctioned/
#     drainer address now returns BLOCK (the known-bad ingestion is live).
```

## If it doesn't flip to Payé

- **`/status` 502 "chain read failed"** → the RPC (mainnet.base.org) rate-limited; set `BASE_RPC_URL` to your own Base RPC and restart.
- **Stays "En attente"** → confirm the transfer is on **Base** (chainId 8453), to the **exact merchant
  address**, in **USDC** (not USDbC/ETH), and **≥ the amount**. The verifier is field-for-field on purpose.
- **The till warns "Vérification indisponible"** → the poll hit repeated errors; it keeps retrying, check the RPC.

*This is the demo you run for a first partner too — see PILOT.md §3.*
