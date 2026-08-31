// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IERC20 {
    function balanceOf(address) external view returns (uint256);
    function transfer(address, uint256) external returns (bool);
    function approve(address, uint256) external returns (bool);
    function allowance(address, address) external view returns (uint256);
}

interface IAaveFlashPool {
    function flashLoanSimple(address, address, uint256, bytes calldata, uint16) external;
}

interface IAaveLiquidationPool {
    function liquidationCall(address, address, address, uint256, bool) external;
}

interface ISwapRouter {
    struct ExactInputParams {
        bytes   path;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
    }
    function exactInput(ExactInputParams calldata params) external payable returns (uint256 amountOut);
}

/**
 * @title AaveLiquidator — Uniswap V3 edition
 *
 * Executes Aave V3 flashloan liquidations with collateral→debt swaps routed
 * entirely through Uniswap V3 SwapRouter02. No Odos dependency.
 *
 * Flow per liquidation:
 *   1. flashLoanSimple(debtAsset, debtToCover)
 *   2. liquidationCall → receive collateral
 *   3. SwapRouter02.exactInput(collateral → debt, pre-encoded path from bot)
 *   4. assert debtBalance >= flashloan repayment
 *   5. repay flashloan, keep profit
 *
 * Security properties:
 *   - onlyOwner on liquidate() — bot wallet only
 *   - nonReentrant guard via _status flag
 *   - executeOperation() gated: only Aave Pool, only self-initiated, only mid-liquidation
 *   - All approvals revoked after use
 *   - Profitability enforced on-chain (Step 4) — reverts if swap output insufficient
 *   - debtToCover != max guard (flashLoanSimple rejects max)
 *   - deadline guard — stale txs revert cleanly rather than executing at wrong prices
 *
 * Deployment:
 *   constructor(UNISWAP_SWAP_ROUTER02)  // 0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45
 */
contract AaveLiquidator {

    address public immutable owner;
    address public constant  AAVE_POOL    = 0x794a61358D6845594F94dc1DB02A252b5b4814aD;
    address public immutable SWAP_ROUTER;  // Uniswap V3 SwapRouter02

    uint256 private constant _NOT_ENTERED = 1;
    uint256 private constant _ENTERED     = 2;
    uint256 private _status               = _NOT_ENTERED;

    struct LiquidationParams {
        address collateralAsset;
        address debtAsset;
        address borrower;
        uint256 debtToCover;
        bytes   swapPath;        // Uniswap V3 encoded path (empty if collateral == debt)
        uint256 amountOutMinimum; // slippage floor for the swap
    }

    event LiquidationExecuted(
        address indexed borrower,
        address indexed collateralAsset,
        address indexed debtAsset,
        uint256 debtCovered,
        uint256 collateralReceived,
        uint256 profitRaw,
        uint256 flashloanPremium  // FIX: emit premium for accurate accounting
    );

    constructor(address swapRouter) {
        require(swapRouter != address(0), "Bad router");
        owner       = msg.sender;
        SWAP_ROUTER = swapRouter;
    }

    modifier onlyOwner()    { require(msg.sender == owner,   "Not owner");  _; }
    modifier nonReentrant() {
        require(_status != _ENTERED, "Reentrant");
        _status = _ENTERED;
        _;
        _status = _NOT_ENTERED;
    }

    /**
     * @notice Initiate a flashloan liquidation.
     * @param collateralAsset  Token to receive as liquidation bonus.
     * @param debtAsset        Token to repay on behalf of the borrower.
     * @param borrower         Address of the undercollateralised borrower.
     * @param debtToCover      Exact debt amount to repay (NOT type(uint256).max).
     * @param swapPath         Uniswap V3 encoded path: collateral → ... → debtAsset.
     *                         Pass empty bytes if collateralAsset == debtAsset.
     * @param amountOutMinimum Minimum debt tokens out from the swap (slippage floor).
     *                         Pass 0 if collateralAsset == debtAsset.
     * @param deadline         Block timestamp after which this tx should revert.
     *                         Prevents stale txs from executing at wrong prices.
     *                         Pass type(uint256).max to disable.
     */
    function liquidate(
        address collateralAsset,
        address debtAsset,
        address borrower,
        uint256 debtToCover,
        bytes   calldata swapPath,
        uint256 amountOutMinimum,
        uint256 deadline
    ) external onlyOwner nonReentrant {
        require(block.timestamp <= deadline, "Transaction expired");  // FIX: deadline guard
        require(collateralAsset != address(0), "Bad collateral");
        require(debtAsset       != address(0), "Bad debt asset");
        require(borrower        != address(0), "Bad borrower");
        require(debtToCover      > 0,          "Zero debtToCover");
        require(debtToCover      != type(uint256).max, "Use exact amount");

        bool needsSwap = (collateralAsset != debtAsset);
        if (needsSwap) {
            require(swapPath.length >= 43, "Swap needed but no path"); // min: addr(20)+fee(3)+addr(20)
        }

        bytes memory params = abi.encode(LiquidationParams({
            collateralAsset:  collateralAsset,
            debtAsset:        debtAsset,
            borrower:         borrower,
            debtToCover:      debtToCover,
            swapPath:         swapPath,
            amountOutMinimum: amountOutMinimum
        }));

        IAaveFlashPool(AAVE_POOL).flashLoanSimple(
            address(this), debtAsset, debtToCover, params, 0
        );
    }

    function executeOperation(
        address asset,
        uint256 amount,
        uint256 premium,
        address initiator,
        bytes calldata rawParams
    ) external returns (bool) {
        require(_status    == _ENTERED,      "Not mid-liquidation");
        require(msg.sender == AAVE_POOL,     "Only Aave Pool");
        require(initiator  == address(this), "Only self-initiated");

        LiquidationParams memory p = abi.decode(rawParams, (LiquidationParams));
        require(asset == p.debtAsset, "Asset mismatch");

        uint256 repayToAave = amount + premium;
        uint256 colBefore   = IERC20(p.collateralAsset).balanceOf(address(this));
        // Balance at entry ALREADY includes the flashloaned `amount`, so
        // (debtBefore - amount) is whatever this contract held beforehand.
        uint256 debtBefore  = IERC20(p.debtAsset).balanceOf(address(this));

        // Step 1: approve Aave to pull debt repayment during liquidationCall
        _safeApprove(IERC20(p.debtAsset), AAVE_POOL, p.debtToCover);

        // Step 2: liquidate — Aave pulls debtToCover, sends us collateral
        IAaveLiquidationPool(AAVE_POOL).liquidationCall(
            p.collateralAsset, p.debtAsset, p.borrower, p.debtToCover, false
        );

        // Revoke residual Aave approval
        _safeApprove(IERC20(p.debtAsset), AAVE_POOL, 0);

        uint256 colReceived = IERC20(p.collateralAsset).balanceOf(address(this)) - colBefore;

        // Step 3: swap collateral → debtAsset via Uniswap V3
        if (p.collateralAsset != p.debtAsset) {
            require(colReceived > 0, "No collateral — already liquidated?");

            _safeApprove(IERC20(p.collateralAsset), SWAP_ROUTER, colReceived);

            ISwapRouter(SWAP_ROUTER).exactInput(
                ISwapRouter.ExactInputParams({
                    path:             p.swapPath,
                    recipient:        address(this),
                    amountIn:         colReceived,
                    amountOutMinimum: p.amountOutMinimum
                })
            );

            // Revoke router approval (colReceived should be fully consumed)
            _safeApprove(IERC20(p.collateralAsset), SWAP_ROUTER, 0);
        }

        // Step 4: enforce profitability on the DELTA, not the total balance.
        //
        // Comparing the whole balance against repayToAave was wrong: any debt
        // tokens already sitting in this contract — profit left over from an
        // earlier liquidation, or a stray transfer — would cover the shortfall
        // and let a swap that actually lost money pass the check.
        //
        // Let B0 be the balance at entry (which includes the flashloaned
        // `amount`) and S the tokens produced by the swap. Preserving prior
        // profit requires S >= amount + premium, i.e. the final balance must be
        // at least (B0 - amount) + repayToAave.
        uint256 debtBal  = IERC20(p.debtAsset).balanceOf(address(this));
        uint256 required = debtBefore - amount + repayToAave;
        require(debtBal >= required, "Unprofitable — cannot repay flashloan");

        uint256 profit = debtBal - required;

        // Step 5: authorize Aave to pull flashloan repayment
        _safeApprove(IERC20(p.debtAsset), AAVE_POOL, repayToAave);

        emit LiquidationExecuted(
            p.borrower, p.collateralAsset, p.debtAsset, amount, colReceived, profit, premium  // FIX: emit premium
        );

        return true;
    }

    function _safeApprove(IERC20 token, address spender, uint256 value) private {
        if (value != 0 && token.allowance(address(this), spender) != 0) {
            token.approve(spender, 0);
        }
        token.approve(spender, value);
    }

    // FIX: Use low-level call instead of require(transfer(...)) to support tokens
    // that don't return a bool (e.g. older ERC20s like USDT on some chains).
    // The pattern: call transfer, check success AND that returndata is either
    // empty (non-bool tokens) or true (standard bool tokens).
    function withdraw(address token) external onlyOwner {
        uint256 bal = IERC20(token).balanceOf(address(this));
        require(bal > 0, "Nothing to withdraw");
        (bool ok, bytes memory data) = token.call(
            abi.encodeWithSelector(IERC20.transfer.selector, owner, bal)
        );
        require(ok && (data.length == 0 || abi.decode(data, (bool))), "Transfer failed");
    }

    function withdrawNative() external onlyOwner {
        (bool ok,) = owner.call{value: address(this).balance}("");
        require(ok, "ETH transfer failed");
    }

    function revokeApproval(address token, address spender) external onlyOwner {
        IERC20(token).approve(spender, 0);
    }

    receive() external payable {}
}
