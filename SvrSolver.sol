// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IERC20 {
    function balanceOf(address) external view returns (uint256);
    function approve(address, uint256) external returns (bool);
    function allowance(address, address) external view returns (uint256);
}

interface IWETH is IERC20 {
    function withdraw(uint256) external;
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

// The two Atlas entry points a solver must use to settle its gas bill.
interface IAtlas {
    function shortfall() external view returns (uint256 gasLiability, uint256 borrowLiability);
    function reconcile(uint256 maxApprovedGasSpend) external payable returns (uint256 owed);
}

/**
 * @title AaveSvrSolver — Chainlink SVR / Atlas solver for Aave V3 liquidations
 *
 * Aave's Arbitrum oracle prices most reserves off Chainlink SVR feeds. The price
 * update for those feeds is not broadcast publicly: the oracle network bundles it
 * with the winning searcher's transaction through the Atlas auction, so a
 * position only becomes liquidatable INSIDE that bundle. This contract is the
 * searcher side of that bundle.
 *
 * Atlas calls atlasSolverCall() right after the price update has been applied,
 * in the same transaction. For each item supplied by the bot we run the same
 * flashloan → liquidationCall → Uniswap V3 swap sequence as AaveLiquidator, turn
 * the profit into ETH, and pay the auction bid to Atlas's execution environment.
 *
 * Nothing here needs capital of its own: the debt is flashloaned, the bid is paid
 * out of the liquidation profit, and the aggregate check below reverts the whole
 * operation if the profit does not cover the bid.
 *
 * Safety properties:
 *   - atlasSolverCall is callable by Atlas only, and only for operations signed by `owner`
 *   - items are isolated: one that reverts (already liquidated, rounding) is skipped
 *   - profit must cover bidAmount or the operation reverts (Atlas then charges the
 *     solver's bonded gas only for the gas this operation used)
 *   - executeOperation is gated: Aave Pool, self-initiated, mid-item
 *   - all approvals revoked after use
 *
 * Deployment:
 *   constructor(UNISWAP_SWAP_ROUTER02, ATLAS)
 *     0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45, 0x8ad1aE9D97C79aA68A0a151E83ff3942f68F86C1
 */
contract AaveSvrSolver {

    address public immutable owner;
    address public immutable SWAP_ROUTER;
    address public immutable ATLAS;
    address public constant AAVE_POOL = 0x794a61358D6845594F94dc1DB02A252b5b4814aD;
    address public constant WETH      = 0x82aF49447D8a07e3bd95BD0d56f35241523fBab1;

    // True only while runItem() is on the stack; gates executeOperation.
    bool private _inItem;

    struct Item {
        address collateralAsset;
        address debtAsset;
        address borrower;
        uint256 debtToCover;
        bytes   swapPath;          // collateral -> debt (empty if same asset)
        uint256 amountOutMinimum;  // floor for the collateral -> debt swap
        bytes   profitPath;        // debt -> WETH (empty if debt is WETH)
    }

    event ItemLiquidated(address indexed borrower, address indexed collateralAsset, address indexed debtAsset, uint256 debtCovered, uint256 profitDebt, uint256 collateralReceived);
    event ItemSkipped(address indexed borrower, bytes reason);
    event BidPaid(address indexed executionEnvironment, uint256 bidAmount, uint256 profitEth, uint256 itemsDone, uint256 itemsSkipped);

    constructor(address swapRouter, address atlas) {
        require(swapRouter != address(0) && atlas != address(0), "Bad address");
        owner       = msg.sender;
        SWAP_ROUTER = swapRouter;
        ATLAS       = atlas;
    }

    modifier onlyOwner() { require(msg.sender == owner, "Not owner"); _; }

    // ── Atlas entry point ────────────────────────────────────────────────────

    function atlasSolverCall(
        address solverOpFrom,
        address executionEnvironment,
        address bidToken,
        uint256 bidAmount,
        bytes calldata solverOpData,
        bytes calldata /* forwardedData */
    ) external payable {
        require(msg.sender == ATLAS,     "Only Atlas");
        require(solverOpFrom == owner,   "Bad signer");
        require(bidToken == address(0),  "ETH bids only");

        Item[] memory items = abi.decode(solverOpData, (Item[]));

        // Value held before we start, ETH and WETH alike, so earlier profit sitting
        // in this contract can never be mistaken for this operation's profit.
        uint256 before_ = address(this).balance + IERC20(WETH).balanceOf(address(this));

        uint256 done;
        for (uint256 i = 0; i < items.length; i++) {
            try this.runItem(items[i]) {
                done++;
            } catch (bytes memory reason) {
                emit ItemSkipped(items[i].borrower, reason);
            }
        }
        require(done > 0, "Nothing liquidated");

        // Everything is paid in ETH: unwrap whatever WETH the profit swaps produced.
        uint256 weth = IERC20(WETH).balanceOf(address(this));
        if (weth > 0) IWETH(WETH).withdraw(weth);

        uint256 after_ = address(this).balance;
        require(after_ >= before_ + bidAmount, "Profit below bid");

        (bool ok,) = executionEnvironment.call{value: bidAmount}("");
        require(ok, "Bid transfer failed");

        // Approve Atlas to charge this operation's gas to the bonded balance.
        (uint256 gasLiability, uint256 borrowLiability) = IAtlas(ATLAS).shortfall();
        uint256 nativeRepayment = borrowLiability < msg.value ? borrowLiability : msg.value;
        IAtlas(ATLAS).reconcile{value: nativeRepayment}(gasLiability);

        emit BidPaid(executionEnvironment, bidAmount, after_ - before_, done, items.length - done);
    }

    // ── One liquidation ──────────────────────────────────────────────────────

    // External only so atlasSolverCall can wrap it in try/catch.
    function runItem(Item calldata it) external {
        require(msg.sender == address(this), "Self only");
        require(it.debtToCover > 0 && it.debtToCover != type(uint256).max, "Bad amount");
        if (it.collateralAsset != it.debtAsset) require(it.swapPath.length >= 43, "No swap path");

        _inItem = true;
        IAaveFlashPool(AAVE_POOL).flashLoanSimple(
            address(this), it.debtAsset, it.debtToCover, abi.encode(it), 0
        );
        _inItem = false;
    }

    function executeOperation(
        address asset,
        uint256 amount,
        uint256 premium,
        address initiator,
        bytes calldata rawParams
    ) external returns (bool) {
        require(_inItem,                 "Not mid-item");
        require(msg.sender == AAVE_POOL, "Only Aave Pool");
        require(initiator == address(this), "Only self-initiated");

        Item memory p = abi.decode(rawParams, (Item));
        require(asset == p.debtAsset, "Asset mismatch");

        // Entry balance already includes the flashloaned `amount`.
        uint256 debtBefore = IERC20(p.debtAsset).balanceOf(address(this));

        uint256 colReceived = _liquidateAndSell(p);

        // Profit is measured on the delta, exactly as in AaveLiquidator: prior
        // balances of the debt token must not be able to cover a losing swap.
        // (debtBefore - amount) is what we held beforehand; the swap must restore
        // that plus the flashloan principal and premium: debtBefore + premium.
        uint256 required = debtBefore + premium;
        uint256 debtBal  = IERC20(p.debtAsset).balanceOf(address(this));
        require(debtBal >= required, "Unprofitable");
        uint256 profit = debtBal - required;

        // Flashloan repayment is authorised first, so the profit swap below can
        // never spend the tokens Aave is about to pull.
        _safeApprove(IERC20(p.debtAsset), AAVE_POOL, amount + premium);
        _swapProfit(p, profit);

        emit ItemLiquidated(p.borrower, p.collateralAsset, p.debtAsset, amount, profit, colReceived);
        return true;
    }

    // liquidationCall, then collateral -> debt through Uniswap V3.
    function _liquidateAndSell(Item memory p) private returns (uint256 colReceived) {
        uint256 colBefore = IERC20(p.collateralAsset).balanceOf(address(this));

        _safeApprove(IERC20(p.debtAsset), AAVE_POOL, p.debtToCover);
        IAaveLiquidationPool(AAVE_POOL).liquidationCall(
            p.collateralAsset, p.debtAsset, p.borrower, p.debtToCover, false
        );
        _safeApprove(IERC20(p.debtAsset), AAVE_POOL, 0);

        colReceived = IERC20(p.collateralAsset).balanceOf(address(this)) - colBefore;

        if (p.collateralAsset != p.debtAsset) {
            require(colReceived > 0, "No collateral");
            _safeApprove(IERC20(p.collateralAsset), SWAP_ROUTER, colReceived);
            ISwapRouter(SWAP_ROUTER).exactInput(ISwapRouter.ExactInputParams({
                path:             p.swapPath,
                recipient:        address(this),
                amountIn:         colReceived,
                amountOutMinimum: p.amountOutMinimum
            }));
            _safeApprove(IERC20(p.collateralAsset), SWAP_ROUTER, 0);
        }
    }

    // Turn the profit into WETH so it can be unwrapped and bid in ETH. Best
    // effort: if it fails the profit simply stays in the debt token, and the
    // aggregate "Profit below bid" check decides whether that is acceptable.
    function _swapProfit(Item memory p, uint256 profit) private {
        if (profit == 0 || p.debtAsset == WETH || p.profitPath.length < 43) return;
        _safeApprove(IERC20(p.debtAsset), SWAP_ROUTER, profit);
        try ISwapRouter(SWAP_ROUTER).exactInput(ISwapRouter.ExactInputParams({
            path:             p.profitPath,
            recipient:        address(this),
            amountIn:         profit,
            amountOutMinimum: 0
        })) {} catch {}
        _safeApprove(IERC20(p.debtAsset), SWAP_ROUTER, 0);
    }

    // ── Housekeeping ─────────────────────────────────────────────────────────

    function _safeApprove(IERC20 token, address spender, uint256 value) private {
        if (value != 0 && token.allowance(address(this), spender) != 0) {
            token.approve(spender, 0);
        }
        token.approve(spender, value);
    }

    function withdraw(address token) external onlyOwner {
        uint256 bal = IERC20(token).balanceOf(address(this));
        require(bal > 0, "Nothing to withdraw");
        // Low-level call so tokens that return no bool (USDT-style) still work.
        (bool ok, bytes memory data) = token.call(
            abi.encodeWithSignature("transfer(address,uint256)", owner, bal)
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
