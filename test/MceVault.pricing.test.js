const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { anyValue } = require("@nomicfoundation/hardhat-chai-matchers/withArgs");
const {
    ONE_DAY, USDC, NAV_PRECISION, FEE_PRECISION, vaultFixture, kytDeposit,
} = require("./fixture");

// 定价、预览、上限、NAV 上报校验、每日额度 —— 审计会逐个核对舍入方向
describe("MceVault 定价与额度", function () {
    let admin, controller, reporter, alice, bob, custodian, kyt;
    let usdc, vault;
    let deposit;

    beforeEach(async function () {
        ({
            admin, controller, reporter, alice, bob, custodian, kyt, usdc, vault,
        } = await loadFixture(vaultFixture));
        deposit = kytDeposit(kyt, controller);
    });

    async function unlockLatestBatch(owner) {
        const [times] = await vault.getAllBatches(owner.address);
        await time.increaseTo(times[times.length - 1]);
    }

    // 上报一次 NAV，会计日取当前时间
    async function reportNav(nav) {
        const now = BigInt(await time.latest());
        const lastId = await vault.lastReportId();
        return vault.connect(reporter).handleOracleReport({
            accountingTimestamp: now,
            submitTimestamp: now,
            reportId: lastId + 1n,
            todayNav: nav,
            reporter: reporter.address,
        });
    }

    /* ------------------------------------------------------- 换算与预览 */

    it("换算：NAV = 1 时 1:1，NAV 变化后按比例，且 convert 不含手续费", async function () {
        expect(await vault.convertToShares(USDC(1000))).to.equal(USDC(1000));
        expect(await vault.convertToAssets(USDC(1000))).to.equal(USDC(1000));

        await vault.connect(controller).setDepositFee(10_000); // 1%
        // convertToShares 是纯净值换算，不扣费
        expect(await vault.convertToShares(USDC(1000))).to.equal(USDC(1000));

        await reportNav((NAV_PRECISION * 105n) / 100n); // +5%
        expect(await vault.convertToAssets(USDC(1000))).to.equal(USDC(1050));
        // 1000 / 1.05 向下取整
        expect(await vault.convertToShares(USDC(1000))).to.equal(952380952n);
    });

    it("换算：NAV 为 0 时回退成 1:1（不会除零）", async function () {
        // 默认波动上限 10% 会挡住直接归零，先放开
        await vault.connect(controller).setMaxFluctuationBps(FEE_PRECISION);
        await reportNav(0);

        expect(await vault.latestNav()).to.equal(0);
        expect(await vault.convertToShares(USDC(100))).to.equal(USDC(100));
        expect(await vault.convertToAssets(USDC(100))).to.equal(USDC(100));
        expect(await vault.totalAssets()).to.equal(0); // 没有 supply
    });

    it("预览：4 个标准 preview 与对应的 WithFee 版本口径一致", async function () {
        await vault.connect(controller).setDepositFee(10_000); // 1%
        await vault.connect(controller).setWithdrawFee(5_000); // 0.5%
        await reportNav((NAV_PRECISION * 103n) / 100n); // 让净值不等于 1，暴露舍入差异

        const assets = USDC(1000);
        const shares = USDC(500);

        const [dShares, dFee] = await vault.previewDepositWithFee(assets);
        expect(await vault.previewDeposit(assets)).to.equal(dShares);
        expect(dFee).to.equal(USDC(10));
        // 净额换份数，向下取整（对 Vault 有利）
        expect(dShares).to.equal(((assets - dFee) * NAV_PRECISION) / ((NAV_PRECISION * 103n) / 100n));

        const [mAssets, mFee] = await vault.previewMintWithFee(shares);
        expect(await vault.previewMint(shares)).to.equal(mAssets);
        // 外加口径：净额按 Ceil 计价，不会少收；付这笔钱至少能换回 shares
        expect(mAssets - mFee).to.be.gte(await vault.convertToAssets(shares));
        expect(await vault.previewDeposit(mAssets)).to.be.gte(shares);

        const [wShares, wFee] = await vault.previewWithdrawWithFee(assets);
        expect(await vault.previewWithdraw(assets)).to.equal(wShares);
        expect(wFee).to.be.gt(0);

        const [rAssets, rFee] = await vault.previewRedeemWithFee(shares);
        expect(await vault.previewRedeem(shares)).to.equal(rAssets);
        expect(rAssets + rFee).to.equal(await vault.convertToAssets(shares));
    });

    it("预览：零费率下 deposit/mint 与 withdraw/redeem 互为逆运算", async function () {
        const [shares] = await vault.previewDepositWithFee(USDC(1000));
        expect(await vault.previewMint(shares)).to.equal(USDC(1000));

        const [needShares] = await vault.previewWithdrawWithFee(USDC(1000));
        expect(await vault.previewRedeem(needShares)).to.equal(USDC(1000));
    });

    /* ----------------------------------------------------------- 上限 */

    it("上限：maxDeposit / maxMint 随 maxSupply 和待审核份额收缩，占满后归零", async function () {
        expect(await vault.maxDeposit(alice.address)).to.equal(USDC(10_000_000));
        expect(await vault.maxMint(alice.address)).to.equal(USDC(10_000_000));

        await vault.connect(controller).setMaxSupply(USDC(1000));
        expect(await vault.maxDeposit(alice.address)).to.equal(USDC(1000));

        // 待审核份额也占额度
        await vault.connect(alice).deposit(USDC(400), alice.address);
        expect(await vault.maxDeposit(alice.address)).to.equal(USDC(600));
        expect(await vault.maxMint(alice.address)).to.equal(USDC(600));

        // 执行后额度从"待审核"转成"已铸"，总量不变
        const id = await vault.lastDepositId();
        await vault.connect(kyt).submitKytResult(id, true);
        await vault.connect(controller).executeDeposit(id);
        expect(await vault.maxDeposit(alice.address)).to.equal(USDC(600));

        // 占满后归零
        await deposit(vault, bob, USDC(600));
        expect(await vault.maxDeposit(alice.address)).to.equal(0);
        expect(await vault.maxMint(alice.address)).to.equal(0);
        await expect(
            vault.connect(alice).deposit(USDC(1), alice.address)
        ).to.be.revertedWithCustomError(vault, "ExceededMaxSupply");
        await expect(
            vault.connect(alice).mint(USDC(1), alice.address)
        ).to.be.revertedWithCustomError(vault, "ExceededMaxSupply");
    });

    it("上限：maxWithdraw / maxRedeem 只看解锁进度，不看流动性", async function () {
        await deposit(vault, alice, USDC(1000));
        // 还没解锁
        expect(await vault.maxRedeem(alice.address)).to.equal(0);
        expect(await vault.maxWithdraw(alice.address)).to.equal(0);

        await unlockLatestBatch(alice);
        expect(await vault.maxRedeem(alice.address)).to.equal(USDC(1000));
        expect(await vault.maxWithdraw(alice.address)).to.equal(USDC(1000));

        // 把钱全挪走，额度不变（因为流动性不足是排队而不是失败）
        await vault.connect(controller).withdrawToCustodian(USDC(1000));
        expect(await vault.maxRedeem(alice.address)).to.equal(USDC(1000));
        expect(await vault.maxWithdraw(alice.address)).to.equal(USDC(1000));

        // 赎回费会压低 maxWithdraw（能取出的钱），但不影响 maxRedeem（能烧掉的份额）
        await vault.connect(controller).setWithdrawFee(10_000); // 1%
        expect(await vault.maxRedeem(alice.address)).to.equal(USDC(1000));
        expect(await vault.maxWithdraw(alice.address)).to.equal(USDC(990));
    });

    it("申购：份额算出来为 0 时直接拒绝，不静默吞掉本金", async function () {
        await vault.connect(controller).setMinDepositLimit(1); // 1e-6 USDC
        await reportNav((NAV_PRECISION * 11n) / 10n); // NAV = 1.1

        // 1e-6 * 1e13 / 1.1e13 = 0
        await expect(
            vault.connect(alice).deposit(1, alice.address)
        ).to.be.revertedWithCustomError(vault, "ZeroResult");
    });

    it("赎回：到手金额被手续费吃到 0 时直接拒绝，不白烧份额", async function () {
        await deposit(vault, alice, USDC(1000));
        await unlockLatestBatch(alice);
        await vault.connect(controller).setMinRedeemLimit(1);
        await vault.connect(controller).setWithdrawFee(10_000); // 1%

        // 赎 1 wei 份额：assets = 1，fee 向上取整也是 1，到手 0
        await expect(
            vault.connect(alice).redeem(1, alice.address, alice.address)
        ).to.be.revertedWithCustomError(vault, "ZeroResult");
        // 份额没被扣掉
        expect(await vault.balanceOf(alice.address)).to.equal(USDC(1000));
    });

    /* ------------------------------------------------------- NAV 上报 */

    it("NAV 上报：会计日不能落在未来", async function () {
        const future = BigInt(await time.latest()) + BigInt(ONE_DAY);
        await expect(
            vault.connect(reporter).handleOracleReport({
                accountingTimestamp: future,
                submitTimestamp: future,
                reportId: 1,
                todayNav: NAV_PRECISION,
                reporter: reporter.address,
            })
        ).to.be.revertedWithCustomError(vault, "InvalidAccountingTimestamp");
    });

    it("NAV 上报：单日波动超上限被拦，调高上限后放行", async function () {
        // 默认上限 10%，直接报 +20% 会被拒
        await expect(reportNav((NAV_PRECISION * 12n) / 10n))
            .to.be.revertedWithCustomError(vault, "InvalidNavFluctuation")
            .withArgs((NAV_PRECISION * 12n) / 10n, NAV_PRECISION, 100_000);

        // 反方向同样受限
        await expect(
            reportNav((NAV_PRECISION * 8n) / 10n)
        ).to.be.revertedWithCustomError(vault, "InvalidNavFluctuation");

        await vault.connect(controller).setMaxFluctuationBps(300_000); // 30%
        await expect(reportNav((NAV_PRECISION * 12n) / 10n)).to.emit(vault, "OracleReportHandled");
        expect(await vault.latestNav()).to.equal((NAV_PRECISION * 12n) / 10n);
    });

    it("NAV 上报：事件带上前后净值与当时的总份额", async function () {
        await deposit(vault, alice, USDC(1000));
        const nav = (NAV_PRECISION * 101n) / 100n;

        await expect(reportNav(nav))
            .to.emit(vault, "OracleReportHandled")
            .withArgs(anyValue, 1, USDC(1000), NAV_PRECISION, nav, 0, reporter.address);

        expect(await vault.lastReportId()).to.equal(1);
        expect(await vault.totalAssets()).to.equal(USDC(1010));
    });

    /* --------------------------------------------------- 每日即时额度 */

    it("每日额度：超出额度的赎回转排队，跨日后额度重置", async function () {
        await vault.connect(controller).updatePersonalDailyWithdrawQuota(USDC(300));
        await deposit(vault, alice, USDC(1000));
        await unlockLatestBatch(alice);

        let [quota, day] = await vault.getUserDailyWithdrawQuota(alice.address);
        expect(quota).to.equal(USDC(300));

        // 额度内即时到账
        const before = await usdc.balanceOf(alice.address);
        await vault.connect(alice).redeem(USDC(200), alice.address, alice.address);
        expect(await usdc.balanceOf(alice.address)).to.equal(before + USDC(200));
        [quota] = await vault.getUserDailyWithdrawQuota(alice.address);
        expect(quota).to.equal(USDC(100));

        // 超出剩余额度 -> 排队，即使 Vault 里钱够
        expect(await vault.availableLiquidity()).to.equal(USDC(800));
        await expect(vault.connect(alice).redeem(USDC(200), alice.address, alice.address))
            .to.emit(vault, "WithdrawalRequested")
            .withArgs(1, alice.address, alice.address, alice.address, anyValue, USDC(200));

        // 跨到第二天，额度回满
        await time.increase(ONE_DAY);
        [quota, day] = await vault.getUserDailyWithdrawQuota(alice.address);
        expect(quota).to.equal(USDC(300));
        const before2 = await usdc.balanceOf(alice.address);
        await vault.connect(alice).redeem(USDC(300), alice.address, alice.address);
        expect(await usdc.balanceOf(alice.address)).to.equal(before2 + USDC(300));
    });

    it("每日额度：额度是按地址算的，互不影响", async function () {
        await vault.connect(controller).updatePersonalDailyWithdrawQuota(USDC(300));
        await deposit(vault, alice, USDC(1000));
        await deposit(vault, bob, USDC(1000));
        await unlockLatestBatch(bob);

        await vault.connect(alice).redeem(USDC(300), alice.address, alice.address);
        const [aliceQuota] = await vault.getUserDailyWithdrawQuota(alice.address);
        const [bobQuota] = await vault.getUserDailyWithdrawQuota(bob.address);
        expect(aliceQuota).to.equal(0);
        expect(bobQuota).to.equal(USDC(300));

        // bob 的额度没被 alice 用掉
        const before = await usdc.balanceOf(bob.address);
        await vault.connect(bob).redeem(USDC(300), bob.address, bob.address);
        expect(await usdc.balanceOf(bob.address)).to.equal(before + USDC(300));
    });

    /* -------------------------------------------------- mint / withdraw */

    it("mint：按精确份数申购，同样要过 KYT，费用外加", async function () {
        await vault.connect(controller).setDepositFee(10_000); // 1%
        const [expectAssets, expectFee] = await vault.previewMintWithFee(USDC(1000));

        const before = await usdc.balanceOf(alice.address);
        await expect(vault.connect(alice).mint(USDC(1000), alice.address))
            .to.emit(vault, "DepositRequested")
            .withArgs(1, alice.address, alice.address, expectAssets, USDC(1000), expectFee);

        // 钱按"外加"口径扣，份额还没发
        expect(await usdc.balanceOf(alice.address)).to.equal(before - expectAssets);
        expect(await vault.balanceOf(alice.address)).to.equal(0);

        await vault.connect(kyt).submitKytResult(1, true);
        await vault.connect(controller).executeDeposit(1);

        // 拿到的正是请求的份数
        expect(await vault.balanceOf(alice.address)).to.equal(USDC(1000));
        expect(await vault.totalFeesCollected()).to.equal(expectFee);
    });

    it("withdraw：取出精确金额，销毁的份额按赎回费反推", async function () {
        await vault.connect(controller).setWithdrawFee(10_000); // 1%
        await deposit(vault, alice, USDC(1000));
        await unlockLatestBatch(alice);

        const [expectShares, expectFee] = await vault.previewWithdrawWithFee(USDC(500));
        const before = await usdc.balanceOf(alice.address);

        await expect(vault.connect(alice).withdraw(USDC(500), alice.address, alice.address))
            .to.emit(vault, "CustomWithdraw")
            .withArgs(alice.address, alice.address, alice.address, USDC(500), expectShares, expectFee, 0);

        // 到手正好 500，份额按含费口径扣
        expect(await usdc.balanceOf(alice.address)).to.equal(before + USDC(500));
        expect(await vault.balanceOf(alice.address)).to.equal(USDC(1000) - expectShares);
        expect(await vault.totalFeesCollected()).to.equal(expectFee);
    });

    it("withdraw：未解锁的份额取不出来", async function () {
        await deposit(vault, alice, USDC(1000));
        await expect(
            vault.connect(alice).withdraw(USDC(100), alice.address, alice.address)
        ).to.be.revertedWithCustomError(vault, "InsufficientUnlockedShares");
    });

    /* ------------------------------------------------------- 批次查询 */

    it("批次查询：getBatch 返回单批明细与链表指针", async function () {
        await deposit(vault, alice, USDC(300));
        const [times] = await vault.getAllBatches(alice.address);

        const [shares, next] = await vault.getBatch(alice.address, times[0]);
        expect(shares).to.equal(USDC(300));
        expect(next).to.equal(0); // 只有一个批次，下一个是哨兵

        // 跨窗口再申购，指针指向新批次
        await time.increaseTo(times[0]);
        await deposit(vault, alice, USDC(100));
        const [times2] = await vault.getAllBatches(alice.address);
        const [, next2] = await vault.getBatch(alice.address, times2[0]);
        expect(next2).to.equal(times2[1]);

        // 不存在的批次返回全 0
        const [none, noneNext] = await vault.getBatch(alice.address, 12345);
        expect(none).to.equal(0);
        expect(noneNext).to.equal(0);
    });
});
