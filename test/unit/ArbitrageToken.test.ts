import { ethers } from "hardhat";
import { expect } from "chai";
import { ArbitrageToken } from "../../typechain-types";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

describe("ArbitrageToken", () => {
  let token: ArbitrageToken;
  let owner: SignerWithAddress;
  let alice: SignerWithAddress;

  const MAX_SUPPLY = 10_000_000n * 10n ** 18n;

  beforeEach(async () => {
    [owner, alice] = await ethers.getSigners();
    const Factory = await ethers.getContractFactory("ArbitrageToken");
    token = (await Factory.deploy(owner.address)) as unknown as ArbitrageToken;
    await token.waitForDeployment();
  });

  it("has correct name and symbol", async () => {
    expect(await token.name()).to.equal("Crypto Arbitrage Token");
    expect(await token.symbol()).to.equal("CARB");
  });

  it("mints full MAX_SUPPLY to deployer on construction", async () => {
    expect(await token.totalSupply()).to.equal(MAX_SUPPLY);
    expect(await token.balanceOf(owner.address)).to.equal(MAX_SUPPLY);
  });

  it("MAX_SUPPLY constant is 10 million CARB", async () => {
    expect(await token.MAX_SUPPLY()).to.equal(MAX_SUPPLY);
  });

  it("allows owner to burn tokens", async () => {
    const burnAmount = 1_000n * 10n ** 18n;
    await token.connect(owner).burn(burnAmount);
    expect(await token.totalSupply()).to.equal(MAX_SUPPLY - burnAmount);
  });

  it("allows holder to burn their own tokens", async () => {
    const amount = 500n * 10n ** 18n;
    await token.connect(owner).transfer(alice.address, amount);
    await token.connect(alice).burn(amount);
    expect(await token.balanceOf(alice.address)).to.equal(0n);
  });

  it("prevents non-owner from minting", async () => {
    await expect(
      token.connect(alice).mint(alice.address, 1n)
    ).to.be.revertedWithCustomError(token, "OwnableUnauthorizedAccount");
  });

  it("prevents minting beyond MAX_SUPPLY", async () => {
    await expect(
      token.connect(owner).mint(alice.address, 1n)
    ).to.be.revertedWith("ArbitrageToken: exceeds max supply");
  });

  it("can mint up to MAX_SUPPLY after burning", async () => {
    const burnAmount = 100n * 10n ** 18n;
    await token.burn(burnAmount);
    // Should now be able to mint back up to MAX_SUPPLY
    await expect(
      token.mint(owner.address, burnAmount)
    ).to.not.be.reverted;
    expect(await token.totalSupply()).to.equal(MAX_SUPPLY);
  });
});
