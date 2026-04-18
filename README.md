# Aave V3 Liquidation Bot — Arbitrum One

## How it works

```
1. SEED    → query Aave subgraph for all addresses with active borrows
2. WATCH   → listen to Borrow/Supply/Repay/Withdraw events for new/changed positions  
3. REFRESH → call getUserAccountData() on-chain for highest-risk positions each cycle
4. EVALUATE→ when HF < 1.0, compute best collateral/debt pair to liquidate
5. EXECUTE → flash-borrow debt token → liquidate → Odos swap collateral→debt → repay flash loan
6. PROFIT  → liquidation bonus stays in contract; owner withdraws
```

## Why liquidations work

When a borrower's Health Factor drops below 1.0, their position is insolvent.
Aave allows anyone to repay their debt and receive their collateral at a **discount** (the liquidation bonus):

| Collateral | Bonus  |
|-----------|--------|
| USDC       | 5%     |
| WETH       | 5%     |
| WBTC       | 7.5%   |
| ARB        | 10%    |
| LINK       | 10%    |
| AAVE       | 10%    |

Example: borrower has $10,000 WETH collateral and $8,500 USDC debt.
- Market drops → HF = 0.98
- You repay $4,250 USDC (50% close factor)
- You receive $4,462 WETH (5% bonus = $212 gross profit)
- Gas cost on Arbitrum: ~$1–3
- Net profit: ~$210

## vs. Cross-DEX Arb (old strategy)

| Factor | DEX Arb | Liquidations |
|--------|---------|--------------|
| Profit per event | $1–10 | $10–500+ |
| Competition | Extreme (ms windows) | Moderate (minutes window) |
| Window duration | ~250ms | Minutes to hours |
| Requires speed | Yes (Rust bots) | No (TypeScript fine) |
| Spread needed | >0.4% (rare) | HF < 1.0 (happens daily) |

## Setup

### 1. Deploy `LiquidatorContract.sol`

```bash
# Deploy to Arbitrum One — deployer becomes owner
# Contract self-funds via flash loans — no capital needed in contract
```

### 2. Configure

```bash
npm install
cp .env.example .env
```

Fill in `.env`:
```
RPC_URL=https://arb-mainnet.g.alchemy.com/v2/YOUR_KEY
PRIVATE_KEY=your_private_key
CONTRACT_ADDRESS=0xYourDeployedContract
MIN_PROFIT_USD=10
```

### 3. Run

```bash
npm run diagnose    # check current liquidatable positions (no trades)
npm run dev         # run the bot
npm run build && npm start  # production
```

## Architecture

```
src/
  positions.ts   ← seeds + tracks borrowers (subgraph + live events)
  oracle.ts      ← reads Aave price oracle on-chain (8 decimal USD prices)
  evaluator.ts   ← calculates profitable collateral/debt pair + bonus
  odos.ts        ← assembles collateral→debt swap calldata
  executor.ts    ← fetches Odos calldata, simulates, submits tx
  index.ts       ← main loop
  diagnose.ts    ← show current liquidatable positions, no trades
  config.ts      ← all addresses, ABIs, reserve configs
LiquidatorContract.sol ← deploy this
```

## Withdrawing profits

Profits accumulate as tokens in the contract. Call periodically:

```
// In executor (or from Arbiscan directly):
await executor.withdraw("0xaf88d065e77c8cC2239327C5EDb3A432268e5831"); // USDC
await executor.withdraw("0x82aF49447D8a07e3bd95BD0d56f35241523fBab1"); // WETH
```

## Honest limitations

- **Still competitive** — other liquidation bots exist. But the window is minutes, not milliseconds, so TypeScript/Node is viable.
- **Subgraph latency** — The Graph may lag 1–2 blocks. We compensate by also watching live events.
- **Flash loan cost** — Aave charges 0.05% premium. On a $5,000 liquidation that's $2.50, well below the 5–10% bonus.
- **Odos quote freshness** — We fetch Odos calldata just before submitting. If the market moves between quote and execution, the simulation will catch it and we abort.
- **Min position size** — Aave requires >$1,000 collateral AND >$1,000 debt for partial liquidations. Below that, full liquidation is allowed. Small positions ($500–$2,000) may not be profitable after gas.
