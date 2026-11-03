const { ethers, upgrades } = require("hardhat");

const ONE_DAY = 24 * 60 * 60;
const USDC = (n) => ethers.parseUnits(String(n), 6);
const NAV_PRECISION = 10n ** 13n;
const FEE_PRECISION = 10n ** 6n;
// initialize 的 maxSupply / maxDepositLimit / minDepositLimit / minRedeemLimit / 申购开关 / 赎回开关，取文档默认值（6 位资产）
const INIT_DEFAULTS = [USDC(10_000_000), USDC(10_000_000), USDC(1), USDC(1), true, true];

// 锁定期链表的写路径在 ShareLockLib 里，MceVault 必须 link 后才能部署
async function deployVault(vaultFactory, initArgs) {
    return upgrades.deployProxy(vaultFactory, initArgs, {
        kind: "uups",
        initializer: "initialize",
        unsafeAllow: ["external-library-linking"],
    });
}

async function vaultFixture() {
    const [admin, controller, reporter, alice, bob, custodian, kyt] = await ethers.getSigners();

    const usdc = await (await ethers.getContractFactory("MockERC20")).deploy("Mock USDC", "USDC", 6);
    const lib = await (await ethers.getContractFactory("ShareLockLib")).deploy();
    const vaultFactory = await ethers.getContractFactory("MceVault", {
        libraries: { ShareLockLib: await lib.getAddress() },
    });
    const vault = await deployVault(vaultFactory, [
        admin.address,
        await usdc.getAddress(),
        custodian.address,
        ONE_DAY,
        true,
        false,
        ...INIT_DEFAULTS,
        "VRPC-Weekly",
        "VRPCW",
    ]);

    await vault.grantRole(await vault.CONTROLLER(), controller.address);
    await vault.grantRole(await vault.ORACLE_REPORTER_ROLE(), reporter.address);
    await vault.grantRole(await vault.KYT_REPORTER_ROLE(), kyt.address);

    for (const u of [alice, bob, admin, controller, custodian]) {
        await usdc.mint(u.address, USDC(1_000_000));
        await usdc.connect(u).approve(await vault.getAddress(), ethers.MaxUint256);
    }

    return {
        admin, controller, reporter, alice, bob, custodian, kyt,
        usdc, vault, vaultFactory,
    };
}

/**
 * 申购现在要过 KYT，一笔完整申购是三步：
 * deposit 收钱 -> kyt 角色上报通过 -> controller 执行才铸份额。
 * 绑定好角色后返回 (vault, user, assets) 形式的快捷函数。
 */
const kytDeposit = (kyt, controller) => async (vault, user, assets) => {
    await vault.connect(user).deposit(assets, user.address);
    const depositId = await vault.lastDepositId();
    await vault.connect(kyt).submitKytResult(depositId, true);
    await vault.connect(controller).executeDeposit(depositId);
};

module.exports = {
    ONE_DAY, USDC, NAV_PRECISION, FEE_PRECISION, INIT_DEFAULTS,
    deployVault, vaultFixture, kytDeposit,
};
