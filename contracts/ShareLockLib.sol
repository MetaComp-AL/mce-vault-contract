// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/**
 * @title ShareLockLib
 * @notice share 锁定期链表的**写路径**，独立部署、由 MceVault 通过 delegatecall 调用
 * @dev 为什么外置：MceVault 的字节码超出了 EIP-170 的 24KB 部署上限，链表写路径是其中最大的
 *      一块，挪出来能腾出 2KB 以上的余量，且不影响任何对外接口。
 *
 *      为什么用固定 slot：external 库函数走 delegatecall，在 Vault 的 storage 上下文里执行，
 *      但库无法继承 Vault 的 storage 布局，也不能把 mapping 的 storage 引用当参数传进来
 *      （external 调用的参数必须是 ABI 可编码的）。所以两侧都通过 {layout} 用同一个固定
 *      slot 定位这三个 mapping。
 *
 *      为什么只搬写路径：view 函数里不允许 delegatecall，而 staticcall 会落到库自己的
 *      storage 上下文、读不到 Vault 的数据。因此 getAllBatches / getAvailableShares 这类
 *      只读查询留在 Vault 里，直接读 {layout}。
 *
 *      链表语义沿用 SyncVault：每个地址一条按 unlockTime 升序的链表，GUARD(0) 是头哨兵，
 *      同一结算日窗口的多笔认购合并进同一节点，赎回与转账按 FIFO（最早解锁优先）消耗。
 */
library ShareLockLib {
    using Math for uint256;

    /// @notice 解锁链表的头/尾哨兵，与 MceVault.GUARD 一致
    uint64 internal constant GUARD = 0;

    struct Layout {
        /// @dev owner => 解锁时间 => 锁定份数
        mapping(address => mapping(uint64 => uint256)) sharesLocks;
        /// @dev owner => 解锁时间 => 下一个解锁时间（升序链表）
        mapping(address => mapping(uint64 => uint64)) nextTimelock;
        mapping(address => uint64) listSize;
    }

    /// @dev 固定 storage slot，不占 Vault 的顺序布局
    bytes32 internal constant LAYOUT_SLOT = keccak256("mce.vault.sharelock.storage");

    function layout() internal pure returns (Layout storage l) {
        bytes32 slot = LAYOUT_SLOT;
        assembly {
            l.slot := slot
        }
    }

    /// @dev delegatecall 执行，事件的 emitter 是 Vault；签名与 MceVault 里的声明保持一致
    event TransferShares(
        address indexed sender,
        address indexed receiver,
        uint256 shares,
        uint64 unlockTime
    );

    error SharesAmountError(address owner, uint256 requested, uint256 remaining);

    /// @notice 铸造：整笔落进 unlockTime 对应的批次，已存在则累加
    function mintBatch(address to, uint256 shares, uint64 unlockTime) external {
        _onReceiveShares(to, shares, unlockTime, GUARD);
        emit TransferShares(address(0), to, shares, unlockTime);
    }

    /**
     * @notice 销毁或转账：从最早解锁的批次开始 FIFO 消耗
     * @param from 出让方
     * @param to 接收方，传 address(0) 表示销毁（不给接收方落批次）
     * @param value 份数
     */
    function consumeFifo(address from, address to, uint256 value) external {
        Layout storage l = layout();

        uint256 remaining = value;
        uint64 startTimestamp = GUARD;
        uint64 i = l.nextTimelock[from][GUARD];

        uint64 firstToDelete = 0;
        uint64 lastToDelete = 0;
        uint64 deleteCount = 0;

        while (remaining > 0) {
            // 防御性检查：ERC20 余额已在 super._update 里扣过，链表份数与余额恒等，
            // 正常路径走不到这里；真触发说明链表被写坏了，此时宁可整笔回滚。
            // 测试覆盖不到这一行，属于预期。
            if (i == GUARD) {
                revert SharesAmountError(from, value, remaining);
            }

            uint256 sharesAmount = l.sharesLocks[from][i];
            uint256 take = Math.min(remaining, sharesAmount);

            if (to != address(0)) {
                // 保留原 unlockTime 转给接收方
                _onReceiveShares(to, take, i, startTimestamp);
                startTimestamp = i;
            }

            unchecked {
                l.sharesLocks[from][i] = sharesAmount - take;
                remaining -= take;
            }

            if (l.sharesLocks[from][i] == 0) {
                if (firstToDelete == 0) {
                    firstToDelete = i;
                }
                lastToDelete = i;
                deleteCount++;
            }
            emit TransferShares(from, to, take, i);
            i = l.nextTimelock[from][i];
        }

        if (deleteCount > 0) {
            _removeBatch(l, from, firstToDelete, lastToDelete, deleteCount);
        }
    }

    function _onReceiveShares(
        address owner,
        uint256 shares,
        uint64 unlockTime,
        uint64 startTimestamp
    ) private {
        Layout storage l = layout();
        if (l.sharesLocks[owner][unlockTime] == 0) {
            // 新批次：从 startTimestamp 起向后找插入位，保持升序
            uint64 preTimestamp = startTimestamp;
            uint64 nextTimestamp = l.nextTimelock[owner][startTimestamp];
            while (
                !((preTimestamp == GUARD || preTimestamp < unlockTime) &&
                    (nextTimestamp == GUARD || unlockTime < nextTimestamp))
            ) {
                preTimestamp = nextTimestamp;
                nextTimestamp = l.nextTimelock[owner][nextTimestamp];
            }

            l.sharesLocks[owner][unlockTime] = shares;
            l.nextTimelock[owner][preTimestamp] = unlockTime;
            l.nextTimelock[owner][unlockTime] = nextTimestamp;
            l.listSize[owner] += 1;
        } else {
            l.sharesLocks[owner][unlockTime] += shares;
        }
    }

    /**
     * @dev 摘除 [firstToDelete, lastToDelete] 这段被清零的批次
     *      两个调用场景（转账、销毁）都从链表头开始 FIFO 消耗，被清零的节点必然是从头开始的
     *      连续前缀，因此 firstToDelete 恒等于表头、前驱恒为 GUARD，不需要再回头查找。
     */
    function _removeBatch(
        Layout storage l,
        address owner,
        uint64 firstToDelete,
        uint64 lastToDelete,
        uint64 deleteCount
    ) private {
        uint64 postLast = l.nextTimelock[owner][lastToDelete];
        l.nextTimelock[owner][GUARD] = postLast;

        uint64 current = firstToDelete;
        while (current != postLast) {
            uint64 next = l.nextTimelock[owner][current];
            delete l.sharesLocks[owner][current];
            delete l.nextTimelock[owner][current];
            current = next;
        }

        l.listSize[owner] -= deleteCount;
    }
}
