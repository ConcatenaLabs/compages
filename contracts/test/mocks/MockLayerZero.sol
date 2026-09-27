// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface ILayerZeroComposer {
    function lzCompose(
        address _from,
        bytes32 _guid,
        bytes calldata _message,
        address _executor,
        bytes calldata _extraData
    ) external payable;
}

interface IUsdtLike {
    function transfer(address to, uint256 amount) external;
}

/// @notice Stand-in for LayerZero's EndpointV2, reduced to its compose queue
///         (MessagingComposer.sol) with the same semantics: an OApp queues a
///         message for a recipient under (guid, index) and only its hash is
///         stored; anyone may deliver it with lzCompose, which checks the
///         hash, marks it received before calling the recipient, and lets a
///         revert from the recipient bubble up, so the message stays queued.
contract MockEndpointV2 {
    bytes32 private constant NO_MESSAGE_HASH = bytes32(0);
    bytes32 private constant RECEIVED_MESSAGE_HASH = bytes32(uint256(1));

    uint32 public immutable eid;
    mapping(address from => mapping(address to => mapping(bytes32 guid => mapping(uint16 index => bytes32)))) public
        composeQueue;

    event ComposeSent(address from, address to, bytes32 guid, uint16 index, bytes message);
    event ComposeDelivered(address from, address to, bytes32 guid, uint16 index);

    error LZ_ComposeExists();
    error LZ_ComposeNotFound(bytes32 expected, bytes32 actual);

    constructor(uint32 eid_) {
        eid = eid_;
    }

    function sendCompose(address _to, bytes32 _guid, uint16 _index, bytes calldata _message) external {
        if (composeQueue[msg.sender][_to][_guid][_index] != NO_MESSAGE_HASH) revert LZ_ComposeExists();
        composeQueue[msg.sender][_to][_guid][_index] = keccak256(_message);
        emit ComposeSent(msg.sender, _to, _guid, _index, _message);
    }

    function lzCompose(
        address _from,
        address _to,
        bytes32 _guid,
        uint16 _index,
        bytes calldata _message,
        bytes calldata _extraData
    ) external payable {
        bytes32 expectedHash = composeQueue[_from][_to][_guid][_index];
        bytes32 actualHash = keccak256(_message);
        if (expectedHash != actualHash) revert LZ_ComposeNotFound(expectedHash, actualHash);
        composeQueue[_from][_to][_guid][_index] = RECEIVED_MESSAGE_HASH;
        ILayerZeroComposer(_to).lzCompose{value: msg.value}(_from, _guid, _message, msg.sender, _extraData);
        emit ComposeDelivered(_from, _to, _guid, _index);
    }
}

/// @notice Stand-in for an OFT v2 adapter such as USDT0's on Ethereum, which
///         locks the underlying token and releases it on arrival. deliver()
///         plays the adapter's _lzReceive: it releases `amountLD` to `to`
///         and, when there is a compose message, queues it with the endpoint
///         in OFTComposeMsgCodec's encoding at index 0, as OFTCore does.
contract MockOftAdapter {
    address public immutable endpoint;
    address public immutable token;

    event OFTReceived(bytes32 indexed guid, uint32 srcEid, address indexed toAddress, uint256 amountReceivedLD);

    constructor(address endpoint_, address token_) {
        endpoint = endpoint_;
        token = token_;
    }

    function deliver(
        uint32 srcEid,
        uint64 nonce,
        bytes32 guid,
        address to,
        uint256 amountLD,
        bytes32 composeFrom,
        bytes calldata composeMsg
    ) external returns (bytes memory message) {
        IUsdtLike(token).transfer(to, amountLD);
        if (composeMsg.length != 0) {
            message = encodeCompose(nonce, srcEid, amountLD, composeFrom, composeMsg);
            MockEndpointV2(endpoint).sendCompose(to, guid, 0, message);
        }
        emit OFTReceived(guid, srcEid, to, amountLD);
    }

    /// @notice Queue a compose message with nothing credited, as a faulty or
    ///         malicious OApp could.
    function composeOnly(address to, bytes32 guid, uint16 index, bytes calldata message) external {
        MockEndpointV2(endpoint).sendCompose(to, guid, index, message);
    }

    /// @notice OFTComposeMsgCodec.encode, with composeFrom prepended to the
    ///         sender's bytes as OFTMsgCodec carries it.
    function encodeCompose(uint64 nonce, uint32 srcEid, uint256 amountLD, bytes32 composeFrom, bytes memory composeMsg)
        public
        pure
        returns (bytes memory)
    {
        return abi.encodePacked(nonce, srcEid, amountLD, abi.encodePacked(composeFrom, composeMsg));
    }
}
