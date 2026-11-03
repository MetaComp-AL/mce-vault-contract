const { expect } = require("chai");
const { ethers, upgrades } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { ONE_DAY, USDC, vaultFixture, kytDeposit } = require("./fixture");

// 权限边界、暂停、升级、参数 setter —— 审计重点看的那批
describe("MceVault 权限与参数边界", function () {
    let admin, controller, reporter, alice, bob, custodian, kyt;
    let usdc, vault, vaultFactory;
    let deposit;

    beforeEach(async function () {
        ({
            admin, controller, reporter, alice, bob, custodian, kyt,
            usdc, vault, vaultFactory,
        } = await loadFixture(vaultFixture));
        deposit = kytDeposit(kyt, controller);
    });

    async function unlockLatestBatch(owner) {
        const [times] = await vault.getAllBatches(owner.address);
        await time.increaseTo(times[times.length - 1]);
    }

    /* ------------------------------------------------------------ 暂停 */

    it("暂停：挡住申赎与队列兑付，但不挡 KYT 上报与执行（钱已在合约里，必须留退款通道）", async function () {
        // 先留一笔待执行的申购，验证暂停后它仍能被处理
        await vault.connect(alice).deposit(USDC(1000), alice.address);
        await deposit(vault, bob, USDC(1000));
        await unlockLatestBatch(bob);

        await expect(vault.connect(controller).pause()).to.emit(vault, "Paused");
        expect(await vault.paused()).to.equal(true);

        for (const call of [
            vault.connect(alice).deposit(USDC(100), alice.address),
            vault.connect(alice).mint(USDC(100), alice.address),
            vault.connect(bob).redeem(USDC(100), bob.address, bob.address),
            vault.connect(bob).withdraw(USDC(100), bob.address, bob.address),
            vault.connect(controller).fulfillPendingWithdrawals(USDC(1000)),
            vault.connect(controller).fulfillSpecificRequest(1),
        ]) {
            await expect(call).to.be.revertedWithCustomError(vault, "EnforcedPause");
        }

        // KYT 两步不受暂停限制
        await vault.connect(kyt).submitKytResult(1, true);
        await vault.connect(controller).executeDeposit(1);
        expect(await vault.balanceOf(alice.address)).to.equal(USDC(1000));

        // 拒绝路径的退款同样能在暂停期间走完
        await vault.connect(controller).unpause();
        await vault.connect(bob).deposit(USDC(500), bob.address);
        const id = await vault.lastDepositId();
        await vault.connect(controller).pause();
        await vault.connect(kyt).submitKytResult(id, false);
        const before = await usdc.balanceOf(bob.address);
        await vault.connect(controller).executeDeposit(id);
        expect(await usdc.balanceOf(bob.address)).to.equal(before + USDC(500));

        await expect(vault.connect(controller).unpause()).to.emit(vault, "Unpaused");
        expect(await vault.paused()).to.equal(false);
    });

    it("暂停：只有 CONTROLLER 能开关，重复调用会被 Pausable 挡住", async function () {
        for (const call of [vault.pause(), vault.connect(alice).pause()]) {
            await expect(call).to.be.revertedWithCustomError(vault, "AccessControlUnauthorizedAccount");
        }

        await expect(vault.connect(controller).unpause()).to.be.revertedWithCustomError(
            vault, "ExpectedPause"
        );
        await vault.connect(controller).pause();
        await expect(vault.connect(controller).pause()).to.be.revertedWithCustomError(
            vault, "EnforcedPause"
        );
    });

    /* ------------------------------------------------------------ 升级 */

    it("升级：只有 admin 能换实现，其他角色一律不行", async function () {
        // 拿一个已部署的地址冒充新实现；权限校验在前，不会真的执行升级
        const fakeImpl = await (await ethers.getContractFactory("MockERC20")).deploy("X", "X", 6);
        const fakeAddr = await fakeImpl.getAddress();

        for (const who of [controller, reporter, kyt, alice]) {
            await expect(
                vault.connect(who).upgradeToAndCall(fakeAddr, "0x")
            ).to.be.revertedWithCustomError(vault, "AccessControlUnauthorizedAccount");
        }

        // admin 放行：换成同一份实现（存储布局校验也会跑一遍）
        const before = await upgrades.erc1967.getImplementationAddress(await vault.getAddress());
        await upgrades.upgradeProxy(await vault.getAddress(), vaultFactory, {
            unsafeAllow: ["external-library-linking"],
            redeployImplementation: "always",
        });
        const after = await upgrades.erc1967.getImplementationAddress(await vault.getAddress());
        expect(after).to.not.equal(before);

        // 升级后状态与数据都还在
        expect(await vault.symbol()).to.equal("VRPCW");
        expect(await vault.custodianWallet()).to.equal(custodian.address);
    });

    it("升级：admin 换人后原 admin 失去升级权", async function () {
        const adminRole = await vault.DEFAULT_ADMIN_ROLE();
        await vault.grantRole(adminRole, bob.address);
        await vault.revokeRole(adminRole, admin.address);

        expect(await vault.hasRole(adminRole, admin.address)).to.equal(false);
        await expect(
            vault.setCustodianWallet(alice.address)
        ).to.be.revertedWithCustomError(vault, "AccessControlUnauthorizedAccount");
        await expect(vault.connect(bob).setCustodianWallet(alice.address))
            .to.emit(vault, "CustodianWalletUpdated")
            .withArgs(custodian.address, alice.address);
    });

    /* ------------------------------------------------- 参数 setter 边界 */

    it("参数：申购/赎回限额的 setter 与下限校验", async function () {
        await expect(vault.connect(controller).setMinDepositLimit(USDC(5)))
            .to.emit(vault, "ConfigUpdated")
            .withArgs(USDC(1), USDC(5), 2); // ConfigType.MIN_DEPOSIT_LIMIT
        expect(await vault.minDepositLimit()).to.equal(USDC(5));
        await expect(
            vault.connect(alice).deposit(USDC(4), alice.address)
        ).to.be.revertedWithCustomError(vault, "BelowMinDeposit");

        await expect(vault.connect(controller).setMaxDepositLimit(USDC(100)))
            .to.emit(vault, "ConfigUpdated")
            .withArgs(USDC(10_000_000), USDC(100), 0); // MAX_DEPOSIT_LIMIT
        await expect(
            vault.connect(alice).deposit(USDC(101), alice.address)
        ).to.be.revertedWithCustomError(vault, "ERC4626ExceededMaxDeposit");

        await expect(vault.connect(controller).setMinRedeemLimit(USDC(50)))
            .to.emit(vault, "ConfigUpdated")
            .withArgs(USDC(1), USDC(50), 3); // MIN_REDEEM_LIMIT
        await deposit(vault, alice, USDC(100));
        await unlockLatestBatch(alice);
        await expect(
            vault.connect(alice).redeem(USDC(49), alice.address, alice.address)
        ).to.be.revertedWithCustomError(vault, "BelowMinRedeem");
        await expect(
            vault.connect(alice).withdraw(USDC(49), alice.address, alice.address)
        ).to.be.revertedWithCustomError(vault, "BelowMinRedeem");

        // 两个下限都不许设成 0
        for (const call of [
            vault.connect(controller).setMinDepositLimit(0),
            vault.connect(controller).setMinRedeemLimit(0),
        ]) {
            await expect(call).to.be.revertedWithCustomError(vault, "InvalidInput");
        }
    });

    it("参数：每日额度与 NAV 波动上限可调，且只有 CONTROLLER 能调", async function () {
        await expect(vault.connect(controller).updatePersonalDailyWithdrawQuota(USDC(500)))
            .to.emit(vault, "ConfigUpdated")
            .withArgs(USDC(10_000), USDC(500), 7); // DAILY_INSTANT_WITHDRAW_QUOTA
        expect(await vault.walletDailyInstantWithdrawQuota()).to.equal(USDC(500));

        await expect(vault.connect(controller).setMaxFluctuationBps(50_000))
            .to.emit(vault, "ConfigUpdated")
            .withArgs(100_000, 50_000, 6); // MAX_FLUCTUATION_BPS
        expect(await vault.maxFluctuationBps()).to.equal(50_000);

        for (const call of [
            vault.updatePersonalDailyWithdrawQuota(USDC(1)),
            vault.setMaxFluctuationBps(1),
            vault.setMaxSupply(1),
            vault.setMinDepositLimit(1),
            vault.setMaxDepositLimit(1),
            vault.setMinRedeemLimit(1),
            vault.setDepositFee(1),
            vault.setWithdrawFee(1),
        ]) {
            await expect(call).to.be.revertedWithCustomError(vault, "AccessControlUnauthorizedAccount");
        }
    });

    it("参数：锁定期只能整天，改动只影响之后新铸的份额", async function () {
        await deposit(vault, alice, USDC(100));
        const [oldTimes] = await vault.getAllBatches(alice.address);

        await expect(
            vault.setMaturityPeriod(ONE_DAY + 1)
        ).to.be.revertedWithCustomError(vault, "InvalidInput");
        await expect(
            vault.connect(controller).setMaturityPeriod(ONE_DAY * 7)
        ).to.be.revertedWithCustomError(vault, "AccessControlUnauthorizedAccount");

        await expect(vault.setMaturityPeriod(ONE_DAY * 7))
            .to.emit(vault, "ConfigUpdated")
            .withArgs(ONE_DAY, ONE_DAY * 7, 8); // MATURITY_PERIOD

        // 跨到下一个结算窗口再申购，新批次按 7 天算，老批次不动
        await time.increaseTo(oldTimes[0]);
        await deposit(vault, alice, USDC(100));
        const [times] = await vault.getAllBatches(alice.address);
        expect(times[0]).to.equal(oldTimes[0]);
        // 新批次 = 下一个结算切点（比老批次晚 1 天）+ 7 天锁定期
        expect(times[1] - times[0]).to.equal(BigInt(ONE_DAY * 8));

        // ponytail: setter 允许设 0（initialize 不允许），此时新份额铸出即可赎回
        await vault.setMaturityPeriod(0);
        expect(await vault.maturityPeriod()).to.equal(0);
    });

    /* --------------------------------------------- receiver == sender 开关 */

    it("收款人限制：默认只能存/赎给自己，CONTROLLER 关掉后可代存、可赎给第三方", async function () {
        await expect(vault.connect(alice).deposit(USDC(100), bob.address))
            .to.be.revertedWithCustomError(vault, "InvalidReceiver")
            .withArgs(alice.address, bob.address);
        await expect(vault.connect(alice).mint(USDC(100), bob.address))
            .to.be.revertedWithCustomError(vault, "InvalidReceiver")
            .withArgs(alice.address, bob.address);

        await deposit(vault, alice, USDC(1000));
        await unlockLatestBatch(alice);
        await expect(vault.connect(alice).redeem(USDC(100), bob.address, alice.address))
            .to.be.revertedWithCustomError(vault, "InvalidReceiver")
            .withArgs(alice.address, bob.address);
        await expect(vault.connect(alice).withdraw(USDC(100), bob.address, alice.address))
            .to.be.revertedWithCustomError(vault, "InvalidReceiver")
            .withArgs(alice.address, bob.address);

        await expect(vault.connect(controller).toggleReceiverEqSender(false))
            .to.emit(vault, "ToggleReceiverEqSender")
            .withArgs(false);
        // 设成当前值会被拒
        await expect(
            vault.connect(controller).toggleReceiverEqSender(false)
        ).to.be.revertedWithCustomError(vault, "InvalidInput");

        // 代存：alice 付钱，份额记到 bob 名下
        await vault.connect(alice).deposit(USDC(200), bob.address);
        const id = await vault.lastDepositId();
        await vault.connect(kyt).submitKytResult(id, true);
        await vault.connect(controller).executeDeposit(id);
        expect(await vault.balanceOf(bob.address)).to.equal(USDC(200));

        // 赎给第三方：份额从 alice 扣，钱到 bob
        const before = await usdc.balanceOf(bob.address);
        await vault.connect(alice).redeem(USDC(100), bob.address, alice.address);
        expect(await usdc.balanceOf(bob.address)).to.equal(before + USDC(100));
    });

    it("代赎回：被授权人可以花掉别人的份额，额度不足则失败", async function () {
        await vault.connect(controller).toggleReceiverEqSender(false);
        await deposit(vault, alice, USDC(1000));
        await unlockLatestBatch(alice);

        // 没授权，直接赎别人的份额会被 ERC20 授权检查挡住
        await expect(
            vault.connect(bob).redeem(USDC(100), bob.address, alice.address)
        ).to.be.revertedWithCustomError(vault, "ERC20InsufficientAllowance");

        await vault.connect(alice).approve(bob.address, USDC(300));
        const before = await usdc.balanceOf(bob.address);
        await vault.connect(bob).redeem(USDC(100), bob.address, alice.address);
        expect(await usdc.balanceOf(bob.address)).to.equal(before + USDC(100));
        expect(await vault.allowance(alice.address, bob.address)).to.equal(USDC(200));

        // withdraw 走同一条授权路径
        await vault.connect(bob).withdraw(USDC(200), bob.address, alice.address);
        expect(await vault.allowance(alice.address, bob.address)).to.equal(0);
        await expect(
            vault.connect(bob).redeem(USDC(100), bob.address, alice.address)
        ).to.be.revertedWithCustomError(vault, "ERC20InsufficientAllowance");
    });

    it("批量代赎：CONTROLLER 按指定份额代赎，钱打回用户本人，不能超过已解锁部分", async function () {
        await deposit(vault, alice, USDC(1000));
        await deposit(vault, bob, USDC(500));
        await unlockLatestBatch(bob);
        await deposit(vault, alice, USDC(300)); // 还在锁定期

        await expect(vault.connect(alice).controllerRedeemUnlockedFor([alice.address], [USDC(100)]))
            .to.be.revertedWithCustomError(vault, "AccessControlUnauthorizedAccount");
        // 地址和份额数量对不上
        await expect(vault.connect(controller).controllerRedeemUnlockedFor([alice.address, bob.address], [USDC(100)]))
            .to.be.revertedWithCustomError(vault, "InvalidInput");

        const aliceBefore = await usdc.balanceOf(alice.address);
        const bobBefore = await usdc.balanceOf(bob.address);
        await vault.connect(controller).controllerRedeemUnlockedFor([alice.address, bob.address], [USDC(600), USDC(500)]);
        expect(await usdc.balanceOf(alice.address)).to.equal(aliceBefore + USDC(600));
        expect(await usdc.balanceOf(bob.address)).to.equal(bobBefore + USDC(500));
        expect(await vault.balanceOf(alice.address)).to.equal(USDC(700));
        expect(await vault.balanceOf(bob.address)).to.equal(0);

        // alice 只剩 400 已解锁，另外 300 还在锁定期，超出与 redeem 一样失败，整批回滚
        await expect(vault.connect(controller).controllerRedeemUnlockedFor([alice.address], [USDC(401)]))
            .to.be.revertedWithCustomError(vault, "InsufficientUnlockedShares");
    });

    /* ------------------------------------------------------ 队列调度边界 */

    it("队列调度：三个兑付接口的 requestId 校验与重复兑付防护", async function () {
        await deposit(vault, alice, USDC(1000));
        await unlockLatestBatch(alice);
        await vault.connect(controller).withdrawToCustodian(USDC(1000));
        await vault.connect(alice).redeem(USDC(1000), alice.address, alice.address); // requestId 1

        for (const id of [0, 2]) {
            await expect(vault.connect(controller).fulfillSpecificRequest(id))
                .to.be.revertedWithCustomError(vault, "InvalidRequestId")
                .withArgs(id);
            await expect(vault.connect(controller).skipWithdrawalRequest(id))
                .to.be.revertedWithCustomError(vault, "InvalidRequestId")
                .withArgs(id);
            await expect(vault.getWithdrawalStatus([id]))
                .to.be.revertedWithCustomError(vault, "InvalidRequestId")
                .withArgs(id);
        }

        // 三个接口都只有 CONTROLLER 能调
        for (const call of [
            vault.fulfillPendingWithdrawals(USDC(1)),
            vault.fulfillSpecificRequest(1),
            vault.skipWithdrawalRequest(1),
        ]) {
            await expect(call).to.be.revertedWithCustomError(vault, "AccessControlUnauthorizedAccount");
        }

        await vault.connect(controller).depositFromCustodian(USDC(1000));
        await vault.connect(controller).fulfillSpecificRequest(1);

        // 已兑付的不能再兑付、也不能挪到队尾
        for (const call of [
            vault.connect(controller).fulfillSpecificRequest(1),
            vault.connect(controller).skipWithdrawalRequest(1),
        ]) {
            await expect(call).to.be.revertedWithCustomError(vault, "InvalidInput");
        }
    });

    it("队列调度：getWithdrawalStatus 返回明细，兑付前后 fulfilled 翻转", async function () {
        await deposit(vault, alice, USDC(1000));
        await unlockLatestBatch(alice);
        await vault.connect(controller).withdrawToCustodian(USDC(1000));
        await vault.connect(alice).redeem(USDC(1000), alice.address, alice.address);

        let [req] = await vault.getWithdrawalStatus([1]);
        expect(req.amount).to.equal(USDC(1000));
        expect(req.requestor).to.equal(alice.address);
        expect(req.recipient).to.equal(alice.address);
        expect(req.owner).to.equal(alice.address);
        expect(req.fulfilled).to.equal(false);

        await vault.connect(controller).depositFromCustodian(USDC(1000));
        await vault.connect(controller).fulfillPendingWithdrawals(USDC(1000));
        [req] = await vault.getWithdrawalStatus([1]);
        expect(req.fulfilled).to.equal(true);
    });

    /* ------------------------------------------------------ 资金归集边界 */

    it("资金归集：取款/回款的金额校验与权限，只有 CONTROLLER 能发起", async function () {
        await deposit(vault, alice, USDC(1000));

        for (const call of [
            vault.connect(controller).withdrawToCustodian(0),
            vault.connect(controller).depositFromCustodian(0),
        ]) {
            await expect(call).to.be.revertedWithCustomError(vault, "InvalidInput");
        }

        await expect(
            vault.connect(alice).depositFromCustodian(USDC(1))
        ).to.be.revertedWithCustomError(vault, "AccessControlUnauthorizedAccount");
    });

    it("提费：额度用 min(计提, 已提) 之差算，超额与零额都被拒", async function () {
        await vault.connect(controller).setDepositFee(10_000); // 1%
        await deposit(vault, alice, USDC(1000)); // 费 10

        expect(await vault.withdrawableFees()).to.equal(USDC(10));
        await vault.connect(controller).withdrawFees(USDC(4));
        expect(await vault.withdrawableFees()).to.equal(USDC(6));
        expect(await vault.totalFeesWithdrawn()).to.equal(USDC(4));

        await expect(vault.connect(controller).withdrawFees(USDC(7)))
            .to.be.revertedWithCustomError(vault, "ExceededCollectedFees")
            .withArgs(USDC(7), USDC(6));
    });
});
