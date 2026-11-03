const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
// 事件里的 block.timestamp 不做精确断言
const { anyValue } = require("@nomicfoundation/hardhat-chai-matchers/withArgs");
const {
  ONE_DAY, USDC, NAV_PRECISION, INIT_DEFAULTS, deployVault, vaultFixture, kytDeposit,
} = require("./fixture");

describe("MceVault", function () {
  let admin, controller, reporter, alice, bob, custodian, kyt;
  let usdc, vault, vaultFactory;
  let deposit;

  const wdToCustodian = (assets) => vault.connect(controller).withdrawToCustodian(assets);
  const dpFromCustodian = (assets) => vault.connect(controller).depositFromCustodian(assets);

  beforeEach(async function () {
    ({
      admin, controller, reporter, alice, bob, custodian, kyt,
      usdc, vault, vaultFactory,
    } = await loadFixture(vaultFixture));
    deposit = kytDeposit(kyt, controller);
  });

  // 认购后把时间推到该批次解锁
  async function unlockLatestBatch(owner) {
    const [times] = await vault.getAllBatches(owner.address);
    await time.increaseTo(times[times.length - 1]);
  }

  it("share token 元数据抄 SyncVault：name / symbol 可配，decimals 跟随资产", async function () {
    expect(await vault.name()).to.equal("VRPC-Weekly");
    expect(await vault.symbol()).to.equal("VRPCW");
    expect(await vault.decimals()).to.equal(6);
  });

  it("底层资产通用：18 位小数的资产也能跑通，限额按资产精度传入或折算", async function () {
    const dai = await (await ethers.getContractFactory("MockERC20")).deploy("Mock DAI", "DAI", 18);
    const E18 = (n) => ethers.parseUnits(String(n), 18);
    const v18 = await deployVault(vaultFactory, [
      admin.address, await dai.getAddress(), custodian.address, ONE_DAY, true, false, E18(10_000_000), E18(10_000_000), E18(1), E18(1), true, true, "VRPC-18", "VRPC18",
    ]);

    await v18.grantRole(await v18.CONTROLLER(), controller.address);
    await v18.grantRole(await v18.KYT_REPORTER_ROLE(), kyt.address);

    expect(await v18.decimals()).to.equal(18);
    expect(await v18.minDepositLimit()).to.equal(E18(1));
    expect(await v18.minRedeemLimit()).to.equal(E18(1));
    expect(await v18.maxDepositLimit()).to.equal(E18(10_000_000));
    expect(await v18.maxSupply()).to.equal(E18(10_000_000));
    expect(await v18.walletDailyInstantWithdrawQuota()).to.equal(E18(10_000));

    await dai.mint(alice.address, E18(1000));
    await dai.connect(alice).approve(await v18.getAddress(), ethers.MaxUint256);
    await deposit(v18, alice, E18(1000));
    expect(await v18.balanceOf(alice.address)).to.equal(E18(1000));

    // 走完一整轮：解锁后即时赎回
    const [times] = await v18.getAllBatches(alice.address);
    await time.increaseTo(times[0]);
    await v18.connect(alice).redeem(E18(1000), alice.address, alice.address);
    expect(await dai.balanceOf(alice.address)).to.equal(E18(1000));
  });

  it("需求1：存入的资产留在 Vault，不自动转走", async function () {
    await deposit(vault, alice, USDC(1000));

    expect(await vault.vaultBalance()).to.equal(USDC(1000));
    expect(await vault.availableLiquidity()).to.equal(USDC(1000));
    expect(await vault.balanceOf(alice.address)).to.equal(USDC(1000));
  });

  it("需求1：controller 可随意提取 Vault 资产到 custodian 并发事件", async function () {
    await deposit(vault, alice, USDC(1000));

    const custodianBefore = await usdc.balanceOf(custodian.address);
    await expect(wdToCustodian(USDC(1000)))
      .to.emit(vault, "AssetWithdrawnToCustodian")
      .withArgs(controller.address, custodian.address, USDC(1000), 0, 0);

    expect(await usdc.balanceOf(custodian.address)).to.equal(custodianBefore + USDC(1000));
    expect(await vault.vaultBalance()).to.equal(0);
    // share 不受影响，NAV 口径的 totalAssets 也不受影响
    expect(await vault.totalAssets()).to.equal(USDC(1000));

    // admin 没有 CONTROLLER 角色，提不了
    await expect(vault.withdrawToCustodian(USDC(1))).to.be.revertedWithCustomError(
      vault,
      "AccessControlUnauthorizedAccount"
    );
  });

  it("分权：custodianWallet 只能由 admin 改，controller 改不了", async function () {
    await expect(vault.setCustodianWallet(bob.address))
      .to.emit(vault, "CustodianWalletUpdated")
      .withArgs(custodian.address, bob.address);
    expect(await vault.custodianWallet()).to.equal(bob.address);

    await expect(
      vault.connect(controller).setCustodianWallet(controller.address)
    ).to.be.revertedWithCustomError(vault, "AccessControlUnauthorizedAccount");

    await expect(vault.setCustodianWallet(ethers.ZeroAddress)).to.be.revertedWithCustomError(
      vault,
      "InvalidInput"
    );
  });

  it("需求2：controller 回款发事件，资金从 custodian 出", async function () {
    const custodianBefore = await usdc.balanceOf(custodian.address);
    await expect(dpFromCustodian(USDC(500)))
      .to.emit(vault, "AssetDepositedFromCustodian")
      .withArgs(controller.address, custodian.address, USDC(500), USDC(500), 0);

    // 钱从 custodian 扣，不从 controller 扣
    expect(await usdc.balanceOf(custodian.address)).to.equal(custodianBefore - USDC(500));

    expect(await vault.vaultBalance()).to.equal(USDC(500));
    // 回款不铸 share
    expect(await vault.totalSupply()).to.equal(0);
  });

  it("取款/回款只搬底层资产，金额为 0 被拒", async function () {
    await deposit(vault, alice, USDC(1000));

    await expect(
      vault.connect(controller).withdrawToCustodian(0)
    ).to.be.revertedWithCustomError(vault, "InvalidInput");
    await expect(
      vault.connect(controller).depositFromCustodian(0)
    ).to.be.revertedWithCustomError(vault, "InvalidInput");

    // 失败的调用没动余额
    expect(await vault.vaultBalance()).to.equal(USDC(1000));
  });

  it("白名单：admin 用一个方法增删，重复操作被拒", async function () {
    await expect(vault.setWhitelisted(alice.address, true))
      .to.emit(vault, "WhitelistUpdated")
      .withArgs(alice.address, true);
    expect(await vault.isWhitelisted(alice.address)).to.equal(true);

    await vault.setWhitelisted(bob.address, true);
    expect(await vault.whitelist()).to.deep.equal([alice.address, bob.address]);

    await vault.setWhitelisted(alice.address, false);
    expect(await vault.isWhitelisted(alice.address)).to.equal(false);

    // 重复加 / 删不存在的 / 零地址
    await expect(vault.setWhitelisted(bob.address, true))
      .to.be.revertedWithCustomError(vault, "InvalidInput");
    await expect(vault.setWhitelisted(alice.address, false))
      .to.be.revertedWithCustomError(vault, "InvalidInput");
    await expect(vault.setWhitelisted(ethers.ZeroAddress, true))
      .to.be.revertedWithCustomError(vault, "InvalidInput");

    // 只有 admin 能改
    await expect(
      vault.connect(controller).setWhitelisted(alice.address, true)
    ).to.be.revertedWithCustomError(vault, "AccessControlUnauthorizedAccount");
  });

  it("白名单未启用时不拦任何人，且开关在 initialize 后不可更改", async function () {
    expect(await vault.isWhitelistEnabled()).to.equal(false);
    // 名单是空的，但申购照样过
    await deposit(vault, alice, USDC(1000));
    expect(await vault.balanceOf(alice.address)).to.equal(USDC(1000));

    // 没有任何 setter 能改这个开关
    expect(vault.interface.fragments.some((f) => f.name === "setWhitelistEnabled")).to.equal(false);
  });

  it("白名单启用：申购、赎回、转账三条路径都要求地址在名单内", async function () {
    const v = await deployVault(vaultFactory, [
      admin.address, await usdc.getAddress(), custodian.address, ONE_DAY, true, true, ...INIT_DEFAULTS, "WL", "WL",
    ]);
    await v.grantRole(await v.CONTROLLER(), controller.address);
    await v.grantRole(await v.KYT_REPORTER_ROLE(), kyt.address);
    const vAddr = await v.getAddress();
    for (const u of [alice, bob]) {
      await usdc.connect(u).approve(vAddr, ethers.MaxUint256);
    }
    const dep = kytDeposit(kyt, controller);

    expect(await v.isWhitelistEnabled()).to.equal(true);

    // 不在名单内：申购被拒
    await expect(v.connect(alice).deposit(USDC(1000), alice.address))
      .to.be.revertedWithCustomError(v, "NotWhitelisted")
      .withArgs(alice.address);

    await v.setWhitelisted(alice.address, true);
    await dep(v, alice, USDC(1000));
    expect(await v.balanceOf(alice.address)).to.equal(USDC(1000));

    // 转账：接收方 bob 不在名单内
    const [times] = await v.getAllBatches(alice.address);
    await time.increaseTo(times[0]);
    await expect(v.connect(alice).transfer(bob.address, USDC(100)))
      .to.be.revertedWithCustomError(v, "NotWhitelisted")
      .withArgs(bob.address);

    await v.setWhitelisted(bob.address, true);
    await v.connect(alice).transfer(bob.address, USDC(100));
    expect(await v.balanceOf(bob.address)).to.equal(USDC(100));

    // 赎回：把 alice 移出名单后就赎不了
    await v.setWhitelisted(alice.address, false);
    await expect(v.connect(alice).redeem(USDC(100), alice.address, alice.address))
      .to.be.revertedWithCustomError(v, "NotWhitelisted")
      .withArgs(alice.address);

    await v.setWhitelisted(alice.address, true);
    await v.connect(alice).redeem(USDC(100), alice.address, alice.address);
  });

  it("申购开关 / 赎回开关：controller 可关可开，互不影响", async function () {
    await deposit(vault, alice, USDC(1000));
    await unlockLatestBatch(alice);

    expect(await vault.isDepositEnabled()).to.equal(true);
    expect(await vault.isRedeemEnabled()).to.equal(true);

    // 关申购：赎回不受影响
    await expect(vault.connect(controller).setDepositEnabled(false))
      .to.emit(vault, "ToggleDepositEnabled")
      .withArgs(false);
    await expect(
      vault.connect(alice).deposit(USDC(100), alice.address)
    ).to.be.revertedWithCustomError(vault, "DepositDisabled");
    await vault.connect(alice).redeem(USDC(100), alice.address, alice.address);

    // 关赎回：申购恢复后不受影响
    await vault.connect(controller).setDepositEnabled(true);
    await expect(vault.connect(controller).setRedeemEnabled(false))
      .to.emit(vault, "ToggleRedeemEnabled")
      .withArgs(false);
    await expect(
      vault.connect(alice).redeem(USDC(100), alice.address, alice.address)
    ).to.be.revertedWithCustomError(vault, "RedeemDisabled");
    await expect(
      vault.connect(alice).withdraw(USDC(100), alice.address, alice.address)
    ).to.be.revertedWithCustomError(vault, "RedeemDisabled");
    await vault.connect(alice).deposit(USDC(100), alice.address);

    // 重复设同一个值、非 controller 调用都被拒
    await expect(
      vault.connect(controller).setRedeemEnabled(false)
    ).to.be.revertedWithCustomError(vault, "InvalidInput");
    await expect(
      vault.connect(alice).setDepositEnabled(false)
    ).to.be.revertedWithCustomError(vault, "AccessControlUnauthorizedAccount");
  });

  it("share 转账开关：admin 可关可开，关闭时只挡转账不挡申赎", async function () {
    await deposit(vault, alice, USDC(1000));

    await expect(vault.setShareTransferable(false))
      .to.emit(vault, "ToggleShareTransferable")
      .withArgs(false);
    expect(await vault.isShareTransferable()).to.equal(false);

    await expect(
      vault.connect(alice).transfer(bob.address, USDC(100))
    ).to.be.revertedWithCustomError(vault, "ShareTransferDisabled");

    // 申购（铸造）和赎回（销毁）不受影响
    await deposit(vault, bob, USDC(100));
    await unlockLatestBatch(alice);
    await vault.connect(alice).redeem(USDC(1000), alice.address, alice.address);

    // 重开后又能转
    await vault.setShareTransferable(true);
    await vault.connect(bob).transfer(alice.address, USDC(100));
    expect(await vault.balanceOf(alice.address)).to.equal(USDC(100));

    // 只有 admin 能改，且不能设成当前值
    await expect(
      vault.connect(controller).setShareTransferable(false)
    ).to.be.revertedWithCustomError(vault, "AccessControlUnauthorizedAccount");
    await expect(vault.setShareTransferable(true)).to.be.revertedWithCustomError(
      vault,
      "InvalidInput"
    );
  });

  it("需求3：NAV 上报更新 share 定价，并校验连续性", async function () {
    await deposit(vault, alice, USDC(1000));

    const day1 = BigInt(await time.latest());
    const nav1 = (NAV_PRECISION * 101n) / 100n; // +1%
    await vault.connect(reporter).handleOracleReport({
      accountingTimestamp: day1,
      submitTimestamp: day1,
      reportId: 1,
      todayNav: nav1,
      reporter: reporter.address,
    });

    expect(await vault.latestNav()).to.equal(nav1);
    expect(await vault.convertToAssets(USDC(1000))).to.equal(USDC(1010));

    // reportId 必须 +1、会计日必须 +1 天
    await time.increase(ONE_DAY);
    await expect(
      vault.connect(reporter).handleOracleReport({
        accountingTimestamp: day1 + BigInt(ONE_DAY),
        submitTimestamp: day1 + BigInt(ONE_DAY),
        reportId: 3,
        todayNav: nav1,
        reporter: reporter.address,
      })
    ).to.be.revertedWithCustomError(vault, "InvalidReport");

    await expect(
      vault.connect(alice).handleOracleReport({
        accountingTimestamp: day1 + BigInt(ONE_DAY),
        submitTimestamp: day1 + BigInt(ONE_DAY),
        reportId: 2,
        todayNav: nav1,
        reporter: alice.address,
      })
    ).to.be.revertedWithCustomError(vault, "AccessControlUnauthorizedAccount");
  });

  it("需求4：Vault 余额充足时即时兑付，无需 payer", async function () {
    await deposit(vault, alice, USDC(1000));
    await unlockLatestBatch(alice);

    const before = await usdc.balanceOf(alice.address);
    await expect(vault.connect(alice).redeem(USDC(1000), alice.address, alice.address))
      .to.emit(vault, "CustomWithdraw")
      .withArgs(alice.address, alice.address, alice.address, USDC(1000), USDC(1000), 0, 0);

    expect(await usdc.balanceOf(alice.address)).to.equal(before + USDC(1000));
    expect(await vault.vaultBalance()).to.equal(0);
    expect(await vault.lastRequestId()).to.equal(0);
  });

  it("需求4：Vault 余额不足则入队，回款后兑付", async function () {
    await deposit(vault, alice, USDC(1000));
    await unlockLatestBatch(alice);

    // controller 把钱挪走，Vault 没有流动性
    await wdToCustodian(USDC(1000));

    await expect(vault.connect(alice).redeem(USDC(1000), alice.address, alice.address))
      .to.emit(vault, "WithdrawalRequested")
      .withArgs(1, alice.address, alice.address, alice.address, anyValue, USDC(1000));

    // share 已销毁，负债记账
    expect(await vault.balanceOf(alice.address)).to.equal(0);
    expect(await vault.totalPendingWithdrawals()).to.equal(USDC(1000));
    expect(await vault.getWithdrawalRequests(alice.address)).to.deep.equal([1n]);

    // 没钱时兑付是 no-op，不 revert
    await vault.connect(controller).fulfillPendingWithdrawals(USDC(1000));
    expect(await vault.totalPendingWithdrawals()).to.equal(USDC(1000));

    await dpFromCustodian(USDC(1000));

    // budget 不够单笔金额时也是 no-op
    await vault.connect(controller).fulfillPendingWithdrawals(USDC(999));
    expect(await vault.totalPendingWithdrawals()).to.equal(USDC(1000));

    const before = await usdc.balanceOf(alice.address);
    await expect(vault.connect(controller).fulfillPendingWithdrawals(USDC(1000)))
      .to.emit(vault, "WithdrawalFulfilled")
      .withArgs(1, alice.address, alice.address, alice.address, anyValue, USDC(1000));

    expect(await usdc.balanceOf(alice.address)).to.equal(before + USDC(1000));
    expect(await vault.totalPendingWithdrawals()).to.equal(0);
    expect(await vault.getWithdrawalRequests(alice.address)).to.deep.equal([]);
  });

  it("需求4：队列已承诺的资金不会被后来的即时赎回抢走", async function () {
    await deposit(vault, alice, USDC(1000));
    await deposit(vault, bob, USDC(1000));
    await unlockLatestBatch(bob);

    // 留 500，不足以覆盖 alice 的 1000
    await wdToCustodian(USDC(1500));
    await vault.connect(alice).redeem(USDC(1000), alice.address, alice.address);
    expect(await vault.totalPendingWithdrawals()).to.equal(USDC(1000));
    expect(await vault.availableLiquidity()).to.equal(0);

    // bob 只赎 400，Vault 里确实有 500，但都是 alice 的，bob 也得排队
    await vault.connect(bob).redeem(USDC(400), bob.address, bob.address);
    expect(await vault.lastRequestId()).to.equal(2);
    expect(await vault.totalPendingWithdrawals()).to.equal(USDC(1400));
  });

  it("锁定期：未解锁不能赎回；同窗口多笔合并、跨窗口分批次 FIFO", async function () {
    await deposit(vault, alice, USDC(100));
    await deposit(vault, alice, USDC(200));

    // 同一结算窗口 -> 合并成一个批次
    let [times, shares] = await vault.getAllBatches(alice.address);
    expect(times.length).to.equal(1);
    expect(shares[0]).to.equal(USDC(300));

    await expect(
      vault.connect(alice).redeem(USDC(100), alice.address, alice.address)
    ).to.be.revertedWithCustomError(vault, "InsufficientUnlockedShares");

    // 跨到下一个结算窗口再存 -> 新批次
    await time.increaseTo(times[0]);
    await deposit(vault, alice, USDC(50));

    [times, shares] = await vault.getAllBatches(alice.address);
    expect(times.length).to.equal(2);
    expect(shares[0]).to.equal(USDC(300));
    expect(shares[1]).to.equal(USDC(50));
    expect(await vault.getAvailableShares(alice.address, await time.latest())).to.equal(USDC(300));
    expect(await vault.getLockedShares(alice.address, await time.latest())).to.equal(USDC(50));

    // FIFO：赎 120 只扣最早的批次
    await vault.connect(alice).redeem(USDC(120), alice.address, alice.address);
    [times, shares] = await vault.getAllBatches(alice.address);
    expect(shares[0]).to.equal(USDC(180));
    expect(shares[1]).to.equal(USDC(50));
  });

  it("转账：锁定期随 share 转移，接收方不重新起算", async function () {
    await deposit(vault, alice, USDC(300));
    const [times] = await vault.getAllBatches(alice.address);

    await vault.connect(alice).transfer(bob.address, USDC(300));

    const [bobTimes, bobShares] = await vault.getAllBatches(bob.address);
    expect(bobTimes).to.deep.equal([times[0]]);
    expect(bobShares[0]).to.equal(USDC(300));
    expect((await vault.getAllBatches(alice.address))[0].length).to.equal(0);
  });

  it("fulfillPendingWithdrawals 的 budget 限制单批放款额度，超预算 break 保持 FIFO", async function () {
    for (const user of [alice, bob]) {
      await deposit(vault, user, USDC(1000));
    }
    await unlockLatestBatch(bob);
    await wdToCustodian(USDC(2000));

    await vault.connect(alice).redeem(USDC(1000), alice.address, alice.address); // requestId 1
    await vault.connect(bob).redeem(USDC(1000), bob.address, bob.address); // requestId 2
    await dpFromCustodian(USDC(2000));

    // 余额够 2 笔，但 budget 只给 1 笔 -> 第 2 笔留在队列
    await vault.connect(controller).fulfillPendingWithdrawals(USDC(1500));
    expect(await vault.totalPendingWithdrawals()).to.equal(USDC(1000));
    expect(await vault.lastProcessedRequestId()).to.equal(1);
    expect(await vault.getWithdrawalRequests(bob.address)).to.deep.equal([2n]);

    // budget = 0 -> 直接 revert，不表示"不限额"
    await expect(vault.connect(controller).fulfillPendingWithdrawals(0))
      .to.be.revertedWithCustomError(vault, "InvalidInput");
    expect(await vault.totalPendingWithdrawals()).to.equal(USDC(1000));

    await vault.connect(controller).fulfillPendingWithdrawals(USDC(1000));
    expect(await vault.totalPendingWithdrawals()).to.equal(0);
  });

  it("skipWithdrawalRequest 把请求挪到队尾，负债总额不变", async function () {
    await deposit(vault, alice, USDC(1000));
    await unlockLatestBatch(alice);
    await wdToCustodian(USDC(1000));
    await vault.connect(alice).redeem(USDC(1000), alice.address, alice.address);

    await expect(vault.connect(controller).skipWithdrawalRequest(1))
      .to.emit(vault, "RequestIdChanged")
      .withArgs(1, 2);

    expect(await vault.totalPendingWithdrawals()).to.equal(USDC(1000));
    expect(await vault.getWithdrawalRequests(alice.address)).to.deep.equal([2n]);

    await dpFromCustodian(USDC(1000));
    await vault.connect(controller).fulfillPendingWithdrawals(USDC(1000));
    expect(await vault.totalPendingWithdrawals()).to.equal(0);
  });

  it("手续费按 1e6 精度计提", async function () {
    await vault.connect(controller).setDepositFee(10_000); // 1%
    await deposit(vault, alice, USDC(1000));

    expect(await vault.balanceOf(alice.address)).to.equal(USDC(990));
    expect(await vault.totalFeesCollected()).to.equal(USDC(10));
    // 手续费也留在 Vault 里
    expect(await vault.vaultBalance()).to.equal(USDC(1000));

    await expect(
      vault.connect(controller).setDepositFee(10_001)
    ).to.be.revertedWithCustomError(vault, "InvalidInput");
  });

  it("提费：受 withdrawableFees 额度约束，申购+赎回费都能提", async function () {
    await vault.setCustodianWallet(bob.address);
    await vault.connect(controller).setDepositFee(10_000); // 1%
    await vault.connect(controller).setWithdrawFee(10_000); // 1%

    await deposit(vault, alice, USDC(1000)); // 费 10
    await unlockLatestBatch(alice);
    await vault.connect(alice).redeem(USDC(990), alice.address, alice.address); // 费 9.9

    expect(await vault.totalFeesCollected()).to.equal(USDC(19.9));
    expect(await vault.withdrawableFees()).to.equal(USDC(19.9));
    // 手续费确实沉淀在 Vault 余额里
    expect(await vault.vaultBalance()).to.equal(USDC(19.9));

    await expect(
      vault.connect(controller).withdrawFees(USDC(20))
    ).to.be.revertedWithCustomError(vault, "ExceededCollectedFees");

    const before = await usdc.balanceOf(bob.address);
    await expect(vault.connect(controller).withdrawFees(USDC(19.9)))
      .to.emit(vault, "FeesWithdrawn")
      .withArgs(controller.address, bob.address, USDC(19.9), USDC(19.9), 0);

    expect(await usdc.balanceOf(bob.address)).to.equal(before + USDC(19.9));
    expect(await vault.totalFeesWithdrawn()).to.equal(USDC(19.9));
    expect(await vault.withdrawableFees()).to.equal(0);
    // totalFeesCollected 是历史累计，不因提取而回退
    expect(await vault.totalFeesCollected()).to.equal(USDC(19.9));

    // 额度用完，不能再提
    await expect(
      vault.connect(controller).withdrawFees(USDC(1))
    ).to.be.revertedWithCustomError(vault, "ExceededCollectedFees");
  });

  it("提费：只有 controller 能调，且不影响份额与队列负债", async function () {
    await vault.connect(controller).setDepositFee(10_000);
    await deposit(vault, alice, USDC(1000));

    await expect(vault.withdrawFees(USDC(10))).to.be.revertedWithCustomError(
      vault,
      "AccessControlUnauthorizedAccount"
    );
    await expect(
      vault.connect(controller).withdrawFees(0)
    ).to.be.revertedWithCustomError(vault, "InvalidInput");

    const supplyBefore = await vault.totalSupply();
    await vault.connect(controller).withdrawFees(USDC(10));

    expect(await vault.totalSupply()).to.equal(supplyBefore);
    expect(await vault.balanceOf(alice.address)).to.equal(USDC(990));
    expect(await vault.totalPendingWithdrawals()).to.equal(0);
    expect(await vault.vaultBalance()).to.equal(USDC(990));
  });

  it("KYT：申购只收钱不发份额，审核通过才铸造", async function () {
    await expect(vault.connect(alice).deposit(USDC(1000), alice.address))
      .to.emit(vault, "DepositRequested")
      .withArgs(1, alice.address, alice.address, USDC(1000), USDC(1000), 0);

    // 钱进来了，份额还没发
    expect(await vault.vaultBalance()).to.equal(USDC(1000));
    expect(await vault.balanceOf(alice.address)).to.equal(0);
    expect(await vault.totalSupply()).to.equal(0);
    // 待审核的钱不算可用流动性
    expect(await vault.totalPendingDepositAssets()).to.equal(USDC(1000));
    expect(await vault.totalPendingDepositShares()).to.equal(USDC(1000));
    expect(await vault.availableLiquidity()).to.equal(0);

    // KYT 结论还没上报，controller 执行不了
    await expect(
      vault.connect(controller).executeDeposit(1)
    ).to.be.revertedWithCustomError(vault, "KytResultPending");

    await expect(vault.connect(kyt).submitKytResult(1, true))
      .to.emit(vault, "KytResultSubmitted")
      .withArgs(1, true, kyt.address);

    // 只上报不执行，份额仍然没发
    expect(await vault.balanceOf(alice.address)).to.equal(0);
    expect(await vault.totalPendingDepositAssets()).to.equal(USDC(1000));

    await expect(vault.connect(controller).executeDeposit(1))
      .to.emit(vault, "DepositExecuted")
      .withArgs(1, alice.address, true, USDC(1000), USDC(1000), controller.address);

    expect(await vault.balanceOf(alice.address)).to.equal(USDC(1000));
    expect(await vault.totalPendingDepositAssets()).to.equal(0);
    expect(await vault.availableLiquidity()).to.equal(USDC(1000));

    // 执行后是终态：不能重复执行，也不能再改结论
    await expect(
      vault.connect(controller).executeDeposit(1)
    ).to.be.revertedWithCustomError(vault, "DepositAlreadyExecuted");
    await expect(
      vault.connect(kyt).submitKytResult(1, false)
    ).to.be.revertedWithCustomError(vault, "DepositAlreadyExecuted");
  });

  it("KYT：执行前结论可反复改判，执行时按最后一次为准", async function () {
    await vault.connect(alice).deposit(USDC(1000), alice.address);

    await vault.connect(kyt).submitKytResult(1, true);
    await vault.connect(kyt).submitKytResult(1, false);
    await expect(vault.connect(kyt).submitKytResult(1, true))
      .to.emit(vault, "KytResultSubmitted")
      .withArgs(1, true, kyt.address);

    // 最后一次是通过 -> 执行时铸份额
    await vault.connect(controller).executeDeposit(1);
    expect(await vault.balanceOf(alice.address)).to.equal(USDC(1000));
    expect(await vault.depositBlacklist(alice.address)).to.equal(false);
  });

  it("KYT：不通过则退回资产并拉黑，admin 可解封", async function () {
    await vault.connect(controller).setDepositFee(10_000); // 1%
    const before = await usdc.balanceOf(alice.address);
    await vault.connect(alice).deposit(USDC(1000), alice.address);

    await vault.connect(kyt).submitKytResult(1, false);
    await expect(vault.connect(controller).executeDeposit(1))
      .to.emit(vault, "DepositBlacklistUpdated")
      .withArgs(alice.address, true);

    // 钱原路退回，手续费不计提，份额不铸
    expect(await usdc.balanceOf(alice.address)).to.equal(before);
    expect(await vault.vaultBalance()).to.equal(0);
    expect(await vault.totalSupply()).to.equal(0);
    expect(await vault.totalFeesCollected()).to.equal(0);
    expect(await vault.depositBlacklist(alice.address)).to.equal(true);

    await expect(vault.connect(alice).deposit(USDC(1000), alice.address))
      .to.be.revertedWithCustomError(vault, "DepositBlacklisted")
      .withArgs(alice.address);

    await expect(vault.setDepositBlacklisted(alice.address, false))
      .to.emit(vault, "DepositBlacklistUpdated")
      .withArgs(alice.address, false);
    await deposit(vault, alice, USDC(1000));
    expect(await vault.balanceOf(alice.address)).to.equal(USDC(990));
  });

  it("KYT：上报与执行分权，单号必须存在，待审核份额占用 maxSupply", async function () {
    await vault.connect(alice).deposit(USDC(1000), alice.address);

    // controller 不能上报结论，kyt 角色不能执行
    await expect(
      vault.connect(controller).submitKytResult(1, true)
    ).to.be.revertedWithCustomError(vault, "AccessControlUnauthorizedAccount");
    await expect(
      vault.connect(kyt).executeDeposit(1)
    ).to.be.revertedWithCustomError(vault, "AccessControlUnauthorizedAccount");

    await expect(
      vault.connect(kyt).submitKytResult(2, true)
    ).to.be.revertedWithCustomError(vault, "InvalidDepositId");
    await expect(
      vault.connect(controller).executeDeposit(0)
    ).to.be.revertedWithCustomError(vault, "InvalidDepositId");

    await vault.connect(controller).setMaxSupply(USDC(1500));
    // 已有 1000 待审核，剩余额度只有 500
    expect(await vault.maxDeposit(bob.address)).to.equal(USDC(500));
    // 返回 [剩余可认购, 已占用 = 已认购 + 待审核]
    expect(await vault.getSupplyInfo()).to.deep.equal([USDC(500), USDC(1000)]);
    await expect(
      vault.connect(bob).deposit(USDC(1000), bob.address)
    ).to.be.revertedWithCustomError(vault, "ExceededMaxSupply");

    // 上限不能低于已占用份额（已认购 + 待审核），正好等于时剩余为 0
    await expect(
      vault.connect(controller).setMaxSupply(USDC(1000) - 1n)
    ).to.be.revertedWithCustomError(vault, "InvalidInput");
    await vault.connect(controller).setMaxSupply(USDC(1000));
    expect(await vault.getSupplyInfo()).to.deep.equal([0n, USDC(1000)]);
  });

  it("KYT：待审核申购的钱不会被拿去兑付赎回队列", async function () {
    await deposit(vault, alice, USDC(1000));
    await unlockLatestBatch(alice);
    await wdToCustodian(USDC(1000));
    await vault.connect(alice).redeem(USDC(1000), alice.address, alice.address);

    // bob 打进来的是待审核资金，随时可能要退，不能用来兑付 alice
    await vault.connect(bob).deposit(USDC(1000), bob.address);
    await vault.connect(controller).fulfillPendingWithdrawals(USDC(1000));
    expect(await vault.totalPendingWithdrawals()).to.equal(USDC(1000));
    await expect(
      vault.connect(controller).fulfillSpecificRequest(1)
    ).to.be.revertedWithCustomError(vault, "InsufficientLiquidity");
  });

  it("KYT：待审核申购的钱不能提到托管钱包，KYT 拒绝后能原路退款", async function () {
    await vault.connect(controller).setDepositFee(10_000); // 1%，alice 产生 10 的手续费
    await deposit(vault, alice, USDC(1000));
    await wdToCustodian(USDC(1000));

    // Vault 里只剩 bob 的待审核资金，取款和提费都不能动它
    await vault.connect(bob).deposit(USDC(1000), bob.address);
    await expect(wdToCustodian(USDC(1)))
      .to.be.revertedWithCustomError(vault, "InsufficientLiquidity")
      .withArgs(0, USDC(1));
    await expect(vault.connect(controller).withdrawFees(USDC(10)))
      .to.be.revertedWithCustomError(vault, "InsufficientLiquidity")
      .withArgs(0, USDC(10));

    const depositId = await vault.lastDepositId();
    await vault.connect(kyt).submitKytResult(depositId, false);
    const before = await usdc.balanceOf(bob.address);
    await vault.connect(controller).executeDeposit(depositId);
    expect(await usdc.balanceOf(bob.address)).to.equal(before + USDC(1000));
  });
});
