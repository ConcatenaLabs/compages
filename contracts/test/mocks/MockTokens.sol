// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Plain mintable ERC-20 for tests and the local e2e harness.
contract MockERC20 {
    string public name;
    string public symbol;
    uint8 public decimals;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor(string memory _name, string memory _symbol, uint8 _decimals) {
        name = _name;
        symbol = _symbol;
        decimals = _decimals;
    }

    function mint(address to, uint256 amount) external {
        totalSupply += amount;
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    /// @notice Burn from the caller's own balance: the shape a fiat-backed
    ///         stablecoin exposes to addresses its issuer has authorized.
    function burn(uint256 amount) external {
        require(balanceOf[msg.sender] >= amount, "balance");
        balanceOf[msg.sender] -= amount;
        totalSupply -= amount;
        emit Transfer(msg.sender, address(0), amount);
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) public virtual returns (bool) {
        return _move(msg.sender, to, amount);
    }

    function transferFrom(address from, address to, uint256 amount) public virtual returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        require(allowed >= amount, "allowance");
        if (allowed != type(uint256).max) allowance[from][msg.sender] = allowed - amount;
        return _move(from, to, amount);
    }

    function _move(address from, address to, uint256 amount) internal virtual returns (bool) {
        require(balanceOf[from] >= amount, "balance");
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
        return true;
    }
}

/// @notice Burns 1% of every transfer, to test received-amount accounting.
contract FeeOnTransferERC20 is MockERC20 {
    constructor() MockERC20("Fee Token", "FEE", 18) {}

    function _move(address from, address to, uint256 amount) internal override returns (bool) {
        require(balanceOf[from] >= amount, "balance");
        uint256 fee = amount / 100;
        balanceOf[from] -= amount;
        balanceOf[to] += amount - fee;
        totalSupply -= fee;
        emit Transfer(from, to, amount - fee);
        return true;
    }
}

/// @notice Returns nothing from transfer/transferFrom, like USDT on mainnet.
contract NoReturnERC20 {
    string public name = "No Return Token";
    string public symbol = "NRT";
    uint8 public decimals = 18;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
    }

    function transfer(address to, uint256 amount) external {
        require(balanceOf[msg.sender] >= amount, "balance");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        emit Transfer(msg.sender, to, amount);
    }

    function transferFrom(address from, address to, uint256 amount) external {
        require(allowance[from][msg.sender] >= amount, "allowance");
        require(balanceOf[from] >= amount, "balance");
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
    }
}

/// @notice Returns false from transfer() while `failTransfers` is set, the
///         way some older tokens signal failure instead of reverting.
contract FalseReturnERC20 is MockERC20 {
    bool public failTransfers;

    constructor() MockERC20("False Token", "FALSE", 18) {}

    function setFailTransfers(bool fail) external {
        failTransfers = fail;
    }

    function transfer(address to, uint256 amount) public override returns (bool) {
        if (failTransfers) return false;
        return super.transfer(to, amount);
    }
}

/// @notice USDC-shaped token: a blocklist and a global pause, both of which
///         make transfers revert.
contract BlocklistPausableERC20 is MockERC20 {
    mapping(address => bool) public blocklisted;
    bool public paused;

    constructor() MockERC20("USD Coin", "USDC", 6) {}

    function setBlocklisted(address account, bool blocked) external {
        blocklisted[account] = blocked;
    }

    function setPaused(bool p) external {
        paused = p;
    }

    function _move(address from, address to, uint256 amount) internal override returns (bool) {
        require(!paused, "paused");
        require(!blocklisted[from] && !blocklisted[to], "blocklisted");
        return super._move(from, to, amount);
    }
}

/// @notice Balances are shares scaled by a global index that anyone can
///         change, like a rebasing staking token.
contract RebasingERC20 {
    string public name = "Rebasing Token";
    string public symbol = "REB";
    uint8 public decimals = 18;
    uint256 public index = 1e18;
    mapping(address => uint256) public shares;
    mapping(address => mapping(address => uint256)) public allowance;

    function balanceOf(address account) public view returns (uint256) {
        return shares[account] * index / 1e18;
    }

    function rebase(uint256 newIndex) external {
        index = newIndex;
    }

    function mint(address to, uint256 amount) external {
        shares[to] += amount * 1e18 / index;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _move(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        require(allowance[from][msg.sender] >= amount, "allowance");
        allowance[from][msg.sender] -= amount;
        _move(from, to, amount);
        return true;
    }

    function _move(address from, address to, uint256 amount) private {
        uint256 s = amount * 1e18 / index;
        require(shares[from] >= s, "balance");
        shares[from] -= s;
        shares[to] += s;
    }
}
