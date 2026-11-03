import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
import "@openzeppelin/hardhat-upgrades";
import "solidity-coverage";

// 编译配置与生产部署完全一致
const config: HardhatUserConfig = {
  solidity: {
    // OpenZeppelin v5.6 的 ERC4626Upgradeable 要求 ^0.8.24（用到 cancun 的 mcopy）
    version: "0.8.28",
    settings: {
      // OZ v5.6 的 Arrays/Memory 用了 mcopy，必须 cancun 及以上
      evmVersion: "cancun",
      // 合约接近 24KB 部署上限，靠 viaIR 压缩字节码（关掉会超限编不过）
      viaIR: true,
      optimizer: {
        enabled: true,
        runs: 200,
      },
    },
  },
};

export default config;
