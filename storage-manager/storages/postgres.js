let assert = require('assert');
let env = require('../../env');
let Web3 = require('web3');
let Sidechain = require('../../abi/Sidechain.json');
let BigNumber = require('bignumber.js');
let Receipt = require('../../models/receipt');
let ErrorCodes = require('../../errors/codes');
let LightTxTypes = require('../../models/types');
let IndexedMerkleTree = require('../utils/indexed-merkle-tree');
let txDecoder = require('ethereum-tx-decoder');
let abiDecoder = require('abi-decoder');
let Model = require('../postgres/models');
let EthUtils = require('ethereumjs-util');

const Sequelize = Model.Sequelize;
const sequelize = Model.sequelize;

let web3Url = 'http://' + env.web3Host + ':' + env.web3Port;
let web3 = new Web3(new Web3.providers.HttpProvider(web3Url));
let sidechain = web3.eth.contract(Sidechain.abi).at(env.sidechainAddress);
let nextContractStageHeight = parseInt(sidechain.stageHeight()) + 1;
let initBalance = '0000000000000000000000000000000000000000000000000000000000000000';

let ReceiptModel = Model.receipts;
let AssetModel = Model.assets;
let ContractAddressModel = Model.contract_address;
let ExpectedStageHeightModel = Model.expected_stage_height;
let GSNNumberModel = Model.gsn_number;
let ReceiptTreeModel = Model.receipt_trees;
let AccountTreeModel = Model.account_trees;
let TreeModel = Model.trees;

abiDecoder.addABI(Sidechain.abi);

class Postgres {
  async attach (stageHeight, serializedTx) {
    try {
      let decodedTx = txDecoder.decodeTx(serializedTx);
      let functionParams = abiDecoder.decodeMethod(decodedTx.data);

      let receiptRootHash = functionParams.params[1].value[0].slice(2);
      let accountRootHash = functionParams.params[1].value[1].slice(2);
      let trees = await this.getTrees(stageHeight);
      let receiptTree = trees.receiptTree;
      let accountTree = trees.accountTree;

      if ((receiptTree.rootHash === receiptRootHash) &&
        accountTree.rootHash === accountRootHash) {
        let txHash = web3.eth.sendRawTransaction(serializedTx);
        console.log('Committed txHash: ' + txHash);
        return txHash;
      } else {
        throw new Error('Invalid signed root hashes.');
      }
    } catch (e) {
      throw e;
    }
  }

  async commitTrees (stageHeight) {
    let tx;
    try {
      tx = await sequelize.transaction({
        isolationLevel: Sequelize.Transaction.ISOLATION_LEVELS.READ_COMMITTED
      });
      let accountHashes = await this.accountHashes(tx);
      await this.increaseExpectedStageHeight(tx);
      let receiptHashes = await this.pendingReceipts(stageHeight, tx);

      console.log('Building Stage Height: ' + stageHeight);

      let receiptTree = new IndexedMerkleTree(stageHeight, receiptHashes);
      let accountTree = new IndexedMerkleTree(stageHeight, accountHashes);

      await this.setTrees(stageHeight, receiptTree, accountTree, tx);
      // ipfs 
      await tx.commit();
      return {
        receiptRootHash: receiptTree.rootHash,
        accountRootHash: accountTree.rootHash
        // ipfs adress
      };
    } catch (e) {
      console.error(e);
      // rollback all modifications in the leveldb transaction
      await tx.rollback();
      return { ok: false, code: code, message: e.message };
    }
  }

  async increaseExpectedStageHeight (tx = null) {
    let expectedStageHeightModel = await this.expectedStageHeightModel(tx);
    let result = await expectedStageHeightModel.increment("height", {
      transaction: tx
    });
    return result;
  }

  async expectedStageHeightModel (tx = null) {
    // SQL SELECT
    let expectedStageHeight = await ExpectedStageHeightModel.findById(1, {
      transaction: tx
    });

    return expectedStageHeight;
  }

  async gsnNumberModel (tx = null) {
    let gsnNumberModel = await GSNNumberModel.findById(1, {
      transaction: tx
    });

    return gsnNumberModel;
  }

  async setTrees (stageHeight, receiptTree, accountTree, tx = null) {
    if (stageHeight) {
      stageHeight = stageHeight.toString(16).slice(-64).padStart(64, '0');
    }

    let result = await TreeModel.findOne({ where: { stage_height: stageHeight } }, { transaction: tx });
    if (!result) {
      await TreeModel.create({
        stage_height: stageHeight,
        receiptTree: receiptTree,
        accountTree: accountTree
      }, {
          transaction: tx
        });
    } else {
      throw new Error('this stage is already save in DB!');
    }

    // let resultReceipt = await ReceiptTreeModel.findOne({ where: { stage_height: stageHeight } });
    // let resultAccount = await ReceiptTreeModel.findOne({ where: { stage_height: stageHeight } });

    // if (!(resultReceipt || resultAccount)) {

    //   for (let i = 0; i < receiptTree.treeNodes.length; i++) {
    //     let treeNode = receiptTree.treeNodes[i];
    //     await ReceiptTreeModel.create({
    //       stage_height: stageHeight,
    //       node_index: treeNode.treeNodeIndex,
    //       node_hash: treeNode.treeNodeHash,
    //       collisions: { treeNodeElements: treeNode.treeNodeElements || [] }
    //     },
    //       {
    //         transaction: tx
    //       });
    //   }

    //   for (let i = 0; i < accountTree.treeNodes.length; i++) {
    //     let treeNode = accountTree.treeNodes[i];
    //     await AccountTreeModel.create({
    //       stage_height: stageHeight,
    //       node_index: treeNode.treeNodeIndex,
    //       node_hash: treeNode.treeNodeHash,
    //       collisions: { treeNodeElements: treeNode.treeNodeElements || [] }
    //     },
    //       {
    //         transaction: tx
    //       });
    //   }

    // } else {
    //   throw new Error('this stage is already save in DB!');
    // }
  }

  async accountHashes (tx = null) {
    let assets = await AssetModel.findAll({
      "order": [
        ["address", "ASC"],
        ["asset_id", "ASC"]
      ]
    },
      {
        transaction: tx
      }
    );
    let address;
    let data = {};
    let accountDatas = [];
    assets.map((asset) => {
      if (address != asset.address) {
        if (Object.keys(data).length > 1) {
          accountDatas.push(data);
        }
        data = { address: address };
        address = asset.address;
        data[asset.asset_id] = asset.balance;
      } else {
        data[asset.asset_id] = asset.balance;
      }
    });
    if (Object.keys(data).length > 1) {
      accountDatas.push(data);
    }
    let accountHashes = accountDatas.map((accountData) => {
      return this._sha3(Object.values(accountData).reduce((acc, curr) => acc + curr, ''));
    });
    return accountHashes;
  }

  async getTrees (stageHeight, tx = null) {
    if (stageHeight) {
      stageHeight = stageHeight.toString(16).padStart(64, '0').slice(-64);
    }
    let trees = await TreeModel.findOne({ where: { stage_height: stageHeight } }, { transaction: tx });
    return trees;
  }

  async getContractAddress () {
    // SQL SELECT
    try {
      let contractAddress = await chain.get('contract_address');
      return contractAddress;
    } catch (e) {
      if (e.type == 'NotFoundError') {
        await chain.put('contract_address', null);
        return null;
      } else {
        throw e;
      }
    }
  }

  async saveContractAddress (contractAddress) {
    // SQL INSERT
    await chain.put('contract_address', contractAddress);
  }

  addOffchainReceipt (receipt) {
    // SQL INSERT
    let offchainLightTxHash = receipt.lightTxHash;
    this.offchainReceipts[offchainLightTxHash] = receipt;
    this.offchainReceiptHashes.push(offchainLightTxHash);
  }

  async getOffchainReceipts (targetStageHeight) {
    // SQL SELECT
    targetStageHeight = parseInt(targetStageHeight, 16);
    let receipts = [];
    for (let i = 0; i < this.offchainReceiptHashes.length; i++) {
      let lightTxHash = this.offchainReceiptHashes[i];
      let receipt = await chain.get('receipt::' + lightTxHash);
      receipts.push(receipt);
    }

    return receipts.filter((receipt) => {
      let stageHeight = parseInt(receipt.receiptData.stageHeight, 16);
      return stageHeight === targetStageHeight;
    }).map((receipt) => {
      return receipt.lightTxHash;
    });
  }

  removeOffchainReceipt (lightTxHash) {
    // SQL DELETE
    this.offchainReceiptHashes.splice(this.offchainReceiptHashes.indexOf(lightTxHash), 1);
  }

  async removeOffchainReceipts (stageHeight) {
    // SQL DELETE
    if (stageHeight) {
      stageHeight = stageHeight.toString(16).slice(-64).padStart(64, '0');
    }
    let result = ReceiptModel.update({ onchain: true }, { where: { stage_height: stageHeight } });
    return result;
    // let targetLightTxHashes = await this.getOffchainReceipts(stageHeight);
    // for (let i = 0; i < targetLightTxHashes.length; i++) {
    //   let targetLightTxHash = targetLightTxHashes[i];
    //   delete this.offchainReceipts[targetLightTxHash];
    //   this.offchainReceiptHashes.splice(this.offchainReceiptHashes.indexOf(targetLightTxHash), 1);
    // }
  }

  async init () {
    assert(env.sidechainAddress, 'Sidechain address is empty.');
    // SQL INSERT, init expected stage height, contract address
    let contractAddress = await ContractAddressModel.findById(1);
    if (!contractAddress && env.sidechainAddress) {
      let contractAddress = ContractAddressModel.build({
        address: env.sidechainAddress
      });
      await contractAddress.save();
    } else if (contractAddress && (contractAddress.address != env.sidechainAddress)) {
      throw new Error('Sidechain address is not consistent.');
    }

    let expectedStageHeightModel = await ExpectedStageHeightModel.findById(1);
    let expectedStageHeight;
    if (!expectedStageHeightModel) {
      expectedStageHeight = nextContractStageHeight;
      await ExpectedStageHeightModel.create({
        height: expectedStageHeight
      });
    } else {
      expectedStageHeight = parseInt(expectedStageHeightModel.height, 16);
    }

    console.log('expectedStageHeight: ' + expectedStageHeight);

    let gsnNumberModel = await GSNNumberModel.findById(1);
    let gsn;
    if (!gsnNumberModel) {
      gsn = 0;
      await GSNNumberModel.create({
        gsn: gsn
      });
    } else {
      gsn = parseInt(gsnNumberModel.gsn, 10);
    }

    console.log('gsn: ' + gsn);
  }

  async pendingLightTxHashesOfReceipts () {
    // SQL SELECT receipts
    let receipts = await ReceiptModel.findAll({ attributes: ["receipt_hash"], where: { onchain: false } }).map((e) => {
      return e.receipt_hash;
    });
    return receipts;
  }

  async hasPendingReceipts (stageHeight) {
    // SQL SELECT
    if (stageHeight) {
      stageHeight = stageHeight.toString(16).padStart(64, '0').slice(-64);
    }
    let receipts = await ReceiptModel.findOne({
      where: {
        stage_height: stageHeight,
        onchain: false
      }
    });
    return !!(receipts);
  }

  async pendingReceipts (stageHeight, tx = null) {
    // SQL SELECT
    if (stageHeight) {
      stageHeight = stageHeight.toString(16).padStart(64, '0').slice(-64);
    }
    let receipts = await ReceiptModel.findAll({ attributes: ["receipt_hash"], where: { stage_height: stageHeight } }, {
      transaction: tx
    }).map((e) => {
      return e.receipt_hash;
    });
    return receipts;
  }

  async getReceiptByLightTxHash (lightTxHash, tx = null) {
    // SQL SELECT
    let receipt = await ReceiptModel.findOne({ where: { light_tx_hash: lightTxHash } }, {
      transaction: tx
    });
    return receipt;
  }

  async getBalance (address, assetID, tx = null) {
    let asset = await this.getAsset(address, assetID, tx);

    if (asset) {
      return asset.balance;
    } else {
      return initBalance.toString(16).padStart(64, '0');
    }
  }

  async getAsset (address, assetID, tx = null) {
    let asset = await AssetModel.findOne({
      where:
        {
          address: address,
          asset_id: assetID
        }
    }, {
        transaction: tx
      });

    return asset;
  }

  async setBalance (address, assetID, balance, tx = null) {
    let asset = await this.getAsset(address, assetID, tx);

    if (asset) {
      await asset.update({
        address: address,
        asset_id: assetID,
        balance: balance
      });
    } else {
      asset = AssetModel.build({
        address: address,
        asset_id: assetID,
        balance: balance
      });
      await asset.save();
    }
  }

  async applyLightTx (lightTx) {
    // SQL transaction begin, commit, rollback
    let code = ErrorCodes.SOMETHING_WENT_WRONG;
    let type = lightTx.type();
    let fromAddress = lightTx.lightTxData.from;
    let toAddress = lightTx.lightTxData.to;
    let assetID = lightTx.lightTxData.assetID;

    let fromBalance = initBalance;
    let toBalance = initBalance;
    let tx;
    try {
      tx = await sequelize.transaction({
        isolationLevel: Sequelize.Transaction.ISOLATION_LEVELS.READ_COMMITTED
      });
      if (type === LightTxTypes.deposit) {
        let value = new BigNumber('0x' + lightTx.lightTxData.value);
        toBalance = await this.getBalance(toAddress, assetID, tx);

        toBalance = new BigNumber('0x' + toBalance);
        toBalance = toBalance.plus(value);
        toBalance = toBalance.toString(16).padStart(64, '0');

        await this.setBalance(toAddress, assetID, toBalance, tx);
      } else if ((type === LightTxTypes.withdrawal) ||
        (type === LightTxTypes.instantWithdrawal)) {
        let value = new BigNumber('0x' + lightTx.lightTxData.value);
        fromBalance = await this.getBalance(fromAddress, assetID, tx);

        fromBalance = new BigNumber('0x' + fromBalance);
        if (fromBalance.isGreaterThanOrEqualTo(value)) {
          fromBalance = fromBalance.minus(value);
          fromBalance = fromBalance.toString(16).padStart(64, '0');

          await this.setBalance(fromAddress, assetID, fromBalance, tx);
        } else {
          code = ErrorCodes.INSUFFICIENT_BALANCE;
          throw new Error('Insufficient balance.');
        }
      } else if (type === LightTxTypes.remittance) {
        let value = new BigNumber('0x' + lightTx.lightTxData.value);

        fromBalance = await this.getBalance(fromAddress, assetID, tx);
        toBalance = await this.getBalance(toAddress, assetID, tx);

        fromBalance = new BigNumber('0x' + fromBalance);
        toBalance = new BigNumber('0x' + toBalance);
        if (fromBalance.isGreaterThanOrEqualTo(value)) {
          fromBalance = fromBalance.minus(value);
          toBalance = toBalance.plus(value);

          fromBalance = fromBalance.toString(16).padStart(64, '0');
          toBalance = toBalance.toString(16).padStart(64, '0');

          await this.setBalance(toAddress, assetID, toBalance, tx);
          await this.setBalance(fromAddress, assetID, fromBalance, tx);
        } else {
          code = ErrorCodes.INSUFFICIENT_BALANCE;
          throw new Error('Insufficient balance.');
        }
      } else {
        code = ErrorCodes.INVALID_LIGHT_TX_TYPE;
        throw new Error('Invalid light transaction type.');
      }

      let expectedStageHeightModel = await this.expectedStageHeightModel(tx);
      let expectedStageHeight = expectedStageHeightModel.height;

      let gsnNumberModel = await this.gsnNumberModel(tx);
      await gsnNumberModel.increment('gsn', {
        transaction: tx
      });

      let gsn = gsnNumberModel.gsn;

      let receiptJson = lightTx.toJson();
      receiptJson.receiptData = {
        stageHeight: parseInt(expectedStageHeight, 10),
        GSN: parseInt(gsn, 10),
        lightTxHash: lightTx.lightTxHash,
        fromBalance: fromBalance,
        toBalance: toBalance,
      };

      let receipt = new Receipt(receiptJson);

      await ReceiptModel.create({
        gsn: receipt.receiptData.GSN,
        stage_height: receipt.receiptData.stageHeight,
        light_tx_hash: receipt.lightTxHash,
        receipt_hash: receipt.receiptHash,
        from: receipt.from,
        to: receipt.to,
        value: receipt.value,
        data: receipt.toJson()
      }, {
          transaction: tx
        });

      await tx.commit();

      return { ok: true, receipt: receipt };
    } catch (e) {
      console.error(e);
      // rollback all modifications in the leveldb transaction
      await tx.rollback();
      return { ok: false, code: code, message: e.message };
    }
  }

  _sha3 (content) {
    return EthUtils.sha3(content).toString('hex');
  }
}

module.exports = Postgres;
