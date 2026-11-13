// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {EnumerableSet} from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ERC4626Upgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC4626Upgradeable.sol";
import {PausableUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import {AccessControlUpgradeable} from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {ShareLockLib} from "./ShareLockLib.sol";

/**
 * @title MceVault
 * @notice 基于 Pharos R25 SyncVault 改造的 ERC4626 时间锁 Vault
 * @dev 与 SyncVault 的差异：
 *      1. 用户存入的资产**留在本合约**，不再自动转给托管地址；由 controller 通过
 *         {withdrawToCustodian} 主动提取到 admin 设定的 {custodianWallet}，{depositFromCustodian}
 *         主动回款，两者都发事件供后端监听。RWA 质押腿已移除，两个方法只搬底层资产，
 *         链下的 RWA 配置与本合约无关。
 *      2. 取消 payer 机制：赎回资金全部由 Vault 自身余额支付；余额或每日额度不足时
 *         该笔赎回进入提现队列，等待 Vault 补充流动性后由 {fulfillPendingWithdrawals} 兑付。
 *      3. NAV 推送逻辑与 SyncVault 一致（Oracle Reporter 每日递增上报）。
 *      4. 底层资产为任意 ERC20，由 initialize 传入地址；share 的 name / symbol 也由 initialize 传入，
 *         decimals 直接跟随底层资产（读其 decimals()，读不到则按 ERC4626 默认的 18 位）。
 *      5. 申购加 KYT 审核，上报与执行分离：{deposit} / {mint} 只收资产、按当时 NAV 锁定
 *         份额，不铸造；KYT_REPORTER_ROLE 调 {submitKytResult} 上报结论（执行前可改判），
 *         CONTROLLER 调 {executeDeposit} 按最后一次结论逐笔执行——通过则铸份额，
 *         不通过则原路退款并把付款人与接收人一并写入 {depositBlacklist}，之后不能再申购。
 *         因此 {deposit} 不再满足 ERC-4626「申购当场发份额」的承诺。
 *      6. 申购与赎回各有一个独立开关（{isDepositEnabled} / {isRedeemEnabled}），与暂停正交：
 *         暂停停全部，这两个开关各停一边。
 *      7. 可选的地址白名单：是否启用在 {initialize} 时一次性确定，之后不可更改。启用后
 *         申购、share 转账的相关地址都必须在 {isWhitelisted} 名单内，赎回不受名单限制；
 *         申购后、执行前被移出名单的，{executeDeposit} 时即使 KYT 通过也只退款、不拉黑。
 *
 *      Share 锁定机制沿用 SyncVault：每个地址维护一条按 unlockTime 升序的链表，
 *      同一结算日窗口内的多笔认购合并进同一节点，跨窗口的认购各占一个节点，
 *      赎回与转账均按 FIFO（最早解锁优先）消耗，转账时 unlockTime 随 share 转移。
 *
 * @dev 构造函数只调 _disableInitializers()，故放行 oz-upgrades 的构造函数检查。
 * @custom:oz-upgrades-unsafe-allow constructor
 */
contract MceVault is
    Initializable,
    PausableUpgradeable,
    AccessControlUpgradeable,
    ERC4626Upgradeable,
    UUPSUpgradeable
{
    using SafeERC20 for IERC20;
    using Math for uint256;
    using SafeCast for uint256;
    using EnumerableSet for EnumerableSet.UintSet;
    using EnumerableSet for EnumerableSet.AddressSet;

    /* ---------------------------------------------------------------- 角色 */

    /// @notice 运营角色：参数配置、暂停、队列调度
    bytes32 public constant CONTROLLER = keccak256("CONTROLLER");

    /// @notice NAV 上报角色
    bytes32 public constant ORACLE_REPORTER_ROLE = keccak256("ORACLE_REPORTER_ROLE");

    /// @notice KYT 结论上报角色：只写审核结果，不动资金
    bytes32 public constant KYT_REPORTER_ROLE = keccak256("KYT_REPORTER_ROLE");

    /* ---------------------------------------------------------------- 常量 */

    uint64 public constant FEE_PRECISION = 10 ** 6;
    uint64 public constant NAV_PRECISION = 10 ** 13;
    /// @notice 单次批量兑付的最大请求数，防止 gas 超限
    uint256 public constant MAX_REQUEST_BATCH = 50;
    /// @notice 手续费上限 1%（FEE_PRECISION 为 1e6）
    uint64 public constant MAX_FEE_BPS = 10 ** 4;
    /// @notice 解锁链表的头/尾哨兵
    uint64 public constant GUARD = 0;

    /* ---------------------------------------------------------------- 事件 */

    event OracleReportHandled(
        uint64 accountingTimestamp,
        uint64 reportId,
        uint256 totalShares,
        uint256 preNav,
        uint256 latestNav,
        uint256 totalFeeCollected,
        address reporter
    );

    event CustomDeposit(
        address indexed caller,
        address indexed receiver,
        uint256 assets,
        uint256 shares,
        uint256 fee
    );

    /// @param requestId 0 表示即时兑付，>0 表示已进入提现队列
    event CustomWithdraw(
        address indexed caller,
        address indexed receiver,
        address indexed owner,
        uint256 assets,
        uint256 shares,
        uint256 fee,
        uint256 requestId
    );

    /// @notice share 铸造/转账/销毁时携带的锁定信息
    event TransferShares(
        address indexed sender,
        address indexed receiver,
        uint256 shares,
        uint64 unlockTime
    );

    /// @notice controller 从 Vault 取出底层资产到 custodianWallet（挪去链下配置 RWA）
    event AssetWithdrawnToCustodian(
        address indexed operator,
        address indexed to,
        uint256 assets,
        uint256 vaultBalanceAfter,
        uint256 pendingWithdrawals
    );

    /// @notice controller 向 Vault 回款底层资产（补充赎回流动性）
    event AssetDepositedFromCustodian(
        address indexed operator,
        address indexed from,
        uint256 assets,
        uint256 vaultBalanceAfter,
        uint256 pendingWithdrawals
    );

    /// @notice admin 增删地址白名单
    event WhitelistUpdated(address indexed account, bool allowed);

    /// @notice 用户申购，资产已收进 Vault 但份额尚未铸造，等待链下 KYT 结果
    event DepositRequested(
        uint256 indexed depositId,
        address indexed caller,
        address indexed receiver,
        uint256 assets,
        uint256 shares,
        uint256 fee
    );

    /// @notice KYT 结论上报，执行前可覆盖，每次提交都发一条
    event KytResultSubmitted(uint256 indexed depositId, bool passed, address reporter);

    /// @notice CONTROLLER 按 KYT 结论执行申购：passed = true 铸份额，false 退资产并拉黑
    event DepositExecuted(
        uint256 indexed depositId,
        address indexed receiver,
        bool passed,
        uint256 assets,
        uint256 shares,
        address operator
    );

    /// @notice KYT 黑名单变更，KYT 拒绝时自动加入，admin 可手工增删
    event DepositBlacklistUpdated(address indexed account, bool blocked);

    event WithdrawalRequested(
        uint256 indexed requestId,
        address indexed requestor,
        address indexed recipient,
        address owner,
        uint256 timestamp,
        uint256 amountToWithdraw
    );

    event WithdrawalFulfilled(
        uint256 indexed requestId,
        address indexed requestor,
        address indexed recipient,
        address owner,
        uint256 timestamp,
        uint256 amountToWithdraw
    );

    event RequestIdChanged(uint256 preRequestId, uint256 newRequestId);

    /// @notice admin 变更提款目标地址
    event CustodianWalletUpdated(address preWallet, address newWallet);

    /// @notice controller 把已计提的手续费提到 custodianWallet
    event FeesWithdrawn(
        address indexed operator,
        address indexed to,
        uint256 assets,
        uint256 totalFeesWithdrawn,
        uint256 vaultBalanceAfter
    );

    enum ConfigType {
        MAX_DEPOSIT_LIMIT,
        MAX_SUPPLY,
        MIN_DEPOSIT_LIMIT,
        MIN_REDEEM_LIMIT,
        DEPOSIT_FEE_BPS,
        WITHDRAW_FEE_BPS,
        MAX_FLUCTUATION_BPS,
        DAILY_INSTANT_WITHDRAW_QUOTA,
        MATURITY_PERIOD
    }

    event ConfigUpdated(uint256 preValue, uint256 newValue, ConfigType indexed configType);

    event ToggleReceiverEqSender(bool isEnable);

    /// @notice admin 开关用户之间的 share 转账
    event ToggleShareTransferable(bool isEnable);

    /// @notice controller 开关申购
    event ToggleDepositEnabled(bool isEnable);

    /// @notice controller 开关赎回
    event ToggleRedeemEnabled(bool isEnable);

    /* ---------------------------------------------------------------- 错误 */

    error InvalidInput();
    error ExceededMaxSupply(address receiver, uint256 assets, uint256 maxSupply);
    error BelowMinDeposit(address receiver, uint256 assets, uint256 minLimit);
    error BelowMinRedeem(uint256 shares, uint256 minLimit);
    error InsufficientUnlockedShares(uint256 shares, uint256 sharesUnlocked);
    error InvalidReport(uint64 accountingTimestamp, uint64 reportId);
    error InvalidAccountingTimestamp(uint64 blockTimestamp, uint64 accountingTimestamp);
    error InvalidNavFluctuation(uint256 reportedNav, uint256 currentNav, uint256 maxFluctuationBps);
    error SharesAmountError(address owner, uint256 requested, uint256 remaining);
    error InvalidReceiver(address expected, address actual);
    error ZeroResult();
    /// @notice Vault 余额不足以兑付指定请求
    error InsufficientLiquidity(uint256 balance, uint256 required);
    error InvalidRequestId(uint256 requestId);
    error ReentrantCall();
    /// @notice 提费金额超出"已计提未提取"的额度
    error ExceededCollectedFees(uint256 requested, uint256 withdrawable);
    /// @notice share 转账开关已关闭
    error ShareTransferDisabled();
    /// @notice 申购开关已关闭
    error DepositDisabled();
    /// @notice 赎回开关已关闭
    error RedeemDisabled();
    /// @notice 白名单已启用，但该地址不在名单内
    error NotWhitelisted(address account);
    /// @notice 地址在 KYT 黑名单内，不允许申购
    error DepositBlacklisted(address account);
    error InvalidDepositId(uint256 depositId);
    /// @notice 该申购已执行，结论与执行都不可再变更
    error DepositAlreadyExecuted(uint256 depositId);
    /// @notice KYT 结论还没上报，不能执行
    error KytResultPending(uint256 depositId);

    /* ---------------------------------------------------------------- 存储 */

    /// @dev 重入守卫状态：0/1 = 未进入，2 = 已进入。
    ///      OZ v5.6 移除了 ReentrancyGuardUpgradeable，而 ReentrancyGuard 带构造函数、
    ///      不被 oz-upgrades 插件接受，因此就地实现。
    uint256 private _reentrancyStatus;

    modifier nonReentrant() {
        if (_reentrancyStatus == 2) {
            revert ReentrantCall();
        }
        _reentrancyStatus = 2;
        _;
        _reentrancyStatus = 1;
    }

    uint256 public latestNav;

    /// @notice 累计计提的申购 + 赎回费，只增不减
    uint256 public totalFeesCollected;

    /// @notice 累计已通过 {withdrawFees} 提走的手续费，两者之差即当前可提额度
    uint256 public totalFeesWithdrawn;

    uint256 public maturityPeriod;
    uint256 public maxSupply;
    uint256 public maxDepositLimit;
    uint256 public minDepositLimit;
    uint256 public minRedeemLimit;
    uint256 public maxFluctuationBps;
    uint256 public depositFeeBps;
    uint256 public withdrawFeeBps;
    uint256 public lastAccountingTimestamp;
    uint256 public lastReportId;
    uint256 public walletDailyInstantWithdrawQuota;

    /// @notice 队列中尚未兑付的资产总额，即 Vault 已承诺支付的负债
    uint256 public totalPendingWithdrawals;

    bool public isReceiverEqSender;

    /// @notice 是否允许用户之间转账 share；关闭时只有申购铸造和赎回销毁能动余额
    bool public isShareTransferable;

    /// @notice {withdrawToCustodian} 和 {withdrawFees} 的固定收款地址，只能由 DEFAULT_ADMIN_ROLE 设置
    address public custodianWallet;

    struct ReportData {
        // 链下会计日
        uint64 accountingTimestamp;
        // 链下提交时刻，仅记录
        uint64 submitTimestamp;
        // 报告序号，从 1 开始严格递增
        uint64 reportId;
        uint256 todayNav;
        // 提交者，仅记录
        address reporter;
    }

    struct UserDailyWithdrawQuotaInfo {
        uint256 remainingQuota;
        uint64 dayTimestamp;
    }

    mapping(address => UserDailyWithdrawQuotaInfo) public userDailyWithdrawQuota;

    /// @dev 锁定期链表的三个 mapping 已迁到 {ShareLockLib} 的固定 slot（见该库的说明），
    ///      不再占用本合约的顺序 storage 布局。

    struct WithdrawalRequest {
        uint256 amount;
        address requestor;
        address recipient;
        address owner;
        uint40 timestamp;
        bool fulfilled;
    }

    /// @notice 提现队列，requestId 从 1 开始
    mapping(uint256 => WithdrawalRequest) internal _queue;

    /// @notice 队尾 requestId，0 表示队列为空
    uint256 public lastRequestId;

    /// @notice 已顺序推进到的 requestId，{fulfillPendingWithdrawals} 从其下一个开始扫描
    uint256 public lastProcessedRequestId;

    mapping(address => EnumerableSet.UintSet) internal _requestsByOwner;

    /// @notice KYT 结论：None = 尚未上报，Passed / Rejected = 已上报
    enum KytStatus {
        None,
        Passed,
        Rejected
    }

    struct PendingDeposit {
        // 用户付进来的资产总额（含申购费）
        uint256 assets;
        // 申购时按当时 NAV 锁定的份额，审核通过即铸这个数
        uint256 shares;
        uint256 fee;
        // 付款人，也是审核不通过时的退款收款人
        address caller;
        // 份额接收人
        address receiver;
        uint40 timestamp;
        // KYT 结论，执行前可被 {submitKytResult} 覆盖
        KytStatus kytStatus;
        // 是否已被 {executeDeposit} 处理，终态标志
        bool executed;
    }

    /// @notice 待 KYT 审核 / 待执行的申购，depositId 从 1 开始
    mapping(uint256 => PendingDeposit) public pendingDeposits;

    /// @notice 最新申购单号，0 表示还没有人申购
    uint256 public lastDepositId;

    /// @notice 待审核申购占用的资产总额，不属于 Vault 可用流动性
    uint256 public totalPendingDepositAssets;

    /// @notice 待审核申购已锁定的份额总额，计入 {maxSupply} 校验
    uint256 public totalPendingDepositShares;

    /// @notice KYT 黑名单，命中的地址不能再申购
    mapping(address => bool) public depositBlacklist;

    /// @notice 申购总开关，关闭时 {deposit} / {mint} 一律 revert
    bool public isDepositEnabled;

    /// @notice 赎回总开关，关闭时 {redeem} / {withdraw} 一律 revert
    bool public isRedeemEnabled;

    /// @notice 是否启用地址白名单，{initialize} 时一次性确定，之后不可更改
    bool public isWhitelistEnabled;

    /// @notice 地址白名单，仅在 {isWhitelistEnabled} 为 true 时生效，由 DEFAULT_ADMIN_ROLE 维护
    EnumerableSet.AddressSet internal _whitelist;

    /// @notice 最后一个会计日之前那天的 NAV，修改最后一天时作为波动校验基准
    uint256 internal _prevNav;

    constructor() {
        _disableInitializers();
    }

    /**
     * @notice 初始化 Vault
     * @param admin DEFAULT_ADMIN_ROLE 持有者，负责设置 {custodianWallet} 与地址白名单
     * @param asset_ 底层资产 ERC20 地址，任意小数位；限额类默认值按其 decimals 折算
     * @param custodianWallet_ {withdrawToCustodian} 的固定收款地址
     * @param maturityPeriod_ 锁定期，必须是整天；允许为 0，此时新份额铸出即可赎回
     * @param shareTransferable_ 是否允许用户之间转账 share，上线后 admin 可用 {setShareTransferable} 改
     * @param whitelistEnabled_ 是否启用地址白名单，**只能在此设置一次，之后不可更改**
     * @param maxSupply_ 份额总量上限，按份额最小单位计
     * @param maxDepositLimit_ 单笔申购上限，按资产最小单位计
     * @param minDepositLimit_ 单笔申购下限，按资产最小单位计，不能为 0
     * @param minRedeemLimit_ 单笔赎回下限，按份额最小单位计，不能为 0
     * @param depositEnabled_ 申购开关初始状态
     * @param redeemEnabled_ 赎回开关初始状态
     * @param tokenName share token 名称
     * @param tokenSymbol share token 符号
     */
    function initialize(
        address admin,
        address asset_,
        address custodianWallet_,
        uint64 maturityPeriod_,
        bool shareTransferable_,
        bool whitelistEnabled_,
        uint256 maxSupply_,
        uint256 maxDepositLimit_,
        uint256 minDepositLimit_,
        uint256 minRedeemLimit_,
        bool depositEnabled_,
        bool redeemEnabled_,
        string calldata tokenName,
        string calldata tokenSymbol
    ) public initializer {
        if (
            admin == address(0) ||
            asset_ == address(0) ||
            custodianWallet_ == address(0) ||
            // 与 setMaturityPeriod 对齐：允许 0，只要求整天
            maturityPeriod_ % 1 days != 0 ||
            // 与 setMinDepositLimit / setMinRedeemLimit 对齐
            minDepositLimit_ == 0 ||
            minRedeemLimit_ == 0
        ) {
            revert InvalidInput();
        }

        __Pausable_init();
        __AccessControl_init();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        __ERC20_init(tokenName, tokenSymbol);
        __ERC4626_init(IERC20(asset_));

        // decimals() 由 __ERC4626_init 从底层资产读取（读不到则回落 18），share 与资产同精度
        uint256 unit = 10 ** decimals();

        maturityPeriod = maturityPeriod_;
        custodianWallet = custodianWallet_;
        latestNav = NAV_PRECISION;
        maxDepositLimit = maxDepositLimit_;
        maxSupply = maxSupply_;
        minDepositLimit = minDepositLimit_;
        minRedeemLimit = minRedeemLimit_;
        maxFluctuationBps = 10 ** 5;
        walletDailyInstantWithdrawQuota = 10_000 * unit;
        isReceiverEqSender = true;
        isShareTransferable = shareTransferable_;
        isWhitelistEnabled = whitelistEnabled_;
        isDepositEnabled = depositEnabled_;
        isRedeemEnabled = redeemEnabled_;
    }

    /* ------------------------------------------------------- ERC4626 定价 */

    /**
     * @notice 按 NAV 计算的总资产
     * @dev 不是 Vault 实际持有的资产余额（那部分见 {vaultBalance}），
     *      而是 totalSupply × NAV 得出的资产负债口径估值。
     */
    function totalAssets() public view virtual override returns (uint256) {
        uint256 shares = totalSupply();
        if (shares == 0) {
            return 0;
        }
        return convertToAssets(shares);
    }

    function convertToShares(uint256 assets) public view override returns (uint256) {
        return _convertToShares(assets, Math.Rounding.Floor);
    }

    function convertToAssets(uint256 shares) public view override returns (uint256) {
        return _convertToAssets(shares, Math.Rounding.Floor);
    }

    function maxDeposit(address) public view override returns (uint256) {
        uint256 supply = totalSupply() + totalPendingDepositShares;
        if (supply >= maxSupply) {
            return 0;
        }
        uint256 remainShares = maxSupply - supply;
        uint256 effectiveAssets = _convertToAssets(remainShares, Math.Rounding.Ceil);
        uint256 remainAssets = effectiveAssets.mulDiv(
            FEE_PRECISION,
            FEE_PRECISION - depositFeeBps,
            Math.Rounding.Floor
        );
        return Math.min(remainAssets, maxDepositLimit);
    }

    function maxMint(address) public view override returns (uint256) {
        uint256 supply = totalSupply() + totalPendingDepositShares;
        if (supply >= maxSupply) {
            return 0;
        }
        uint256 fee = maxDepositLimit.mulDiv(depositFeeBps, FEE_PRECISION, Math.Rounding.Ceil);
        uint256 netAssets = maxDepositLimit - fee;
        uint256 maxMintAmount = _convertToShares(netAssets, Math.Rounding.Floor);
        return Math.min(maxMintAmount, maxSupply - supply);
    }

    /**
     * @return remaining 剩余可认购份额 = maxSupply − used，已占满时返回 0
     * @return used 已占用份额 = 已认购（totalSupply）+ 待审核申购锁定的份额，{maxSupply} 不能低于此值
     */
    function getSupplyInfo() external view returns (uint256 remaining, uint256 used) {
        used = totalSupply() + totalPendingDepositShares;
        remaining = used >= maxSupply ? 0 : maxSupply - used;
    }

    /// @dev 只受解锁进度约束，不受 Vault 当前流动性约束：流动性不足时赎回会进入队列而非 revert
    function maxWithdraw(address owner) public view override returns (uint256) {
        uint256 unlockedBalance = getAvailableShares(owner, uint64(block.timestamp));
        uint256 grossAssets = _convertToAssets(unlockedBalance, Math.Rounding.Floor);
        return grossAssets.mulDiv(FEE_PRECISION - withdrawFeeBps, FEE_PRECISION, Math.Rounding.Floor);
    }

    function maxRedeem(address owner) public view override returns (uint256) {
        return getAvailableShares(owner, uint64(block.timestamp));
    }

    /// @dev 4 个标准 preview 一律转调下面的 WithFee 版本，避免同一套算式编译进两份字节码
    function previewDeposit(uint256 assets) public view override returns (uint256) {
        (uint256 shares, ) = previewDepositWithFee(assets);
        return shares;
    }

    /// @return shares 可获得份数
    /// @return fee 申购费
    function previewDepositWithFee(uint256 assets) public view returns (uint256, uint256) {
        uint256 fee = assets.mulDiv(depositFeeBps, FEE_PRECISION, Math.Rounding.Ceil);
        return (_convertToShares(assets - fee, Math.Rounding.Floor), fee);
    }

    function previewMint(uint256 shares) public view override returns (uint256) {
        (uint256 assets, ) = previewMintWithFee(shares);
        return assets;
    }

    /// @return assets 所需资产
    /// @return fee 申购费
    function previewMintWithFee(uint256 shares) public view returns (uint256, uint256) {
        uint256 effectiveAssets = _convertToAssets(shares, Math.Rounding.Ceil);
        uint256 expectAssets = effectiveAssets.mulDiv(
            FEE_PRECISION,
            FEE_PRECISION - depositFeeBps,
            Math.Rounding.Ceil
        );
        return (expectAssets, expectAssets - effectiveAssets);
    }

    function previewWithdraw(uint256 assets) public view override returns (uint256) {
        (uint256 shares, ) = previewWithdrawWithFee(assets);
        return shares;
    }

    /// @return shares 需销毁份数
    /// @return fee 赎回费
    function previewWithdrawWithFee(uint256 assets) public view returns (uint256, uint256) {
        uint256 actualAssets = assets.mulDiv(
            FEE_PRECISION,
            FEE_PRECISION - withdrawFeeBps,
            Math.Rounding.Ceil
        );
        return (_convertToShares(actualAssets, Math.Rounding.Ceil), actualAssets - assets);
    }

    function previewRedeem(uint256 shares) public view override returns (uint256) {
        (uint256 assets, ) = previewRedeemWithFee(shares);
        return assets;
    }

    /// @return assets 可得资产
    /// @return fee 赎回费
    function previewRedeemWithFee(uint256 shares) public view returns (uint256, uint256) {
        uint256 assets = _convertToAssets(shares, Math.Rounding.Floor);
        uint256 fee = assets.mulDiv(withdrawFeeBps, FEE_PRECISION, Math.Rounding.Ceil);
        return (assets - fee, fee);
    }

    /* ----------------------------------------------------------- 申购赎回 */

    /**
     * @notice 存入资产申购，资产留在本合约，份额等 KYT 审核通过后才铸造
     * @dev 与 SyncVault 的两处不同：资产不再自动转给托管地址；份额不再当场铸造，
     *      而是按当时 NAV 锁定数量记入 {pendingDeposits}，由 {executeDeposit} 兑现或退款。
     * @return shares 审核通过后将铸造的份额（不是当场到账余额）
     */
    function deposit(
        uint256 assets,
        address receiver
    ) public override nonReentrant whenNotPaused returns (uint256) {
        if (isReceiverEqSender && receiver != _msgSender()) {
            revert InvalidReceiver(_msgSender(), receiver);
        }
        if (assets < minDepositLimit) {
            revert BelowMinDeposit(receiver, assets, minDepositLimit);
        }
        if (assets > maxDepositLimit) {
            revert ERC4626ExceededMaxDeposit(receiver, assets, maxDepositLimit);
        }

        (uint256 shares, uint256 fee) = previewDepositWithFee(assets);
        _requestDeposit(receiver, assets, shares, fee);
        return shares;
    }

    /// @notice 按精确份数申购，同样要过 KYT 才铸造
    /// @return assets 需支付并已扣走的资产总额
    function mint(
        uint256 shares,
        address receiver
    ) public override nonReentrant whenNotPaused returns (uint256) {
        if (isReceiverEqSender && receiver != _msgSender()) {
            revert InvalidReceiver(_msgSender(), receiver);
        }

        (uint256 assets, uint256 fee) = previewMintWithFee(shares);
        if (assets < minDepositLimit) {
            revert BelowMinDeposit(receiver, assets, minDepositLimit);
        }
        if (assets > maxDepositLimit) {
            revert ERC4626ExceededMaxDeposit(receiver, assets, maxDepositLimit);
        }

        _requestDeposit(receiver, assets, shares, fee);
        return assets;
    }

    /**
     * @dev 收资产、锁份额、挂起等审核。份额按申购时点的 NAV 锁定，
     *      审核期间 NAV 变动不影响已锁定的份数（KYT 预计 30 秒内出结果）。
     */
    function _requestDeposit(
        address receiver,
        uint256 assets,
        uint256 shares,
        uint256 fee
    ) internal {
        if (!isDepositEnabled) {
            revert DepositDisabled();
        }
        if (depositBlacklist[_msgSender()]) {
            revert DepositBlacklisted(_msgSender());
        }
        if (depositBlacklist[receiver]) {
            revert DepositBlacklisted(receiver);
        }
        _checkWhitelisted(_msgSender());
        _checkWhitelisted(receiver);
        if (shares == 0) {
            revert ZeroResult();
        }
        // 待审核份额同样占用额度，避免多笔挂起同时通过后突破上限
        if (totalSupply() + totalPendingDepositShares + shares > maxSupply) {
            revert ExceededMaxSupply(receiver, shares, maxSupply);
        }

        IERC20(asset()).safeTransferFrom(_msgSender(), address(this), assets);

        uint256 depositId = ++lastDepositId;
        pendingDeposits[depositId] = PendingDeposit({
            assets: assets,
            shares: shares,
            fee: fee,
            caller: _msgSender(),
            receiver: receiver,
            timestamp: uint40(block.timestamp),
            kytStatus: KytStatus.None,
            executed: false
        });
        totalPendingDepositAssets += assets;
        totalPendingDepositShares += shares;

        emit DepositRequested(depositId, _msgSender(), receiver, assets, shares, fee);
    }

    /**
     * @notice 上报链下 KYT 结论，只写状态、不动资金
     * @dev 执行前可反复覆盖（含 Passed ⇄ Rejected 改判），每次都发事件留痕；
     *      {executeDeposit} 执行后即为终态，再提交一律 revert。
     *      谁最后提交谁生效，CONTROLLER 执行时读的是最后一次结论。
     * @param depositId {DepositRequested} 里的申购单号
     * @param passed KYT 是否通过
     */
    function submitKytResult(
        uint256 depositId,
        bool passed
    ) external onlyRole(KYT_REPORTER_ROLE) {
        if (depositId == 0 || depositId > lastDepositId) {
            revert InvalidDepositId(depositId);
        }
        PendingDeposit storage request = pendingDeposits[depositId];
        if (request.executed) {
            revert DepositAlreadyExecuted(depositId);
        }

        request.kytStatus = passed ? KytStatus.Passed : KytStatus.Rejected;
        emit KytResultSubmitted(depositId, passed, _msgSender());
    }

    /**
     * @notice 按已上报的 KYT 结论执行申购：通过则铸份额，不通过则退款并把相关地址拉黑
     * @dev 一笔交易只处理一个单号。份额的锁定期从本次铸造时点起算。
     *      故意不加 {whenNotPaused}：暂停期间钱已经收在 Vault 里，必须留出退款/兑现的通道。
     *      白名单启用时，KYT 通过但付款人或 receiver 已被移出名单的，只退款不拉黑；
     *      {DepositExecuted} 的 passed 记为 false，申购单的 kytStatus 仍为 Passed，据此与 KYT 拒绝区分
     * @param depositId {DepositRequested} 里的申购单号
     */
    function executeDeposit(uint256 depositId) external nonReentrant onlyRole(CONTROLLER) {
        if (depositId == 0 || depositId > lastDepositId) {
            revert InvalidDepositId(depositId);
        }
        PendingDeposit storage request = pendingDeposits[depositId];
        if (request.executed) {
            revert DepositAlreadyExecuted(depositId);
        }
        KytStatus status = request.kytStatus;
        if (status == KytStatus.None) {
            revert KytResultPending(depositId);
        }

        uint256 assets = request.assets;
        uint256 shares = request.shares;
        address caller = request.caller;
        address receiver = request.receiver;

        request.executed = true;
        totalPendingDepositAssets -= assets;
        totalPendingDepositShares -= shares;

        bool passed = status == KytStatus.Passed;
        if (!passed) {
            _blacklist(receiver);
            _blacklist(caller);
        } else if (isWhitelistEnabled && !(_whitelist.contains(caller) && _whitelist.contains(receiver))) {
            // 申购后被移出白名单：白名单管入口，不再给它铸份额，直接退款；不是 KYT 问题，不拉黑
            passed = false;
        }
        if (passed) {
            _mint(receiver, shares);
            totalFeesCollected += request.fee;
            emit Deposit(caller, receiver, assets, shares);
            emit CustomDeposit(caller, receiver, assets, shares, request.fee);
        } else {
            IERC20(asset()).safeTransfer(caller, assets);
        }

        emit DepositExecuted(depositId, receiver, passed, assets, shares, _msgSender());
    }

    /// @notice admin 手工增删 KYT 黑名单，用于误判解封或链下风控直接封禁
    function setDepositBlacklisted(
        address account,
        bool blocked
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (account == address(0) || depositBlacklist[account] == blocked) {
            revert InvalidInput();
        }
        depositBlacklist[account] = blocked;
        emit DepositBlacklistUpdated(account, blocked);
    }

    function _blacklist(address account) internal {
        if (!depositBlacklist[account]) {
            depositBlacklist[account] = true;
            emit DepositBlacklistUpdated(account, true);
        }
    }

    /**
     * @notice 赎回精确份数的 share
     * @dev share 立即销毁；资产由 Vault 自身余额支付，余额或每日额度不足则进入提现队列
     */
    function redeem(
        uint256 shares,
        address receiver,
        address owner
    ) public override nonReentrant whenNotPaused returns (uint256) {
        return _redeem(_msgSender(), shares, receiver, owner);
    }

    /**
     * @notice CONTROLLER 批量代用户赎回指定份额，钱打回用户本人
     * @dev 每个用户按 {redeem}(shares[i], 用户, 用户) 处理，规则完全一致：份额不能超过已解锁部分，
     *      任一用户不满足条件整批回滚；以用户本人身份发起，不消耗授权额度，
     *      事件与提现请求里的 caller / requestor 记为用户
     * @param owners 用户地址列表
     * @param shares 与 owners 一一对应的赎回份额，长度必须一致
     */
    function controllerRedeemUnlockedFor(
        address[] calldata owners,
        uint256[] calldata shares
    ) external nonReentrant whenNotPaused onlyRole(CONTROLLER) {
        if (owners.length != shares.length) {
            revert InvalidInput();
        }
        for (uint256 i = 0; i < owners.length; ++i) {
            address owner = owners[i];
            _redeem(owner, shares[i], owner, owner);
        }
    }

    function _redeem(
        address caller,
        uint256 shares,
        address receiver,
        address owner
    ) internal returns (uint256) {
        if (isReceiverEqSender && receiver != owner) {
            revert InvalidReceiver(owner, receiver);
        }
        if (shares < minRedeemLimit) {
            revert BelowMinRedeem(shares, minRedeemLimit);
        }

        uint256 sharesUnlocked = getAvailableShares(owner, uint64(block.timestamp));
        if (shares > sharesUnlocked) {
            revert InsufficientUnlockedShares(shares, sharesUnlocked);
        }

        (uint256 assetsAfterFee, uint256 fee) = previewRedeemWithFee(shares);
        if (assetsAfterFee == 0) {
            revert ZeroResult();
        }

        uint256 requestId = _customWithdraw(caller, receiver, owner, assetsAfterFee, shares);
        totalFeesCollected += fee;

        emit CustomWithdraw(caller, receiver, owner, assetsAfterFee, shares, fee, requestId);
        return assetsAfterFee;
    }

    /// @notice 取出精确数量的资产，销毁对应份数的 share
    function withdraw(
        uint256 assets,
        address receiver,
        address owner
    ) public override nonReentrant whenNotPaused returns (uint256) {
        if (isReceiverEqSender && receiver != owner) {
            revert InvalidReceiver(owner, receiver);
        }

        (uint256 sharesAfterFee, uint256 fee) = previewWithdrawWithFee(assets);
        if (sharesAfterFee < minRedeemLimit) {
            revert BelowMinRedeem(sharesAfterFee, minRedeemLimit);
        }

        uint256 sharesUnlocked = getAvailableShares(owner, uint64(block.timestamp));
        if (sharesAfterFee > sharesUnlocked) {
            revert InsufficientUnlockedShares(sharesAfterFee, sharesUnlocked);
        }

        uint256 requestId = _customWithdraw(_msgSender(), receiver, owner, assets, sharesAfterFee);
        totalFeesCollected += fee;

        emit CustomWithdraw(_msgSender(), receiver, owner, assets, sharesAfterFee, fee, requestId);
        return sharesAfterFee;
    }

    /* ------------------------------------------------- controller 资金存取 */

    /**
     * @notice controller 从 Vault 取出底层资产到 {custodianWallet}（用于链下配置 RWA）
     * @dev 分权：收款地址固定为 {custodianWallet}（只有 admin 能改），controller 只能决定金额。
     *      只保留待审核申购资金（KYT 不通过要原路退款），队列已承诺的部分仍可取。
     *      链下如何用这笔钱配置 RWA 与本合约无关，合约不做任何质押物记账。
     * @param assets 提取数量
     */
    // ponytail: 故意不做 totalPendingWithdrawals 保留校验（需求为"随意提取"）。
    // 若要禁止挪用队列资金，把下面的 balance 换成 availableLiquidity()
    function withdrawToCustodian(uint256 assets) external nonReentrant onlyRole(CONTROLLER) {
        if (assets == 0) {
            revert InvalidInput();
        }
        // 待审核申购的钱随时可能要退回用户，不能提走
        uint256 balance = _freeBalance();
        if (assets > balance) {
            revert InsufficientLiquidity(balance, assets);
        }
        address custodian = custodianWallet;

        IERC20(asset()).safeTransfer(custodian, assets);
        emit AssetWithdrawnToCustodian(
            _msgSender(),
            custodian,
            assets,
            vaultBalance(),
            totalPendingWithdrawals
        );
    }

    /**
     * @notice controller 把 {custodianWallet} 的底层资产回款到 Vault
     * @dev {withdrawToCustodian} 的反向操作。不铸造 share，纯粹补流动性。
     *      资金固定从 {custodianWallet} 扣，因此 custodianWallet 必须先对本合约 approve。
     * @param assets 回款数量
     */
    function depositFromCustodian(uint256 assets) external nonReentrant onlyRole(CONTROLLER) {
        if (assets == 0) {
            revert InvalidInput();
        }
        address custodian = custodianWallet;

        IERC20(asset()).safeTransferFrom(custodian, address(this), assets);

        emit AssetDepositedFromCustodian(
            _msgSender(),
            custodian,
            assets,
            vaultBalance(),
            totalPendingWithdrawals
        );
    }

    /**
     * @notice controller 把已计提的手续费提到 {custodianWallet}
     * @dev 与 {withdrawToCustodian} 的区别：这条路径受 {withdrawableFees} 额度约束，
     *      且**不需要押入 RWA**——提的是平台自己的手续费，不是用户本金。
     *      手续费本来就沉淀在 Vault 余额里（申购时全额入账只铸净额 share、赎回时少付费用），
     *      因此这里只是把它划走，不触碰任何份额或负债记账。
     * @param assets 提取数量，不得超过 {withdrawableFees}
     */
    // ponytail: 与 withdrawToCustodian 保持一致，只保留待审核申购资金，不做 totalPendingWithdrawals 保留校验。
    // 若要让队列优先，把下面的 balance 换成 availableLiquidity()
    function withdrawFees(uint256 assets) external nonReentrant onlyRole(CONTROLLER) {
        if (assets == 0) {
            revert InvalidInput();
        }
        uint256 withdrawable = withdrawableFees();
        if (assets > withdrawable) {
            revert ExceededCollectedFees(assets, withdrawable);
        }
        // 待审核申购的钱随时可能要退回用户，不能提走
        uint256 balance = _freeBalance();
        if (assets > balance) {
            revert InsufficientLiquidity(balance, assets);
        }

        totalFeesWithdrawn += assets;
        address to = custodianWallet;
        IERC20(asset()).safeTransfer(to, assets);

        emit FeesWithdrawn(
            _msgSender(),
            to,
            assets,
            totalFeesWithdrawn,
            vaultBalance()
        );
    }

    /// @notice 当前可提的手续费额度 = 累计计提 - 累计已提
    function withdrawableFees() public view returns (uint256) {
        return totalFeesCollected - totalFeesWithdrawn;
    }

    /// @notice Vault 实际持有的底层资产余额
    function vaultBalance() public view returns (uint256) {
        return IERC20(asset()).balanceOf(address(this));
    }

    /// @dev 实际余额扣掉待审核申购资金（KYT 拒绝时要原路退款），不足时为 0
    function _freeBalance() internal view returns (uint256) {
        uint256 balance = vaultBalance();
        uint256 pendingDepositAssets = totalPendingDepositAssets;
        return balance > pendingDepositAssets ? balance - pendingDepositAssets : 0;
    }

    /// @notice 可用于新的即时赎回的流动性 = 实际余额 - 队列已承诺待兑付金额 - 待审核申购金额
    function availableLiquidity() public view returns (uint256) {
        uint256 free = _freeBalance();
        uint256 pending = totalPendingWithdrawals;
        return free > pending ? free - pending : 0;
    }

    /* --------------------------------------------------------- 提现队列 */

    /**
     * @notice 按 FIFO 兑付队列中的提现请求，资金来自 Vault 自身余额
     * @dev 仅 CONTROLLER 可调用。单次最多处理 {MAX_REQUEST_BATCH} 笔；
     *      实际可用额度取 {budget} 与 Vault 余额的较小值，遇到额度不足的请求即停止，
     *      保持 FIFO 不被跳过。budget 传 0 直接 revert（0 不表示"不限额"，
     *      拒绝是为了避免调用方漏传参数时静默空跑）；需要不限额时传一个足够大的数。
     * @param budget 本批放款金额上限，底层资产精度，不能为 0
     */
    function fulfillPendingWithdrawals(
        uint256 budget
    ) external nonReentrant whenNotPaused onlyRole(CONTROLLER) {
        if (budget == 0) {
            revert InvalidInput();
        }
        // 待审核申购的钱随时可能要退回用户，不能拿来兑付队列
        uint256 free = _freeBalance();
        uint256 balance = budget < free ? budget : free;
        uint256 last = lastRequestId;
        uint256 processedTo = lastProcessedRequestId;
        uint256 count;

        for (uint256 i = processedTo + 1; i <= last && count < MAX_REQUEST_BATCH; i++) {
            WithdrawalRequest storage request = _queue[i];

            // 已被 skip 或单独兑付过，直接推进游标
            if (request.fulfilled) {
                processedTo = i;
                continue;
            }

            uint256 amount = request.amount;
            if (amount > balance) {
                break;
            }

            balance -= amount;
            request.fulfilled = true;
            totalPendingWithdrawals -= amount;
            _requestsByOwner[request.owner].remove(i);
            processedTo = i;

            IERC20(asset()).safeTransfer(request.recipient, amount);
            emit WithdrawalFulfilled(
                i,
                request.requestor,
                request.recipient,
                request.owner,
                block.timestamp,
                amount
            );
            count++;
        }

        if (processedTo != lastProcessedRequestId) {
            lastProcessedRequestId = processedTo;
        }
    }

    /**
     * @notice 不按队列顺序单独兑付指定请求
     * @param requestId 请求 ID
     */
    function fulfillSpecificRequest(
        uint256 requestId
    ) external nonReentrant whenNotPaused onlyRole(CONTROLLER) {
        _fulfillSpecificRequest(requestId);
    }

    /**
     * @notice 不按队列顺序批量兑付指定请求
     * @dev 逐笔按 {fulfillSpecificRequest} 的规则处理，任意一笔不合法或流动性不足
     *      都会让整批回滚——不存在部分成功。每笔都重新读一次余额，
     *      因此前面的放款会自然收紧后面可用的额度。
     * @param requestIds 请求 ID 列表，不能为空，长度不超过 {MAX_REQUEST_BATCH}
     */
    function fulfillSpecificRequests(
        uint256[] calldata requestIds
    ) external nonReentrant whenNotPaused onlyRole(CONTROLLER) {
        if (requestIds.length == 0 || requestIds.length > MAX_REQUEST_BATCH) {
            revert InvalidInput();
        }
        for (uint256 i = 0; i < requestIds.length; ++i) {
            _fulfillSpecificRequest(requestIds[i]);
        }
    }

    function _fulfillSpecificRequest(uint256 requestId) internal {
        if (requestId == 0 || requestId > lastRequestId) {
            revert InvalidRequestId(requestId);
        }
        WithdrawalRequest storage request = _queue[requestId];
        if (request.fulfilled) {
            revert InvalidInput();
        }

        uint256 amount = request.amount;
        uint256 balance = _freeBalance();
        if (balance < amount) {
            revert InsufficientLiquidity(balance, amount);
        }

        request.fulfilled = true;
        totalPendingWithdrawals -= amount;
        _requestsByOwner[request.owner].remove(requestId);

        IERC20(asset()).safeTransfer(request.recipient, amount);
        emit WithdrawalFulfilled(
            requestId,
            request.requestor,
            request.recipient,
            request.owner,
            block.timestamp,
            amount
        );
    }

    /**
     * @notice 把指定请求挪到队尾，用于疏通因收款地址异常（如被资产合约拉黑）而卡住队首的请求
     * @param requestId 请求 ID
     */
    function skipWithdrawalRequest(uint256 requestId) external onlyRole(CONTROLLER) {
        if (requestId == 0 || requestId > lastRequestId) {
            revert InvalidRequestId(requestId);
        }
        WithdrawalRequest storage request = _queue[requestId];
        if (request.fulfilled) {
            revert InvalidInput();
        }

        uint256 amount = request.amount;
        address requestor = request.requestor;
        address recipient = request.recipient;
        address owner = request.owner;

        request.fulfilled = true;
        _requestsByOwner[owner].remove(requestId);
        // 负债没有减少，只是换了个 requestId：先扣回再由 _enqueue 加上
        totalPendingWithdrawals -= amount;

        uint256 newRequestId = _enqueue(amount, requestor, recipient, owner);

        emit RequestIdChanged(requestId, newRequestId);
        emit WithdrawalFulfilled(requestId, requestor, recipient, owner, block.timestamp, 0);
    }

    /// @notice 查询指定请求的明细
    function getWithdrawalStatus(
        uint256[] calldata requestIds
    ) external view returns (WithdrawalRequest[] memory statuses) {
        statuses = new WithdrawalRequest[](requestIds.length);
        for (uint256 i = 0; i < requestIds.length; ++i) {
            if (requestIds[i] == 0 || requestIds[i] > lastRequestId) {
                revert InvalidRequestId(requestIds[i]);
            }
            statuses[i] = _queue[requestIds[i]];
        }
    }

    /// @notice 查询某地址所有未兑付的请求 ID
    function getWithdrawalRequests(address owner) external view returns (uint256[] memory) {
        return _requestsByOwner[owner].values();
    }

    function _enqueue(
        uint256 amount,
        address requestor,
        address recipient,
        address owner
    ) internal returns (uint256 requestId) {
        requestId = ++lastRequestId;
        _queue[requestId] = WithdrawalRequest({
            amount: amount,
            requestor: requestor,
            recipient: recipient,
            owner: owner,
            timestamp: uint40(block.timestamp),
            fulfilled: false
        });
        _requestsByOwner[owner].add(requestId);
        totalPendingWithdrawals += amount;

        emit WithdrawalRequested(requestId, requestor, recipient, owner, block.timestamp, amount);
    }

    /* --------------------------------------------------------------- NAV */

    /**
     * @notice Oracle 上报每日 NAV，逻辑与 SyncVault 一致
     * @dev 校验：会计日严格 +1 天、reportId 严格 +1、会计日不在未来、波动不超上限；
     *      会计日与 reportId 都与上次相同时视为修改最后一天，覆盖其 NAV
     */
    function handleOracleReport(ReportData memory report) external onlyRole(ORACLE_REPORTER_ROLE) {
        // _prevNav 为 0 说明升级后还没上报过，前一天 NAV 未知，不允许修改
        bool isCorrection = _prevNav != 0 &&
            report.accountingTimestamp == lastAccountingTimestamp &&
            report.reportId == lastReportId;
        if (lastAccountingTimestamp != 0 && lastReportId != 0 && !isCorrection) {
            if (
                (report.accountingTimestamp - lastAccountingTimestamp != 1 days) ||
                (report.reportId - lastReportId != 1)
            ) {
                revert InvalidReport(report.accountingTimestamp, report.reportId);
            }
        }

        if (block.timestamp < report.accountingTimestamp) {
            revert InvalidAccountingTimestamp(
                SafeCast.toUint64(block.timestamp),
                report.accountingTimestamp
            );
        }

        // 修改最后一天时与前一天比，避免同一天反复修改累积突破波动上限
        uint256 preNav = isCorrection ? _prevNav : latestNav;
        if (preNav > 0) {
            uint256 navDifference = report.todayNav > preNav
                ? report.todayNav - preNav
                : preNav - report.todayNav;
            uint256 fluctuationBps = navDifference.mulDiv(
                FEE_PRECISION,
                preNav,
                Math.Rounding.Floor
            );
            if (fluctuationBps > maxFluctuationBps) {
                revert InvalidNavFluctuation(report.todayNav, preNav, maxFluctuationBps);
            }
        }

        if (!isCorrection) {
            _prevNav = latestNav;
        }
        latestNav = report.todayNav;
        lastAccountingTimestamp = report.accountingTimestamp;
        lastReportId = report.reportId;

        emit OracleReportHandled(
            report.accountingTimestamp,
            report.reportId,
            totalSupply(),
            preNav,
            report.todayNav,
            totalFeesCollected,
            report.reporter
        );
    }

    /* ---------------------------------------------------------- 参数配置 */

    function pause() external onlyRole(CONTROLLER) {
        _pause();
    }

    function unpause() external onlyRole(CONTROLLER) {
        _unpause();
    }

    /// @notice 开关"收款地址必须等于发起人"的限制
    function toggleReceiverEqSender(bool isEnable) external onlyRole(CONTROLLER) {
        if (isEnable == isReceiverEqSender) {
            revert InvalidInput();
        }
        isReceiverEqSender = isEnable;
        emit ToggleReceiverEqSender(isEnable);
    }

    function setMinDepositLimit(uint256 minDepositLimit_) external onlyRole(CONTROLLER) {
        if (minDepositLimit_ == 0) {
            revert InvalidInput();
        }
        uint256 pre = minDepositLimit;
        minDepositLimit = minDepositLimit_;
        emit ConfigUpdated(pre, minDepositLimit_, ConfigType.MIN_DEPOSIT_LIMIT);
    }

    function setMaxDepositLimit(uint256 maxDepositLimit_) external onlyRole(CONTROLLER) {
        uint256 pre = maxDepositLimit;
        maxDepositLimit = maxDepositLimit_;
        emit ConfigUpdated(pre, maxDepositLimit_, ConfigType.MAX_DEPOSIT_LIMIT);
    }

    /// @notice 可以调低，但不能低于已认购份额 + 待审核申购占用的份额
    function setMaxSupply(uint256 maxSupply_) external onlyRole(CONTROLLER) {
        if (maxSupply_ < totalSupply() + totalPendingDepositShares) {
            revert InvalidInput();
        }
        uint256 pre = maxSupply;
        maxSupply = maxSupply_;
        emit ConfigUpdated(pre, maxSupply_, ConfigType.MAX_SUPPLY);
    }

    function setMinRedeemLimit(uint256 minRedeemLimit_) external onlyRole(CONTROLLER) {
        if (minRedeemLimit_ == 0) {
            revert InvalidInput();
        }
        uint256 pre = minRedeemLimit;
        minRedeemLimit = minRedeemLimit_;
        emit ConfigUpdated(pre, minRedeemLimit_, ConfigType.MIN_REDEEM_LIMIT);
    }

    function updatePersonalDailyWithdrawQuota(uint256 newQuota) external onlyRole(CONTROLLER) {
        uint256 pre = walletDailyInstantWithdrawQuota;
        walletDailyInstantWithdrawQuota = newQuota;
        emit ConfigUpdated(pre, newQuota, ConfigType.DAILY_INSTANT_WITHDRAW_QUOTA);
    }

    function setMaxFluctuationBps(uint256 maxFluctuationBps_) external onlyRole(CONTROLLER) {
        uint256 pre = maxFluctuationBps;
        maxFluctuationBps = maxFluctuationBps_;
        emit ConfigUpdated(pre, maxFluctuationBps_, ConfigType.MAX_FLUCTUATION_BPS);
    }

    /// @param depositFeeBps_ 申购费率，精度 1e6，上限 {MAX_FEE_BPS}（1%）
    function setDepositFee(uint256 depositFeeBps_) external onlyRole(CONTROLLER) {
        if (depositFeeBps_ > MAX_FEE_BPS) {
            revert InvalidInput();
        }
        uint256 pre = depositFeeBps;
        depositFeeBps = depositFeeBps_;
        emit ConfigUpdated(pre, depositFeeBps_, ConfigType.DEPOSIT_FEE_BPS);
    }

    /// @param withdrawFeeBps_ 赎回费率，精度 1e6，上限 {MAX_FEE_BPS}（1%）
    function setWithdrawFee(uint256 withdrawFeeBps_) external onlyRole(CONTROLLER) {
        if (withdrawFeeBps_ > MAX_FEE_BPS) {
            revert InvalidInput();
        }
        uint256 pre = withdrawFeeBps;
        withdrawFeeBps = withdrawFeeBps_;
        emit ConfigUpdated(pre, withdrawFeeBps_, ConfigType.WITHDRAW_FEE_BPS);
    }

    /// @notice 设置 {withdrawToCustodian} 的固定收款地址，只有 admin 有权限
    function setCustodianWallet(address custodianWallet_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (custodianWallet_ == address(0)) {
            revert InvalidInput();
        }
        address pre = custodianWallet;
        custodianWallet = custodianWallet_;
        emit CustodianWalletUpdated(pre, custodianWallet_);
    }

    /**
     * @notice 增删地址白名单，只有 admin 有权限；增和删共用这一个方法
     * @dev 只在 {isWhitelistEnabled} 为 true 时对申赎与转账生效，但未启用时也允许预先维护名单。
     *      重复添加已在名单内的地址、或移除不在名单内的地址，都会 revert。
     * @param account 目标地址
     * @param allowed true = 加入白名单，false = 移出
     */
    function setWhitelisted(address account, bool allowed) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (account == address(0)) {
            revert InvalidInput();
        }
        bool changed = allowed ? _whitelist.add(account) : _whitelist.remove(account);
        if (!changed) {
            revert InvalidInput();
        }
        emit WhitelistUpdated(account, allowed);
    }

    /// @notice 该地址是否在白名单内（不关心白名单是否启用）
    function isWhitelisted(address account) external view returns (bool) {
        return _whitelist.contains(account);
    }

    /// @notice 当前白名单全量列表
    function whitelist() external view returns (address[] memory) {
        return _whitelist.values();
    }

    /// @dev 白名单启用时的准入校验；未启用则直接放行
    function _checkWhitelisted(address account) internal view {
        if (isWhitelistEnabled && !_whitelist.contains(account)) {
            revert NotWhitelisted(account);
        }
    }

    /// @notice 开关申购，关闭后 {deposit} / {mint} 一律 revert，已挂起的申购仍可执行
    function setDepositEnabled(bool isEnable) external onlyRole(CONTROLLER) {
        if (isEnable == isDepositEnabled) {
            revert InvalidInput();
        }
        isDepositEnabled = isEnable;
        emit ToggleDepositEnabled(isEnable);
    }

    /// @notice 开关赎回，关闭后 {redeem} / {withdraw} 一律 revert，队列中已有的请求仍可兑付
    function setRedeemEnabled(bool isEnable) external onlyRole(CONTROLLER) {
        if (isEnable == isRedeemEnabled) {
            revert InvalidInput();
        }
        isRedeemEnabled = isEnable;
        emit ToggleRedeemEnabled(isEnable);
    }

    /**
     * @notice 开关用户之间的 share 转账，只有 admin 有权限
     * @dev 关闭后 {transfer} / {transferFrom} 一律 revert，申购铸造与赎回销毁不受影响。
     *      和暂停是两件事：暂停停的是申赎，这个开关停的是转账。
     */
    function setShareTransferable(bool isEnable) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (isEnable == isShareTransferable) {
            revert InvalidInput();
        }
        isShareTransferable = isEnable;
        emit ToggleShareTransferable(isEnable);
    }

    /// @notice 修改锁定期，只影响之后新铸的 share，已有批次的 unlockTime 不变
    function setMaturityPeriod(uint256 maturityPeriod_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (maturityPeriod_ % 1 days != 0) {
            revert InvalidInput();
        }
        uint256 pre = maturityPeriod;
        maturityPeriod = maturityPeriod_;
        emit ConfigUpdated(pre, maturityPeriod_, ConfigType.MATURITY_PERIOD);
    }

    /* ------------------------------------------------------- 锁定期查询 */

    /// @return shares 该解锁时间上的份数
    /// @return nextUnlock 链表中的下一个解锁时间
    function getBatch(
        address owner,
        uint64 unlockTime
    ) external view returns (uint256 shares, uint64 nextUnlock) {
        ShareLockLib.Layout storage l = ShareLockLib.layout();
        shares = l.sharesLocks[owner][unlockTime];
        nextUnlock = l.nextTimelock[owner][unlockTime];
    }

    /// @notice 按时间升序返回某地址的全部锁定批次
    function getAllBatches(
        address owner
    ) public view returns (uint64[] memory unlockTime, uint256[] memory shares) {
        ShareLockLib.Layout storage l = ShareLockLib.layout();
        uint256 batchLength = l.listSize[owner];
        unlockTime = new uint64[](batchLength);
        shares = new uint256[](batchLength);

        uint64 current = l.nextTimelock[owner][GUARD];
        uint256 index = 0;
        while (current != GUARD) {
            unlockTime[index] = current;
            shares[index] = l.sharesLocks[owner][current];
            current = l.nextTimelock[owner][current];
            index++;
        }
    }

    /// @notice 累加所有 unlockTime <= currentTime 的批次
    function getAvailableShares(
        address owner,
        uint64 currentTime
    ) public view returns (uint256 availableShares) {
        ShareLockLib.Layout storage l = ShareLockLib.layout();
        uint64 unlockTime = l.nextTimelock[owner][GUARD];
        while (unlockTime != GUARD && unlockTime <= currentTime) {
            availableShares += l.sharesLocks[owner][unlockTime];
            unlockTime = l.nextTimelock[owner][unlockTime];
        }
    }

    function getLockedShares(
        address owner,
        uint64 currentTime
    ) external view returns (uint256 lockedShares) {
        return balanceOf(owner) - getAvailableShares(owner, currentTime);
    }

    /// @return remainingQuota 今日剩余即时赎回额度
    /// @return dayTimestamp 额度所属的结算日
    function getUserDailyWithdrawQuota(address user) external view returns (uint256, uint64) {
        UserDailyWithdrawQuotaInfo memory quotaInfo = userDailyWithdrawQuota[user];
        uint64 currentDay = _normalize(block.timestamp);
        if (quotaInfo.dayTimestamp != currentDay) {
            return (walletDailyInstantWithdrawQuota, currentDay);
        }
        return (quotaInfo.remainingQuota, quotaInfo.dayTimestamp);
    }

    /* ------------------------------------------------------------ 内部 */

    function _updateUserDailyQuota(address user) internal returns (uint256) {
        UserDailyWithdrawQuotaInfo storage quotaInfo = userDailyWithdrawQuota[user];
        uint64 currentDay = _normalize(block.timestamp);
        if (quotaInfo.dayTimestamp != currentDay) {
            quotaInfo.remainingQuota = walletDailyInstantWithdrawQuota;
            quotaInfo.dayTimestamp = currentDay;
        }
        return quotaInfo.remainingQuota;
    }

    /**
     * @notice 把任意时刻向后对齐到下一个 UTC 00:00（北京时间 08:00 结算切点）
     * @dev 按天取整后 +1 天，保证结果严格落在未来
     */
    function _normalize(uint256 timestamp) internal pure returns (uint64) {
        return SafeCast.toUint64((timestamp / 1 days + 1) * 1 days);
    }

    function _convertToShares(
        uint256 assets,
        Math.Rounding rounding
    ) internal view override returns (uint256) {
        if (latestNav == 0) {
            return assets;
        }
        return assets.mulDiv(NAV_PRECISION, latestNav, rounding);
    }

    function _convertToAssets(
        uint256 shares,
        Math.Rounding rounding
    ) internal view override returns (uint256) {
        if (latestNav == 0) {
            return shares;
        }
        return shares.mulDiv(latestNav, NAV_PRECISION, rounding);
    }

    /// @return requestId 0 表示即时兑付，>0 表示进入队列
    function _customWithdraw(
        address caller,
        address receiver,
        address owner,
        uint256 assets,
        uint256 shares
    ) internal returns (uint256 requestId) {
        if (!isRedeemEnabled) {
            revert RedeemDisabled();
        }
        // 赎回不查白名单：白名单只管入口（申购、接收转账），已持有份额的随时可退出，到期代赎也不会因名单失败

        if (caller != owner) {
            _spendAllowance(owner, caller, shares);
        }
        _burn(owner, shares);

        uint256 userRemainingQuota = _updateUserDailyQuota(owner);
        if (assets <= userRemainingQuota && assets <= availableLiquidity()) {
            userDailyWithdrawQuota[owner].remainingQuota = userRemainingQuota - assets;
            IERC20(asset()).safeTransfer(receiver, assets);
            requestId = 0;
        } else {
            // 每日额度或 Vault 流动性不足 -> 进入提现队列，等 admin 回款后兑付
            requestId = _enqueue(assets, caller, receiver, owner);
        }

        emit Withdraw(caller, receiver, owner, assets, shares);
    }

    /**
     * @dev 在 ERC20 余额变动之上维护解锁链表，写路径全部委托给 {ShareLockLib}
     *      （external 库调用走 delegatecall，链表数据仍在本合约的 storage 里）
     *      - mint：按 _normalize(now) + maturityPeriod 落入对应批次，同批次累加；锁定期 0 落在当天零点，铸出即解锁
     *      - burn：从最早解锁的批次开始 FIFO 扣减
     *      - transfer：FIFO 取出，unlockTime 原样转移给接收方；{isShareTransferable} 关闭时直接 revert，
     *        白名单启用时转账双方都必须在名单内（铸造与销毁不在此校验：申购路径自己把关，赎回不受名单限制）
     */
    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && to != address(0)) {
            if (!isShareTransferable) {
                revert ShareTransferDisabled();
            }
            _checkWhitelisted(from);
            _checkWhitelisted(to);
        }
        super._update(from, to, value);

        if (value == 0 || from == to) {
            return;
        }

        if (from == address(0)) {
            // 锁定期 0 落在当天零点（已过去），铸出即可赎回；否则从下一个结算切点起算
            uint256 unlockTime = maturityPeriod == 0
                ? (block.timestamp / 1 days) * 1 days
                : _normalize(block.timestamp) + maturityPeriod;
            ShareLockLib.mintBatch(to, value, SafeCast.toUint64(unlockTime));
        } else {
            // to == address(0) 即销毁，库里据此跳过给接收方落批次的那一步
            ShareLockLib.consumeFifo(from, to, value);
        }
    }

    /// @dev UUPS 升级权限
    function _authorizeUpgrade(address) internal override onlyRole(DEFAULT_ADMIN_ROLE) {}

    /// @dev 相比上一版净增 1 槽：删掉 RWA 白名单释放 2 槽，新增 3 槽
    ///      （3 个 bool 打包成 1 槽 + _whitelist 的 AddressSet 占 2 槽），46 - 1 = 45；
    ///      之后新增 _prevNav 占 1 槽，45 - 1 = 44
    /// forge-lint: disable-next-line(mixed-case-variable)
    uint256[44] private __gap;
}
