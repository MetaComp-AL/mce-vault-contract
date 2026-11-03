# MceVault 审计说明

MceVault 是一个可升级的 ERC-4626 时间锁 Vault。申购需通过链下 KYT 审核后才铸造份额，份额按每日 NAV 定价，赎回资金不足时进入 FIFO 提现队列。

## 审计范围

| 文件 | 行数 | nSLOC（约） |
|---|---|---|
| `contracts/MceVault.sol` | 1591 | 1086 |
| `contracts/ShareLockLib.sol` | 172 | 108 |

`contracts/mocks/` 仅供测试，不在审计范围内。

## 环境

- Solidity 0.8.28，`viaIR: true`，optimizer `runs: 200`，`evmVersion: cancun`
- OpenZeppelin Contracts / Contracts-Upgradeable 5.6.1
- 目标链：BSC、Arbitrum One
- 运行时字节码：MceVault 23980 字节（距 EIP-170 上限还剩 596 字节），ShareLockLib 2328 字节

```bash
npm ci
npx hardhat test       # 77 个测试
npx hardhat coverage
```

## 测试覆盖率

| 文件 | 语句 | 分支 | 函数 | 行 |
|---|---|---|---|---|
| MceVault.sol | 100% | 94.16% | 100% | 99.31% |
| ShareLockLib.sol | 100% | 83.33% | 100% | 98.08% |

`ShareLockLib.sol` 中未覆盖的一行是防御性检查：链表份额与 ERC20 余额恒等时不可达。

## 架构要点

- **代理模式**：UUPS，升级权限为 `DEFAULT_ADMIN_ROLE`。
- **外部库**：`ShareLockLib` 是独立部署的外部库，MceVault 通过 delegatecall 调用。拆出它是为了满足 24KB 字节码上限，因此部署时使用了 oz-upgrades 的 `unsafeAllow: ["external-library-linking"]`。库通过固定 storage slot（`keccak256("mce.vault.sharelock.storage")`）读写 Vault 的锁定期链表；只读查询留在 Vault 内直接读这个 slot。
- **份额锁定**：每个地址维护一条按 `unlockTime` 升序的链表。同一结算日的多笔申购合并为一个节点，赎回和转账都按 FIFO 消耗；转账时 `unlockTime` 随份额一起转移。
- **申购（异步，不符合 ERC-4626 的即时铸造语义）**：`deposit` / `mint` 收取资产，并按当时 NAV 锁定份额数量，但不铸造。`KYT_REPORTER_ROLE` 通过 `submitKytResult` 上报结论（执行前可改判），`CONTROLLER` 再调用 `executeDeposit` 执行：通过则铸造份额；拒绝则原路退款，并把付款人和接收人都加入 `depositBlacklist`。
- **赎回**：份额立即销毁。Vault 余额和每日个人额度都足够时即时兑付，否则进入提现队列，由 `CONTROLLER` 通过 `fulfillPendingWithdrawals` / `fulfillSpecificRequest(s)` 兑付。
- **定价**：NAV 由 `ORACLE_REPORTER_ROLE` 每日上报，要求会计日严格 +1 天、`reportId` 严格 +1，且单日波动不超过 `maxFluctuationBps`；允许修正最后一天的 NAV。`totalAssets()` 按 NAV 估值计算，不等于实际余额。
- **资金调度**：`CONTROLLER` 可通过 `withdrawToCustodian` / `depositFromCustodian` 把资产在 Vault 和固定的 `custodianWallet` 之间划转（用于链下配置 RWA），收款地址只有 admin 能修改。

## 角色与信任假设

| 角色 | 权限 |
|---|---|
| `DEFAULT_ADMIN_ROLE` | 授予和撤销角色、合约升级、设置 `custodianWallet`、白名单、KYT 黑名单、锁定期、share 转账开关 |
| `CONTROLLER` | 执行申购、兑付队列、资金划转、提取手续费、业务参数、暂停/恢复、申购和赎回开关、批量代赎 |
| `ORACLE_REPORTER_ROLE` | 上报 NAV |
| `KYT_REPORTER_ROLE` | 上报 KYT 结论 |

以上角色均视为可信，由 MPC 钱包持有。以下中心化行为属于设计如此：

- `withdrawToCustodian` 和 `withdrawFees` 只保留待审核申购的资金，**不保留**提现队列已承诺的金额。
- 合约升级没有 timelock。
- 用户无法自行取消挂起的申购或提现请求，需要依赖 `CONTROLLER` 处理。
- `depositBlacklist` 只拦截申购，不拦截赎回和转账。
- 暂停只拦截申购、赎回和队列兑付，不拦截 share 转账；转账由独立的 `setShareTransferable` 开关控制。
- `CONTROLLER` 可以通过 `controllerRedeemUnlockedFor` 代用户赎回已解锁份额，资金只能打回用户本人。

底层资产只支持标准 ERC20（如 USDC、USDT），不支持转账扣费（fee-on-transfer）和余额自动变化（rebasing）的代币。

## 已知问题

以下问题已在内部审查中发现，并决定暂不修改：

1. **KYT 拒绝后退款可能卡住**：如果付款人在申购到执行之间被 USDC/USDT 拉黑，`executeDeposit` 的退款会一直 revert，这笔资金会持续占用 `totalPendingDepositAssets`。目前只能改判为通过，或升级合约处理。
2. **`fulfillPendingWithdrawals` 跳过已兑付请求时不计入 `MAX_REQUEST_BATCH`**：游标前方积累大量单独兑付过的请求时，单次循环可能很长。
3. **`executeDeposit` 通过时不重新检查黑名单和白名单**：申购挂起期间被拉黑或移出白名单的接收人，只要结论是通过，仍会铸造份额。
4. **`handleOracleReport` 的校验有缺口**：
   - 首份报告的 `reportId` 为 0 时，之后的连续性校验会被跳过；
   - `todayNav` 可以为 0，且 `maxFluctuationBps` 没有上限；
   - 事件中的 `reporter` 由调用方传入，不是 `msg.sender`。
5. **关闭 `isReceiverEqSender` 后可恶意拉黑他人**：攻击者用问题资金替他人申购，KYT 拒绝时接收人也会被拉黑。默认配置下不会触发。
6. **NAV 时间差**：申购份额按申购时的 NAV 锁定。锁定期为 0 或 NAV 跳涨时，存在抢在 NAV 上报交易之前申购的套利空间。
7. **ERC-4626 的 `max*` 函数不完全合规**：没有考虑暂停、开关和黑白名单；`maxDeposit` 使用向上取整，NAV 低于 1 时可能多算 1 份。
8. **`controllerRedeemUnlockedFor` 没有数组长度上限。**
9. **pragma 浮动**：使用 `^0.8.24`，实际编译版本为 0.8.28。

## 注意

MceVault 距 24KB 字节码上限只剩 596 字节。修复建议请尽量控制字节码增量。
