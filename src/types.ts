// ─── Borrower position data ───────────────────────────────────────────────────

export interface BorrowerPosition {
  address:           string;
  healthFactor:      bigint;   // raw 1e18 units (1e18 = HF of 1.0)
  healthFactorNum:   number;   // human (e.g. 0.95)
  totalCollateralBase: bigint; // USD value in 1e8 units (Aave base currency)
  totalDebtBase:     bigint;   // USD value in 1e8 units
  // Per-asset breakdown (populated lazily when profitable)
  collaterals?:      AssetPosition[];
  debts?:            AssetPosition[];
  // Bug #8 fix: e-mode category — if > 0, close factor can be 100% regardless of HF threshold
  userEmodeCategoryId?: number;
}

export interface AssetPosition {
  symbol:     string;
  address:    string;
  decimals:   number;
  balance:    bigint;   // raw token units
  balanceUsd: number;   // USD value
}

// ─── Liquidation opportunity ──────────────────────────────────────────────────

export interface LiquidationOpportunity {
  borrower:          string;
  healthFactor:      number;
  collateralAsset:   string;  // address
  collateralSymbol:  string;
  debtAsset:         string;  // address
  debtSymbol:        string;
  debtToCover:       bigint;  // raw debt units to repay
  debtToCoverUsd:    number;
  expectedCollateral:bigint;  // raw collateral we'll receive
  expectedBonusUsd:  number;  // USD value of liquidation bonus (gross profit)
  gasCostUsd:        number;
  netProfitUsd:      number;
  useFlashloan:      boolean; // true = we don't need capital, flash it
  // Set by evaluator.ts (Uniswap quote is done during evaluate(), not in executor)
  swapPath?:          string;   // encoded Uniswap V3 path bytes ("0x" if same-asset)
  swapOutputAmount?:  bigint;   // quoted output amount (0n if same-asset)
  amountOutMinimum?:  bigint;   // slippage floor = outputAmount * (1 - slippage)
}
