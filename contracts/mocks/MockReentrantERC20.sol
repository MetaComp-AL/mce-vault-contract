// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice 测试用恶意 ERC20：在转账过程中回调目标合约，用来验证重入守卫
contract MockReentrantERC20 is ERC20 {
    uint8 private immutable _decimals;

    address public target;
    bytes public payload;
    bool private _inCallback;

    constructor(uint8 decimals_) ERC20("Evil Token", "EVIL") {
        _decimals = decimals_;
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    /// @notice 设置转账时要回调的目标与 calldata，target 传 0 关闭攻击
    function setAttack(address target_, bytes calldata payload_) external {
        target = target_;
        payload = payload_;
    }

    function _attack() private {
        if (target == address(0) || _inCallback) {
            return;
        }
        _inCallback = true;
        (bool ok, bytes memory ret) = target.call(payload);
        _inCallback = false;
        if (!ok) {
            // 把内层的 revert 原样冒泡出去，测试才能断言具体的自定义错误
            assembly {
                revert(add(ret, 0x20), mload(ret))
            }
        }
    }

    function transfer(address to, uint256 amount) public override returns (bool) {
        _attack();
        return super.transfer(to, amount);
    }

    function transferFrom(address from, address to, uint256 amount) public override returns (bool) {
        _attack();
        return super.transferFrom(from, to, amount);
    }
}
