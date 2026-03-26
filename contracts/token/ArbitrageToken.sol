// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

/// @title ArbitrageToken (CARB)
/// @notice ERC20 token deployed as part of the course requirement.
///         Name:   "Crypto Arbitrage Token"
///         Symbol: CARB
///         Supply: hard-capped at 10 000 000 CARB
///
///         Token utility:
///         - Satisfies the course "deploy an ERC20" requirement.
///         - Optional extension: StrategyVault can check CARB holdings to offer
///           a small fee discount (see StrategyVault TODO comment).
///         - Demonstrates a separable, testable contract that can be verified
///           independently on Etherscan.
contract ArbitrageToken is ERC20, ERC20Burnable, Ownable {
    /// @notice Maximum total supply — 10 million CARB (18 decimals).
    uint256 public constant MAX_SUPPLY = 10_000_000 * 1e18;

    event TokensMinted(address indexed to, uint256 amount);

    constructor(address initialOwner)
        ERC20("Crypto Arbitrage Token", "CARB")
        Ownable(initialOwner)
    {
        // Mint the full supply to the deployer.
        // The deployer can distribute or burn as needed.
        _mint(initialOwner, MAX_SUPPLY);
        emit TokensMinted(initialOwner, MAX_SUPPLY);
    }

    /// @notice Mint additional tokens up to MAX_SUPPLY. Owner only.
    /// @dev    In this design the full supply is minted at construction, so
    ///         this function is primarily a safety valve if tokens are burned
    ///         and need to be reissued.
    function mint(address to, uint256 amount) external onlyOwner {
        require(
            totalSupply() + amount <= MAX_SUPPLY,
            "ArbitrageToken: exceeds max supply"
        );
        _mint(to, amount);
        emit TokensMinted(to, amount);
    }
}
