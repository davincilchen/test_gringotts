let env = require('./env');
let MerkleTree = require('./indexMerkleTree/MerkleTree');
let EthUtils = require('ethereumjs-util');
let Web3 = require('web3');
let fs = require('fs');
let db = require('./db');

const privatekey = env.privateKey;
const publickey = '0x' + EthUtils.privateToPublic('0x' + privatekey).toString('hex');
const account = '0x' + EthUtils.pubToAddress(publickey).toString('hex');

let web3 = new Web3(new Web3.providers.HttpProvider(env.web3Url));

const IFCContractAddress = env.IFCContractAddress;
const IFC = JSON.parse(fs.readFileSync('./build/contracts/IFC.json'));

const IFCABI = IFC.abi;
const IFCContractClass = web3.eth.contract(IFCABI);
const IFCContract = IFCContractClass.at(IFCContractAddress);

let makeTree = async function (time, nextStageHeight, txCiphers) {
    let txSize = txCiphers.length;
    let treeHeight = parseInt(Math.log2(txSize)) + 1;
    let tree = new MerkleTree(treeHeight);
    tree.setStageHeight(nextStageHeight);
    tree.setTime(time);
    txCiphers.forEach((tx) => {
        tree.putTransactionInTree(tx);
    });

    return tree;
};

async function buildStage(time, nextStageHeight, txCiphers) {
    try {
        console.log('stage height: ' + nextStageHeight);
        let stageHash = '0x' + EthUtils.sha3(nextStageHeight.toString()).toString('hex');
        console.log('stage hash: ' + stageHash);
        // let prevStageHeight = nextStageHeight - 1;
        // let prevStageHash = EthUtils.sha3(prevStageHeight.toString()).toString('hex');
        const tree = await makeTree(time, nextStageHeight, txCiphers);
        const rootHash = '0x' + tree.getRootHash();
        console.log('time: ' + time);
        console.log('Root Hash: ' + rootHash);
        web3.personal.unlockAccount(env.account, env.password);
        // watch event and clearPendingTransactions
        let event = IFCContract.AddNewStage({fromBlock: 0, toBlock: 'latest'});
        event.watch(async (error, result) => {
            if (error) {
                throw new Error(error.message);
            }
            console.log(result);
            let onChainStageHash = result.args._stageHash;
            if (onChainStageHash.length > 2 && onChainStageHash.substr(0, 2) == '0x') {
                onChainStageHash = onChainStageHash.substr(2);
            }
            // if DB update fail, the node need to check the highest stage in contract
            // and clear relative pending transaction again.
            db.clearPendingTransactions(onChainStageHash);
        });

        let txHash = IFCContract.addNewStage(stageHash, rootHash, {from: account, to:IFCContract.address, gas: 4700000});
        console.log('Add stage tx hash: ' + txHash);
        return tree;
    } catch (e) {
        console.log(e);
    }

    return false;
}

module.exports = buildStage;
