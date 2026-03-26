// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

/// @title MockUSDC
/// @notice Mintable ERC20 token that simulates USDC for local and Sepolia testing.
///         Uses 6 decimals to match real USDC.
///         The owner (deployer) can mint arbitrary amounts for test scenarios.
contract MockUSDC is ERC20, Ownable {
    // Real USDC uses 6 decimals — we mirror this exactly so all math is consistent.
    uint8 private constant DECIMALS = 6;

    constructor(address initialOwner)
        ERC20("Mock USDC", "USDC")
        Ownable(initialOwner)
    {
        // Mint 1 000 000 USDC to the deployer so deploy scripts have tokens immediately.
        _mint(initialOwner, 1_000_000 * 10 ** DECIMALS);
    }

    /// @notice Mint additional tokens. Owner only — used in deploy scripts and tests.
    /// @param to     Recipient address
    /// @param amount Amount in raw units (i.e. 1 USDC = 1e6)
    function mint(address to, uint256 amount) external onlyOwner {
        _mint(to, amount);
    }

    /// @notice Override decimals to return 6, matching real USDC.
    function decimals() public pure override returns (uint8) {
        return DECIMALS;
    }
}
