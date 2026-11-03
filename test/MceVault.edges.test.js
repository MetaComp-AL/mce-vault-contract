const { expect } = require("chai");
const { ethers, upgrades } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const {
    ONE_DAY, USDC, NAV_PRECISION, FEE_PRECISION, INIT_DEFAULTS,
    deployVault, vaultFixture, kytDeposit,
} = require("./fixture");

// 初始化校验、重入守卫、以及各处 revert 边界
describe("MceVault 边界与防护", function () {
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

    /* -------------------------------------------------------- 初始化 */

    it("初始化：零地址、非整天锁定期、申赎下限为 0 被拒，锁定期 0 放行", async function () {
        const assetAddr = await usdc.getAddress();
        const ok = [admin.address, assetAddr, custodian.address, ONE_DAY, true, false, ...INIT_DEFAULTS, "N", "S"];
        const bad = [
            [ethers.ZeroAddress, assetAddr, custodian.address, ONE_DAY, true, false, ...INIT_DEFAULTS, "N", "S"], // admin
            [admin.address, ethers.ZeroAddress, custodian.address, ONE_DAY, true, false, ...INIT_DEFAULTS, "N", "S"], // asset
            [admin.address, assetAddr, ethers.ZeroAddress, ONE_DAY, true, false, ...INIT_DEFAULTS, "N", "S"], // custodian
            [admin.address, assetAddr, custodian.address, ONE_DAY + 1, true, false, ...INIT_DEFAULTS, "N", "S"], // 不是整天
            [admin.address, assetAddr, custodian.address, ONE_DAY, true, false, USDC(10_000_000), USDC(10_000_000), 0, USDC(1), true, true, "N", "S"], // 申购下限 0
            [admin.address, assetAddr, custodian.address, ONE_DAY, true, false, USDC(10_000_000), USDC(10_000_000), USDC(1), 0, true, true, "N", "S"], // 赎回下限 0
        ];

        for (const args of bad) {
            await expect(deployVault(vaultFactory, args)).to.be.revertedWithCustomError(
                vaultFactory, "InvalidInput"
            );
        }
        await expect(deployVault(vaultFactory, ok)).to.not.be.reverted;

        // 锁定期 0 与 setMaturityPeriod 对齐：允许，新份额铸出即可赎回
        const v0 = await deployVault(vaultFactory, [
            admin.address, assetAddr, custodian.address, 0, true, false, ...INIT_DEFAULTS, "N0", "S0",
        ]);
        expect(await v0.maturityPeriod()).to.equal(0);

        await v0.grantRole(await v0.CONTROLLER(), controller.address);
        await v0.grantRole(await v0.KYT_REPORTER_ROLE(), kyt.address);
        await usdc.connect(alice).approve(await v0.getAddress(), ethers.MaxUint256);
        await kytDeposit(kyt, controller)(v0, alice, USDC(1000));

        // 解锁时间记为当天零点，不用等切点，当场就能赎回
        const now = await time.latest();
        const [times] = await v0.getAllBatches(alice.address);
        expect(times[0]).to.equal(BigInt(now - (now % ONE_DAY)));
        expect(await v0.getAvailableShares(alice.address, now)).to.equal(USDC(1000));
        await expect(v0.connect(alice).redeem(USDC(100), alice.address, alice.address)).to.not.be.reverted;
    });

    it("初始化：实现合约本身不能被初始化，代理也不能重复初始化", async function () {
        await expect(
            vault.initialize(admin.address, await usdc.getAddress(), custodian.address, ONE_DAY, true, false, ...INIT_DEFAULTS, "N", "S")
        ).to.be.revertedWithCustomError(vault, "InvalidInitialization");

        const implAddr = await upgrades.erc1967.getImplementationAddress(await vault.getAddress());
        const impl = vaultFactory.attach(implAddr);
        await expect(
            impl.initialize(admin.address, await usdc.getAddress(), custodian.address, ONE_DAY, true, false, ...INIT_DEFAULTS, "N", "S")
        ).to.be.revertedWithCustomError(vault, "InvalidInitialization");
    });

    /* -------------------------------------------------------- 重入守卫 */

    it("重入：申购过程中回调 deposit 会被守卫挡住", async function () {
        const evil = await (await ethers.getContractFactory("MockReentrantERC20")).deploy(6);
        const evilVault = await deployVault(vaultFactory, [
            admin.address, await evil.getAddress(), custodian.address, ONE_DAY, true, false, ...INIT_DEFAULTS, "EVIL", "EVIL",
        ]);
        await evil.mint(alice.address, USDC(1000));
        await evil.connect(alice).approve(await evilVault.getAddress(), ethers.MaxUint256);

        // 收款时回调 deposit：外层已进入 nonReentrant，内层必须失败
        const payload = evilVault.interface.encodeFunctionData("deposit", [USDC(1), alice.address]);
        await evil.setAttack(await evilVault.getAddress(), payload);

        await expect(
            evilVault.connect(alice).deposit(USDC(100), alice.address)
        ).to.be.revertedWithCustomError(evilVault, "ReentrantCall");
    });

    it("重入：兑付过程中回调 executeDeposit 会被守卫挡住", async function () {
        const evil = await (await ethers.getContractFactory("MockReentrantERC20")).deploy(6);
        const evilVault = await deployVault(vaultFactory, [
            admin.address, await evil.getAddress(), custodian.address, ONE_DAY, true, false, ...INIT_DEFAULTS, "EVIL", "EVIL",
        ]);
        await evilVault.grantRole(await evilVault.CONTROLLER(), controller.address);
        await evilVault.grantRole(await evilVault.KYT_REPORTER_ROLE(), kyt.address);

        await evil.mint(alice.address, USDC(1000));
        await evil.connect(alice).approve(await evilVault.getAddress(), ethers.MaxUint256);
        await evilVault.connect(alice).deposit(USDC(100), alice.address);
        await evilVault.connect(kyt).submitKytResult(1, false); // 拒绝 -> 执行时要退款转账

        const payload = evilVault.interface.encodeFunctionData("executeDeposit", [1]);
        await evil.setAttack(await evilVault.getAddress(), payload);

        await expect(
            evilVault.connect(controller).executeDeposit(1)
        ).to.be.revertedWithCustomError(evilVault, "ReentrantCall");
    });

    /* ------------------------------------------------------ 份额转账 */

    it("转账：转 0 和自己转给自己都不动链表", async function () {
        await deposit(vault, alice, USDC(300));
        const [timesBefore, sharesBefore] = await vault.getAllBatches(alice.address);

        await expect(vault.connect(alice).transfer(bob.address, 0)).to.not.be.reverted;
        expect((await vault.getAllBatches(bob.address))[0].length).to.equal(0);

        await expect(vault.connect(alice).transfer(alice.address, USDC(100))).to.not.be.reverted;
        const [timesAfter, sharesAfter] = await vault.getAllBatches(alice.address);
        expect(timesAfter).to.deep.equal(timesBefore);
        expect(sharesAfter).to.deep.equal(sharesBefore);
        expect(await vault.balanceOf(alice.address)).to.equal(USDC(300));
    });

    it("转账：余额不足时按 ERC20 规则失败，链表不被破坏", async function () {
        await deposit(vault, alice, USDC(100));
        await expect(
            vault.connect(alice).transfer(bob.address, USDC(101))
        ).to.be.revertedWithCustomError(vault, "ERC20InsufficientBalance");
        expect(await vault.balanceOf(alice.address)).to.equal(USDC(100));
    });

    /* --------------------------------------------------------- KYT */

    it("KYT：只拉黑收款人时，代存也会被挡住", async function () {
        await vault.connect(controller).toggleReceiverEqSender(false);
        await vault.setDepositBlacklisted(bob.address, true);

        // alice 自己没被拉黑，但份额要给被拉黑的 bob
        await expect(vault.connect(alice).deposit(USDC(100), bob.address))
            .to.be.revertedWithCustomError(vault, "DepositBlacklisted")
            .withArgs(bob.address);
        // 给自己存不受影响
        await expect(vault.connect(alice).deposit(USDC(100), alice.address)).to.not.be.reverted;
    });

    it("KYT：拒绝时付款人与接收人一起拉黑", async function () {
        await vault.connect(controller).toggleReceiverEqSender(false);
        await vault.connect(alice).deposit(USDC(100), bob.address);
        await vault.connect(kyt).submitKytResult(1, false);
        await vault.connect(controller).executeDeposit(1);

        expect(await vault.depositBlacklist(alice.address)).to.equal(true);
        expect(await vault.depositBlacklist(bob.address)).to.equal(true);
    });

    it("KYT：黑名单 setter 的零地址与重复设置会被拒", async function () {
        await expect(
            vault.setDepositBlacklisted(ethers.ZeroAddress, true)
        ).to.be.revertedWithCustomError(vault, "InvalidInput");
        // 本来就不在名单里，再设 false 是无意义操作
        await expect(
            vault.setDepositBlacklisted(alice.address, false)
        ).to.be.revertedWithCustomError(vault, "InvalidInput");
        await expect(
            vault.connect(controller).setDepositBlacklisted(alice.address, true)
        ).to.be.revertedWithCustomError(vault, "AccessControlUnauthorizedAccount");

        await vault.setDepositBlacklisted(alice.address, true);
        await expect(
            vault.setDepositBlacklisted(alice.address, true)
        ).to.be.revertedWithCustomError(vault, "InvalidInput");
    });

    it("KYT：单号 0 与超范围都不合法", async function () {
        for (const id of [0, 1]) {
            await expect(vault.connect(kyt).submitKytResult(id, true))
                .to.be.revertedWithCustomError(vault, "InvalidDepositId")
                .withArgs(id);
            await expect(vault.connect(controller).executeDeposit(id))
                .to.be.revertedWithCustomError(vault, "InvalidDepositId")
                .withArgs(id);
        }
    });

    /* -------------------------------------------------- 批量指定兑付 */

    it("fulfillSpecificRequests：一次兑付多笔，空数组与超批量上限被拒", async function () {
        // 造三笔队列请求：先抽干流动性，再让三个人各赎回一次
        await deposit(vault, alice, USDC(3000));
        await deposit(vault, bob, USDC(3000));
        // 两人同一结算窗口入场，解锁时间相同
        const [times] = await vault.getAllBatches(bob.address);
        await time.increaseTo(times[times.length - 1]);
        await vault.connect(controller).withdrawToCustodian(USDC(6000));

        await vault.connect(alice).redeem(USDC(1000), alice.address, alice.address); // 1
        await vault.connect(bob).redeem(USDC(1000), bob.address, bob.address);       // 2
        await vault.connect(alice).redeem(USDC(1000), alice.address, alice.address); // 3
        expect(await vault.totalPendingWithdrawals()).to.equal(USDC(3000));

        await expect(
            vault.connect(controller).fulfillSpecificRequests([])
        ).to.be.revertedWithCustomError(vault, "InvalidInput");
        await expect(
            vault.connect(controller).fulfillSpecificRequests(new Array(51).fill(1))
        ).to.be.revertedWithCustomError(vault, "InvalidInput");

        // 流动性只够两笔：整批回滚，不存在部分成功
        await vault.connect(controller).depositFromCustodian(USDC(2000));
        await expect(
            vault.connect(controller).fulfillSpecificRequests([1, 2, 3])
        ).to.be.revertedWithCustomError(vault, "InsufficientLiquidity");
        expect(await vault.totalPendingWithdrawals()).to.equal(USDC(3000));

        // 乱序批量兑付，不受 FIFO 约束
        await vault.connect(controller).fulfillSpecificRequests([3, 1]);
        expect(await vault.totalPendingWithdrawals()).to.equal(USDC(1000));
        const [r1, r2, r3] = await vault.getWithdrawalStatus([1, 2, 3]);
        expect([r1.fulfilled, r2.fulfilled, r3.fulfilled]).to.deep.equal([true, false, true]);

        // 批次里混入已兑付的，整批回滚
        await vault.connect(controller).depositFromCustodian(USDC(1000));
        await expect(
            vault.connect(controller).fulfillSpecificRequests([2, 1])
        ).to.be.revertedWithCustomError(vault, "InvalidInput");
        await expect(
            vault.connect(controller).fulfillSpecificRequests([2, 99])
        ).to.be.revertedWithCustomError(vault, "InvalidRequestId");
        expect((await vault.getWithdrawalStatus([2]))[0].fulfilled).to.equal(false);

        await vault.connect(controller).fulfillSpecificRequests([2]);
        expect(await vault.totalPendingWithdrawals()).to.equal(0);

        // 只有 CONTROLLER 能调
        await expect(
            vault.connect(alice).fulfillSpecificRequests([1])
        ).to.be.revertedWithCustomError(vault, "AccessControlUnauthorizedAccount");
    });

    /* ---------------------------------------------------------- 费率 */

    it("费率：赎回费同样受 1% 上限约束", async function () {
        await expect(
            vault.connect(controller).setWithdrawFee(10_001)
        ).to.be.revertedWithCustomError(vault, "InvalidInput");
        await expect(vault.connect(controller).setWithdrawFee(10_000))
            .to.emit(vault, "ConfigUpdated")
            .withArgs(0, 10_000, 5); // ConfigType.WITHDRAW_FEE_BPS
        expect(await vault.MAX_FEE_BPS()).to.equal(10_000);
    });

    /* ---------------------------------------------------------- NAV */

    it("NAV：净值为 0 之后仍能继续上报，不会卡死在除零上", async function () {
        await vault.connect(controller).setMaxFluctuationBps(FEE_PRECISION);
        const t1 = BigInt(await time.latest());
        await vault.connect(reporter).handleOracleReport({
            accountingTimestamp: t1, submitTimestamp: t1, reportId: 1,
            todayNav: 0, reporter: reporter.address,
        });
        expect(await vault.latestNav()).to.equal(0);

        // latestNav == 0 时跳过波动校验，直接接受下一次上报
        await time.increase(ONE_DAY);
        await vault.connect(reporter).handleOracleReport({
            accountingTimestamp: t1 + BigInt(ONE_DAY), submitTimestamp: t1 + BigInt(ONE_DAY),
            reportId: 2, todayNav: NAV_PRECISION, reporter: reporter.address,
        });
        expect(await vault.latestNav()).to.equal(NAV_PRECISION);
    });

    it("NAV：会计日必须严格加一天，早于上一次也不行", async function () {
        const t1 = BigInt(await time.latest());
        await vault.connect(reporter).handleOracleReport({
            accountingTimestamp: t1, submitTimestamp: t1, reportId: 1,
            todayNav: NAV_PRECISION, reporter: reporter.address,
        });

        await time.increase(ONE_DAY * 3);
        // 跳了两天
        await expect(
            vault.connect(reporter).handleOracleReport({
                accountingTimestamp: t1 + BigInt(ONE_DAY * 2), submitTimestamp: t1,
                reportId: 2, todayNav: NAV_PRECISION, reporter: reporter.address,
            })
        ).to.be.revertedWithCustomError(vault, "InvalidReport");

        // 会计日不变
        await expect(
            vault.connect(reporter).handleOracleReport({
                accountingTimestamp: t1, submitTimestamp: t1,
                reportId: 2, todayNav: NAV_PRECISION, reporter: reporter.address,
            })
        ).to.be.revertedWithCustomError(vault, "InvalidReport");
    });

    it("NAV：只能修改最后一天，波动按前一天的 NAV 校验", async function () {
        const report = (accountingTimestamp, reportId, todayNav) => vault.connect(reporter).handleOracleReport({
            accountingTimestamp, submitTimestamp: accountingTimestamp, reportId, todayNav, reporter: reporter.address,
        });
        const nav = (pct) => (NAV_PRECISION * BigInt(pct)) / 100n;
        const t1 = BigInt(await time.latest());
        const t2 = t1 + BigInt(ONE_DAY);
        await report(t1, 1, nav(100));
        await time.increase(ONE_DAY);
        await report(t2, 2, nav(110));

        // 相对当前 1.10 只涨 9%，但相对前一天 1.00 涨了 20%，拒绝
        await expect(report(t2, 2, nav(120)))
            .to.be.revertedWithCustomError(vault, "InvalidNavFluctuation")
            .withArgs(nav(120), nav(100), 100_000);

        // 相对当前 1.10 跌了 13%，但相对前一天 1.00 只跌 5%，放行；可以反复修改
        await expect(report(t2, 2, nav(95)))
            .to.emit(vault, "OracleReportHandled")
            .withArgs(t2, 2, 0, nav(100), nav(95), 0, reporter.address);
        await report(t2, 2, nav(105));
        expect(await vault.latestNav()).to.equal(nav(105));
        expect(await vault.lastReportId()).to.equal(2);

        // 更早的天不能改
        await expect(report(t1, 1, nav(100))).to.be.reverted;

        // 修改后下一天照常 +1，基准是修改后的 NAV
        await time.increase(ONE_DAY);
        await expect(report(t2 + BigInt(ONE_DAY), 3, nav(115)))
            .to.emit(vault, "OracleReportHandled")
            .withArgs(t2 + BigInt(ONE_DAY), 3, 0, nav(105), nav(115), 0, reporter.address);
    });

    /* -------------------------------------------------------- 队列 */

    it("队列：budget 为 0 被拒，队列空时批量兑付是空转不报错", async function () {
        await expect(
            vault.connect(controller).fulfillPendingWithdrawals(0)
        ).to.be.revertedWithCustomError(vault, "InvalidInput");

        await expect(vault.connect(controller).fulfillPendingWithdrawals(USDC(1000))).to.not.be.reverted;
        expect(await vault.lastProcessedRequestId()).to.equal(0);
    });

    it("队列：已兑付的请求会被批量兑付跳过，游标继续前进", async function () {
        await deposit(vault, alice, USDC(1000));
        await deposit(vault, bob, USDC(1000));
        await time.increaseTo((await vault.getAllBatches(bob.address))[0][0]);
        await vault.connect(controller).withdrawToCustodian(USDC(2000));

        await vault.connect(alice).redeem(USDC(1000), alice.address, alice.address); // id 1
        await vault.connect(bob).redeem(USDC(1000), bob.address, bob.address); // id 2
        await vault.connect(controller).depositFromCustodian(USDC(2000));

        // 先单独兑付 id 1，再批量：id 1 已 fulfilled，游标应直接推过它
        await vault.connect(controller).fulfillSpecificRequest(1);
        await vault.connect(controller).fulfillPendingWithdrawals(USDC(2000));

        expect(await vault.lastProcessedRequestId()).to.equal(2);
        expect(await vault.totalPendingWithdrawals()).to.equal(0);
    });
});
