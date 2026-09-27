// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IMintBurn {
    function mint(address to, uint256 amount) external;
    function burn(uint256 amount) external;
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function allowance(address owner, address spender) external view returns (uint256);
}

interface IMessageHandlerV2 {
    function handleReceiveFinalizedMessage(uint32, bytes32, uint32, bytes calldata) external returns (bool);
    function handleReceiveUnfinalizedMessage(uint32, bytes32, uint32, bytes calldata) external returns (bool);
}

/// @notice Stand-in for Circle's MessageTransmitterV2 with the same message
///         layout and checks (destination domain, destination caller,
///         version, single-use nonce), and an attestation that is valid when
///         it equals "valid" instead of a set of signatures.
contract MockMessageTransmitterV2 {
    uint32 public immutable localDomain;
    uint32 public constant version = 1;
    mapping(bytes32 => uint256) public usedNonces;

    event MessageSent(bytes message);
    event MessageReceived(
        address indexed caller,
        uint32 sourceDomain,
        bytes32 indexed nonce,
        bytes32 sender,
        uint32 indexed finalityThresholdExecuted,
        bytes messageBody
    );

    constructor(uint32 domain) {
        localDomain = domain;
        usedNonces[bytes32(0)] = 1; // as in Circle's initializer
    }

    function receiveMessage(bytes calldata message, bytes calldata attestation) external returns (bool) {
        require(keccak256(attestation) == keccak256("valid"), "Invalid attestation");
        require(message.length >= 148, "Invalid message: too short");
        require(uint32(bytes4(message[8:12])) == localDomain, "Invalid destination domain");
        bytes32 caller = bytes32(message[108:140]);
        if (caller != bytes32(0)) {
            require(caller == bytes32(uint256(uint160(msg.sender))), "Invalid caller for message");
        }
        require(uint32(bytes4(message[0:4])) == version, "Invalid message version");
        bytes32 nonce = bytes32(message[12:44]);
        require(usedNonces[nonce] == 0, "Nonce already used");
        usedNonces[nonce] = 1;

        uint32 sourceDomain = uint32(bytes4(message[4:8]));
        bytes32 sender = bytes32(message[44:76]);
        address recipient = address(uint160(uint256(bytes32(message[76:108]))));
        uint32 finality = uint32(bytes4(message[144:148]));
        bytes calldata body = message[148:];
        if (finality < 2000) {
            require(
                IMessageHandlerV2(recipient).handleReceiveUnfinalizedMessage(sourceDomain, sender, finality, body),
                "handleReceiveUnfinalizedMessage() failed"
            );
        } else {
            require(
                IMessageHandlerV2(recipient).handleReceiveFinalizedMessage(sourceDomain, sender, finality, body),
                "handleReceiveFinalizedMessage() failed"
            );
        }
        emit MessageReceived(msg.sender, sourceDomain, nonce, sender, finality, body);
        return true;
    }

    function sendMessage(
        uint32 destinationDomain,
        bytes32 recipient,
        bytes32 destinationCaller,
        uint32 minFinalityThreshold,
        bytes calldata messageBody
    ) external {
        require(destinationDomain != localDomain, "Domain is local domain");
        require(recipient != bytes32(0), "Recipient must be nonzero");
        emit MessageSent(abi.encodePacked(
                version,
                localDomain,
                destinationDomain,
                bytes32(0),
                bytes32(uint256(uint160(msg.sender))),
                recipient,
                destinationCaller,
                minFinalityThreshold,
                uint32(0),
                messageBody
            ));
    }
}

/// @notice Stand-in for Circle's TokenMessengerV2: burns on depositForBurn and
///         formats a V2 burn message; on receipt, validates the burn message
///         the way Circle does and mints (amount - feeExecuted) of the local
///         token mapped to the remote burn token.
contract MockTokenMessengerV2 {
    MockMessageTransmitterV2 public immutable transmitter;
    uint32 public constant messageBodyVersion = 1;
    address public feeRecipient = address(0xFEE);
    mapping(uint32 => bytes32) public remoteTokenMessengers;
    mapping(bytes32 => address) public localTokens; // keccak(domain, remoteToken)

    // What the last depositForBurn saw, for assertions.
    uint256 public lastAllowance;
    uint256 public lastAmount;
    uint32 public lastDestinationDomain;
    bytes32 public lastMintRecipient;
    bytes32 public lastDestinationCaller;
    uint256 public lastMaxFee;
    uint32 public lastMinFinality;

    constructor(MockMessageTransmitterV2 t) {
        transmitter = t;
    }

    function localMessageTransmitter() external view returns (address) {
        return address(transmitter);
    }

    function addRemote(uint32 domain, bytes32 messenger, bytes32 remoteToken, address localToken) external {
        remoteTokenMessengers[domain] = messenger;
        localTokens[keccak256(abi.encodePacked(domain, remoteToken))] = localToken;
    }

    function depositForBurn(
        uint256 amount,
        uint32 destinationDomain,
        bytes32 mintRecipient,
        address burnToken,
        bytes32 destinationCaller,
        uint256 maxFee,
        uint32 minFinalityThreshold
    ) external {
        require(amount > 0, "Amount must be nonzero");
        require(mintRecipient != bytes32(0), "Mint recipient must be nonzero");
        require(maxFee < amount, "Max fee must be less than amount");
        bytes32 remote = remoteTokenMessengers[destinationDomain];
        require(remote != bytes32(0), "No TokenMessenger for domain");

        lastAllowance = IMintBurn(burnToken).allowance(msg.sender, address(this));
        lastAmount = amount;
        lastDestinationDomain = destinationDomain;
        lastMintRecipient = mintRecipient;
        lastDestinationCaller = destinationCaller;
        lastMaxFee = maxFee;
        lastMinFinality = minFinalityThreshold;

        require(IMintBurn(burnToken).transferFrom(msg.sender, address(this), amount), "transferFrom");
        IMintBurn(burnToken).burn(amount);
        bytes memory body = abi.encodePacked(
            messageBodyVersion,
            bytes32(uint256(uint160(burnToken))),
            mintRecipient,
            amount,
            bytes32(uint256(uint160(msg.sender))),
            maxFee,
            uint256(0),
            uint256(0)
        );
        transmitter.sendMessage(destinationDomain, remote, destinationCaller, minFinalityThreshold, body);
    }

    function handleReceiveFinalizedMessage(uint32 remoteDomain, bytes32 sender, uint32, bytes calldata body)
        external
        returns (bool)
    {
        _checkSender(remoteDomain, sender);
        return _handle(remoteDomain, body);
    }

    function handleReceiveUnfinalizedMessage(
        uint32 remoteDomain,
        bytes32 sender,
        uint32 finalityThresholdExecuted,
        bytes calldata body
    ) external returns (bool) {
        _checkSender(remoteDomain, sender);
        require(finalityThresholdExecuted >= 500, "Unsupported finality threshold");
        return _handle(remoteDomain, body);
    }

    function _checkSender(uint32 remoteDomain, bytes32 sender) private view {
        require(msg.sender == address(transmitter), "Invalid message transmitter");
        require(remoteTokenMessengers[remoteDomain] == sender, "Remote TokenMessenger unsupported");
    }

    function _handle(uint32 remoteDomain, bytes calldata body) private returns (bool) {
        require(body.length >= 228, "Invalid burn message: too short");
        require(uint32(bytes4(body[0:4])) == messageBodyVersion, "Invalid message body version");
        uint256 expiration = uint256(bytes32(body[196:228]));
        require(expiration == 0 || expiration > block.number, "Message expired and must be re-signed");
        uint256 amount = uint256(bytes32(body[68:100]));
        uint256 fee = uint256(bytes32(body[164:196]));
        require(fee == 0 || fee < amount, "Fee equals or exceeds amount");
        require(fee <= uint256(bytes32(body[132:164])), "Fee exceeds max fee");
        address mintRecipient = address(uint160(uint256(bytes32(body[36:68]))));
        address token = localTokens[keccak256(abi.encodePacked(remoteDomain, bytes32(body[4:36])))];
        require(token != address(0), "Mint token not supported");
        IMintBurn(token).mint(mintRecipient, amount - fee);
        if (fee > 0) IMintBurn(token).mint(feeRecipient, fee);
        return true;
    }
}
