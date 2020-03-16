import BitcoinHelpers from "./BitcoinHelpers.js"
/** @typedef { import("./BitcoinHelpers.js").FoundTransaction } BitcoinTransaction */

import EthereumHelpers from "./EthereumHelpers.js"

import TruffleContract from "@truffle/contract"
/** @typedef { import("@truffle/contract").default.Contract } TruffleContract */

/** @typedef { import("web3").default.Web3.eth.Contract } Contract */

import Redemption from "./Redemption.js"

import TBTCConstantsJSON from "@keep-network/tbtc/artifacts/TBTCConstants.json"
import TBTCSystemJSON from "@keep-network/tbtc/artifacts/TBTCSystem.json"
import TBTCDepositTokenJSON from "@keep-network/tbtc/artifacts/TBTCDepositToken.json"
import DepositJSON from "@keep-network/tbtc/artifacts/Deposit.json"
import DepositFactoryJSON from "@keep-network/tbtc/artifacts/DepositFactory.json"
import TBTCTokenJSON from "@keep-network/tbtc/artifacts/TBTCToken.json"
import FeeRebateTokenJSON from "@keep-network/tbtc/artifacts/FeeRebateToken.json"
import VendingMachineJSON from "@keep-network/tbtc/artifacts/VendingMachine.json"
// import BondedECDSAKeepJSON from "@keep-network/tbtc/artifacts/BondedECDSAKeep.json"


/** @typedef { import("bn.js") } BN */
/** @typedef { import("./TBTC").TBTCConfig } TBTCConfig */

/** @enum {number} */
const DepositStates = {
  // Not initialized.
  START: 0,

  // Funding flow.
  AWAITING_SIGNER_SETUP: 1,
  AWAITING_BTC_FUNDING_PROOF: 2,

  // Failed setup.
  FRAUD_AWAITING_BTC_FUNDING_PROOF: 3,
  FAILED_SETUP: 4,

  // Active/qualified, pre- or at-term.
  ACTIVE: 5,

  // Redemption flow.
  AWAITING_WITHDRAWAL_SIGNATURE: 6,
  AWAITING_WITHDRAWAL_PROOF: 7,
  REDEEMED: 8,

  // Signer liquidation flow.
  COURTESY_CALL: 9,
  FRAUD_LIQUIDATION_IN_PROGRESS: 10,
  LIQUIDATION_IN_PROGRESS: 11,
  LIQUIDATED: 12
}

export class DepositFactory {
    /**
     * Returns a fully-initialized DepositFactory for the given config.
     *
     * @param {TBTCConfig} config The config to use for this factory.
     */
    static async withConfig(config) {
        const statics = new DepositFactory(config)
        await statics.resolveContracts()

        BitcoinHelpers.setElectrumConfig(config.electrum)

        return statics
    }

    /**
     * @param {TBTCConfig} config The config to use for this factory.
     */
    constructor(config) {
        /** @package */
        this.config = config

        this.State = DepositStates
    }

    /**
     * @return {Promise<BN[]>} A list of the available lot sizes, in satoshis,
     *         as BN instances.
     */
    async availableSatoshiLotSizes() {
        return await this.systemContract.methods.getAllowedLotSizes().call()
    }

    /**
     * Opens a new deposit with the given lot size in satoshis and returns a
     * Deposit handle to it. If the lot size is not currently permitted by the
     * tBTC system, throws an error. If a contract issue occurs during the
     * opening of the deposit, throws an issue.
     *
     * To follow along once the deposit is initialized, see the `Deposit` API.
     *
     * @param {BN} satoshiLotSize The lot size, in satoshis, of the deposit.
     *        Must be in the list of allowed lot sizes from `availableLotSizes`.
     *
     * @return {Promise<Deposit>} The new deposit with the given lot size.
     */
    async withSatoshiLotSize(satoshiLotSize) {
        if (! await this.systemContract.methods.isAllowedLotSize(satoshiLotSize).call()) {
            throw new Error(
                `Lot size ${satoshiLotSize} is not permitted; only ` +
                `one of ${(await this.availableSatoshiLotSizes()).join(',')} ` +
                `can be used.`
            )
        }

        const deposit = Deposit.forLotSize(this, satoshiLotSize)
        return deposit
    }

    /**
     * Looks up an existing deposit at the specified address, and returns a
     * tbtc.js Deposit wrapper for it.
     *
     * @param {string} depositAddress The address of the deposit to resolve.
     *
     * @return {Promise<Deposit>} The deposit at the given address.
     */
    async withAddress(depositAddress) {
        return await Deposit.forAddress(this, depositAddress)
    }

    // Await the deployed() functions of all contract dependencies.
    /** @private */
    async resolveContracts() {
        const web3 = this.config.web3

        // Get the net_version
        const networkId = await this.config.web3.eth.net.getId()

        function lookupAddress(artifact) {
            let deploymentInfo = artifact.networks[networkId]
            if(!deploymentInfo) 
                throw new Error(`No deployment info found for contract ${artifact.contractName}, network ID ${networkId}`)
            return deploymentInfo.address
        }

        const contracts = [
            [TBTCConstantsJSON, 'constantsContract'],
            [TBTCSystemJSON, 'systemContract'],
            [TBTCTokenJSON, 'tokenContract'],
            [TBTCDepositTokenJSON, 'depositTokenContract'],
            [FeeRebateTokenJSON, 'feeRebateTokenContract'],
            [DepositFactoryJSON, 'depositFactoryContract'],
            [VendingMachineJSON, 'vendingMachineContract']
        ]

        contracts.map(([ artifact, propertyName, deployed ]) => {
            const contract = new web3.eth.Contract(artifact.abi)
            contract.options.address = lookupAddress(artifact)
            contract.options.from = web3.eth.defaultAccount
            this[propertyName] = contract
        })

        /**
         * @package
         * @type Contract
         */
        this.constantsContract;
        /**
         * @package
         * @type Contract
         */
        this.systemContract;
        /**
         * @package
         * @type Contract
         */
        this.tokenContract;
        /**
         * @package
         * @type Contract
         */
        this.depositTokenContract;
        /**
         * @package
         * @type Contract
         */
        this.feeRebateTokenContract;
        /**
         * @package
         * @type Contract
         */
        this.depositContract;
        /**
         * @package
         * @type Contract
         */
        this.depositLogContract;
        /**
         * @package
         * @type Contract
         */
        this.depositFactoryContract;
        /**
         * @package
         * @type Contract
         */
        this.vendingMachineContract;
    }

    /**
     * @private
     *
     * INTERNAL USE ONLY
     *
     * Initializes a new deposit and returns a tuple of the deposit contract
     * address and the associated keep address.
     *
     * @param {BN} lotSize The lot size to use, in satoshis.
     */
    async createNewDepositContract(lotSize) {
        const creationCost = this.config.web3.utils.toBN(
          await this.systemContract.methods.createNewDepositFeeEstimate().call()
        )
        
        const accountBalance = await this.config.web3.eth.getBalance(this.config.web3.eth.defaultAccount)

        if (creationCost.lt(accountBalance)) {
            throw `Insufficient balance ${accountBalance.toString()} to open ` +
                `deposit (required: ${creationCost.toString()}).`
        }
        
        // const result = await this.depositFactoryContract.methods.createDeposit(
        //     lotSize
        // ).send({
        //     value: creationCost,
        // })

        
        const createDeposit_call = await this.depositFactoryContract.methods.createDeposit(
            lotSize
        )

        const createDeposit_gasEstimate = await createDeposit_call.estimateGas()
        
        await createDeposit_call.send({
            value: creationCost,
            gas: createDeposit_gasEstimate
        })

        const createdEvent = EthereumHelpers.readEventFromTransaction(
            this.config.web3,
            result,
            this.systemContract,
            'Created',
        )
        if (! createdEvent) {
            throw new Error(
                `Transaction failed to include keep creation event. ` +
                `Transaction was: ${JSON.stringify(result)}.`
            )
        }

        return {
            depositAddress: createdEvent._depositContractAddress,
            keepAddress: createdEvent._keepAddress,
        }
    }
}

// Bitcoin address handlers are given the deposit's Bitcoin address.
/** @typedef {(address: string)=>void} BitcoinAddressHandler */
// Active handlers are given the deposit that just entered the ACTIVE state.
/** @typedef {(deposit: Deposit)=>void} ActiveHandler */

export default class Deposit {
    // factory/*: DepositFactory*/;
    // address/*: string*/;
    // keepContract/*: string*/;
    // contract/*: any*/;

    // bitcoinAddress/*: Promise<string>*/;
    // activeStatePromise/*: Promise<[]>*/; // fulfilled when deposit goes active

    /**
     * @package
     * @type TruffleContract
     */
    static async forLotSize(factory, satoshiLotSize) {
        console.debug(
            'Creating new deposit contract with lot size',
            satoshiLotSize,
            'satoshis...',
        )
        const { depositAddress, keepAddress } = await factory.createNewDepositContract(satoshiLotSize)
        console.debug(
            `Looking up new deposit with address ${depositAddress} backed by ` +
            `keep at address ${keepAddress}...`
        )
        const web3 = factory.config.web3
        const contract = new web3.eth.Contract(DepositJSON.abi, depositAddress)
        const keepContract = new web3.eth.Contract(BondedECDSAKeepJSON, keepAddress)

        return new Deposit(factory, contract, keepContract)
    }

    /**
     * @package
     * @type TruffleContract
     */
    static async forAddress(factory, address) {
        console.debug(`Looking up Deposit contract at address ${address}...`)
        const web3 = factory.config.web3
        const contract = new web3.eth.Contract(DepositJSON.abi, address)

        console.debug(`Looking up Created event for deposit ${address}...`)
        const createdEvent = await EthereumHelpers.getExistingEvent(
            factory.systemContract,
            'Created',
            { _depositContractAddress: address },
        )
        if (! createdEvent) {
            throw new Error(
                `Could not find creation event for deposit at address ${address}.`
            )
        }

        console.debug(`Found keep address ${createdEvent.args._keepAddress}.`)
        const keepContract = new web3.eth.Contract(BondedECDSAKeepJSON, keepAddress)

        return new Deposit(factory, contract, keepContract)
    }

    /**
     * @package
     * @type TruffleContract
     */
    this.tokenContract
    /**
     * @package
     * @type TruffleContract
     */
    constructor(factory, depositContract, keepContract) {
        if (! keepContract) {
            throw "Keep contract required for Deposit instantiation."
        }

        this.factory = factory
        /** @type {string} */
        this.address = depositContract.options.address
        this.keepContract = keepContract
        this.contract = depositContract

        // Set up state transition promises.
        this.activeStatePromise = this.waitForActiveState()

        this.publicKeyPoint = this.findOrWaitForPublicKeyPoint()
        this.bitcoinAddress = this.publicKeyPoint.then(this.publicKeyPointToBitcoinAddress.bind(this))
    }

    ///------------------------------- Accessors -------------------------------

    /**
     * @package
     * @type TruffleContract
     */
    async getSatoshiLotSize() {
        return await this.contract.methods.lotSizeSatoshis.call()
    }

    /**
     * @package
     * @type TruffleContract
     */
    this.depositContract
    /**
     * @package
     * @type TruffleContract
     */
    async getCurrentState() {
        return (await this.contract.methods.getCurrentState().call())
    }

    async getTDT()/*: Promise<TBTCDepositToken>*/ {
        return {}
    }

    async getFRT()/*: Promise<FeeRebateToken | null>*/ {
        return {}
    }

    async getOwner()/*: Promise<string>*/ /* ETH address */ {
        return await this.factory.depositTokenContract.methods.ownerOf(this.address).call()
    }

    async inVendingMachine()/*: Promise<boolean>*/ {
        return (await this.getOwner()) == this.factory.vendingMachineContract.methods.options.address
    }

    ///---------------------------- Event Handlers -----------------------------

    /**
     * @package
     * @type TruffleContract
     */
    this.depositFactoryContract
    /**
     * @package
     * @type TruffleContract
     */
    this.vendingMachineContract

    await Promise.all(contracts.map(init))
  }

  /**
   * @private
   *
   * INTERNAL USE ONLY
   *
   * Initializes a new deposit and returns a tuple of the deposit contract
   * address and the associated keep address.
   *
   * @param {BN} lotSize The lot size to use, in satoshis.
   */
  async createNewDepositContract(lotSize) {
    const creationCost = await this.systemContract.createNewDepositFeeEstimate()
    const accountBalance = await this.config.web3.eth.getBalance(
      this.config.web3.eth.defaultAccount
    )
    if (creationCost.lt(accountBalance)) {
      throw new Error(
        `Insufficient balance ${accountBalance.toString()} to open ` +
          `deposit (required: ${creationCost.toString()}).`
      )
    }

    const result = await this.depositFactoryContract.createDeposit(lotSize, {
      from: this.config.web3.eth.defaultAccount,
      value: creationCost
    })

    const createdEvent = EthereumHelpers.readEventFromTransaction(
      this.config.web3,
      result,
      this.systemContract,
      "Created"
    )
    if (!createdEvent) {
      throw new Error(
        `Transaction failed to include keep creation event. ` +
          `Transaction was: ${JSON.stringify(result)}.`
      )
    }

    return {
      depositAddress: createdEvent._depositContractAddress,
      keepAddress: createdEvent._keepAddress
    }
  }
}

    /**
     * Mints TBTC from this deposit by giving ownership of it to the tBTC
     * Vending Machine contract in exchange for TBTC. Requires that the deposit
     * already be qualified, i.e. in the ACTIVE state.
     *
     * @return {Promise<BN>} A promise to the amount of TBTC that was minted to
     *         the deposit owner.
     */
    async mintTBTC() {
        if (! await this.contract.methods.inActive().call()) {
            throw new Error(
                "Can't mint TBTC with a deposit that isn't in ACTIVE state."
            )
        }

        console.debug(
            `Approving transfer of deposit ${this.address} TDT to Vending Machine...`
        )
        await this.factory.methods.depositTokenContract.approve(
            this.factory.vendingMachineContract.options.address,
            this.address,
        ).send()

        console.debug(
          `Waiting for ${requiredConfirmations} confirmations for ` +
            `Bitcoin transaction ${transaction.transactionID}...`
        )
        const transaction = await this.factory.methods.vendingMachineContract.tdtToTbtc(
            this.address
        ).send()

        // return TBTC minted amount
        const transferEvent = EthereumHelpers.readEventFromTransaction(
            this.factory.config.web3,
            transaction,
            this.factory.tokenContract,
            'Transfer',
        ) // TODO

        console.debug(`Found Transfer event for`, transferEvent.value, `TBTC.`)
        return transferEvent.value
    }

    /**
     * Finds a funding transaction to this deposit's funding address with the
     * appropriate number of confirmations, then calls the tBTC Vending
     * Machine's shortcut function to simultaneously qualify the deposit and
     * mint TBTC off of it, transferring ownership of the deposit to the
     * Vending Machine.
     *
     * @return {Promise<BN>} A promise to the amount of TBTC that was minted to
     *         the deposit owner.
     *
     * @throws When there is no existing Bitcoin funding transaction with the
     *         appropriate number of confirmations, or if there is an issue
     *         in the Vending Machine's qualification + minting process.
     */
    async qualifyAndMintTBTC() {
        const address = await this.bitcoinAddress
        const expectedValue = (await this.getSatoshiLotSize())
        const tx = await BitcoinHelpers.Transaction.find(address, expectedValue)
        if (! tx) {
            throw new Error(
                `Funding transaction not found for deposit ${this.address}.`
            )
        }

        const requiredConfirmations = (await this.factory.constantsContract.methods.getTxProofDifficultyFactor().call())
        const confirmations =
            await BitcoinHelpers.Transaction.checkForConfirmations(
                tx,
                requiredConfirmations,
            )
        if (! confirmations) {
            throw new Error(
                `Funding transaction did not have sufficient confirmations; ` +
                `expected ${requiredConfirmations}.`
            )
        }

    state.proofTransaction = state.fundingConfirmations.then(
      async ({ transaction, requiredConfirmations }) => {
        console.debug(
          `Submitting funding proof to deposit ${this.address} for ` +
            `Bitcoin transaction ${transaction.transactionID}...`
        )
        await this.factory.depositTokenContract.methods.approve(
            this.factory.vendingMachineContract.options.address,
            this.address
        ).send()

        console.debug(
            `Qualifying and minting off of deposit ${this.address} for ` +
            `Bitcoin transaction ${tx.transactionID}...`,
            tx,
            confirmations,
        )
        const proofArgs = await this.constructFundingProof(tx, requiredConfirmations)
        proofArgs.unshift(this.address)
        const transaction = await this.factory.vendingMachineContract.methods.unqualifiedDepositToTbtc(
            ...proofArgs
        ).send()

        // return TBTC minted amount
        const transferEvent = EthereumHelpers.readEventFromTransaction(
            this.factory.config.web3,
            transaction,
            this.factory.tokenContract,
            'Transfer',
        )

        return transferEvent.value.div(this.factory.config.web3.utils.toBN(10).pow(18))
    }

    /**
     * Returns the cost, in TBTC, to redeem this deposit. If the deposit is in
     * the tBTC Vending Machine, includes the cost of retrieving it from the
     * Vending Machine.
     *
     * @return {Promise<BN>} A promise to the amount of TBTC needed to redeem
     *         this deposit.
     */
    async getRedemptionCost() {
        if (await this.inVendingMachine()) {
            const ownerRedemptionRequirement =
                await this.contract.methods.getOwnerRedemptionTbtcRequirement(
                    this.factory.config.web3.eth.defaultAccount
                ).call()
            const lotSize = await this.getSatoshiLotSize()

            const toBN = this.factory.config.web3.utils.toBN
            return lotSize.mul(toBN(10).pow(toBN(10))).add(
                ownerRedemptionRequirement
            )
        } else {
            return await this.contract.methods.getRedemptionTbtcRequirement(
                this.factory.config.web3.eth.defaultAccount
            ).call()
        }
    }

    /**
     * Checks to see if this deposit is already in the redemption process and,
     * if it is, returns the details of that redemption. Returns null if there
     * is no current redemption.
     */
    async getCurrentRedemption() {
        const details = await this.getLatestRedemptionDetails()

        if (details) {
            return new Redemption(this, details)
        } else {
            return null
        }
    }

    /**
     *
     * @param {string} redeemerAddress The Bitcoin address where the redeemer
     *        would like to receive the BTC UTXO the deposit holds, less Bitcoin
     *        transaction fees.
     * @return {Promise<Redemption>} Returns a promise to a Redemption object,
     *         which will be fulfilled once the redemption process is in
     *         progress. Note that the promise can fail in several ways,
     *         including connectivity, a deposit ineligible for redemption, a
     *         deposit that is not owned by the requesting party, an invalid
     *         redeemer address, and a redemption request from a party that has
     *         insufficient TBTC to redeem.
     */
    async requestRedemption(redeemerAddress) {
        const inVendingMachine = await this.inVendingMachine()
        const thisAccount = this.factory.config.web3.eth.defaultAccount
        const owner = await this.getOwner()
        const belongsToThisAccount = owner == thisAccount

        if (! inVendingMachine && ! belongsToThisAccount) {
            throw new Error(
                `Redemption is currently only supported for deposits owned by ` +
                `this account (${thisAccount}) or the tBTC Vending Machine ` +
                `(${this.factory.vendingMachineContract.options.address}). This ` +
                `deposit is owned by ${owner}.`
            )
        }

        const rawOutputScript = BitcoinHelpers.Address.toRawScript(redeemerAddress)
        const redeemerOutputScript = '0x' + Buffer.concat([Buffer.from([rawOutputScript.length]), rawOutputScript]).toString('hex')
        if (redeemerOutputScript === null) {
            throw new Error(`${redeemerAddress} is not a valid Bitcoin address.`)
        }

        const redemptionCost = await this.getRedemptionCost()
        const availableBalance = await this.factory.tokenContract.methods.balanceOf(thisAccount).call()
        if (redemptionCost.gt(availableBalance)) {
            throw new Error(
                `Account ${thisAccount} does not have the required balance of ` +
                `${redemptionCost.toString()} to redeem; it only has ` +
                `${availableBalance.toString()} available.`
            )
        }

        const toBN = this.factory.config.web3.utils.toBN
        console.debug(
            `Looking up UTXO size and transaction fee for redemption transaction...`,
        )
        const transactionFee = await BitcoinHelpers.Transaction.estimateFee(
            this.factory.constantsContract,
        )
        const utxoSize = await this.contract.methods.utxoSize().call()
        const outputValue = toBN(utxoSize).sub(toBN(transactionFee))
        const outputValueBytes = outputValue.toArrayLike(Buffer, 'le', 8)

        let transaction
        if (inVendingMachine) {
            console.debug(
                `Approving transfer of ${redemptionCost} to the vending machine....`,
            )
            await this.factory.tokenContract.approve(
                this.factory.vendingMachineContract.options.address,
                redemptionCost
            ).send()

            console.debug(
                `Initiating redemption of deposit ${this.address} from ` +
                `vending machine...`,
            )
            transaction = await this.factory.vendingMachineContract.methods.tbtcToBtc(
                this.address,
                outputValueBytes,
                redeemerOutputScript,
                thisAccount,
            ).send()
        } else {
            console.debug(
                `Approving transfer of ${redemptionCost} to the deposit...`,
            )
            this.factory.tokenContract.methods.approve(
                this.address,
                redemptionCost
            ).send()

            console.debug(`Initiating redemption from deposit ${this.address}...`)
            transaction = await this.contract.methods.requestRedemption(
                outputValueBytes,
                redeemerOutputScript,
            ).send()
        }


        const redemptionRequest = EthereumHelpers.readEventFromTransaction(
            this.factory.config.web3,
            transaction,
            this.factory.systemContract,
            'RedemptionRequested',
        )
        const redemptionDetails = this.redemptionDetailsFromEvent(redemptionRequest)

        return new Redemption(this, redemptionDetails)
    }

    /**
     * Fetches the latest redemption details from the chain. These can change
     * after fee bumps.
     *
     * Returns a promise to the redemption details, or to null if there is no
     * current redemption in progress.
     */
    async getLatestRedemptionDetails() {
        // If the contract is ACTIVE, there's definitely no redemption. This can
        // be generalized to a state check that the contract is either
        // AWAITING_WITHDRAWAL_SIGNATURE or AWAITING_WITHDRAWAL_PROOF, but let's
        // hold on that for now.
        if (await this.contract.inActive()) {
            return null
        }

        const redemptionRequest = await EthereumHelpers.getExistingEvent(
            this.factory.systemContract,
            'RedemptionRequested',
            { _depositContractAddress: this.address },
        )

        if (! redemptionRequest) {
            return null
        }

        return this.redemptionDetailsFromEvent(redemptionRequest.args)
    }

    ///------------------------------- Helpers ---------------------------------

    /**
     * @typedef {Object} AutoSubmitState
     * @prop {Promise<BitcoinTransaction>} fundingTransaction
     * @prop {Promise<{ transaction: FoundTransaction, requiredConfirmations: Number }>} fundingConfirmations
     * @prop {Promise<EthereumTransaction>} proofTransaction
     */
    /**
     * This method enables the deposit's auto-submission capabilities. In
     * auto-submit mode, the deposit will automatically monitor for a new
     * Bitcoin transaction to the deposit signers' Bitcoin wallet, then watch
     * that transaction until it has accumulated sufficient work for proof
     * of funding to be submitted to the deposit, then submit that proof to the
     * deposit to qualify it and move it into the ACTIVE state.
     *
     * Without calling this function, the deposit will do none of those things;
     * instead, the caller will be in charge of managing (or choosing not to)
     * this process. This can be useful, for example, if a dApp wants to open
     * a deposit, then transfer the deposit to a service provider who will
     * handle deposit qualification.
     *
     * Calling this function more than once will return the existing state of
     * the first auto submission process, rather than restarting the process.
     *
     * @return {AutoSubmitState} An object with promises to various stages of
     *         the auto-submit lifetime. Each promise can be fulfilled or
     *         rejected, and they are in a sequence where later promises will be
     *         rejected by earlier ones.
     */
    autoSubmit() {
        // Only enable auto-submitting once.
        if (this.autoSubmittingState) {
            return this.autoSubmittingState
        }
        /** @type {AutoSubmitState} */
        const state = this.autoSubmittingState = {}

        state.fundingTransaction = this.bitcoinAddress.then(async (address) => {
            const expectedValue = await this.getSatoshiLotSize()

            console.debug(
                `Monitoring Bitcoin for transaction to address ${address}...`,
            )
            return BitcoinHelpers.Transaction.findOrWaitFor(address, expectedValue)
        })

        state.fundingConfirmations = state.fundingTransaction.then(async (transaction) => {
            const requiredConfirmations = (await this.factory.constantsContract.methods.getTxProofDifficultyFactor().call())

            console.debug(
                `Waiting for ${requiredConfirmations} confirmations for ` +
                `Bitcoin transaction ${transaction.transactionID}...`
            )
            await BitcoinHelpers.Transaction.waitForConfirmations(
                transaction,
                requiredConfirmations,
            )

            return { transaction, requiredConfirmations }
        })

        state.proofTransaction = state.fundingConfirmations.then(async ({ transaction, requiredConfirmations }) => {
            console.debug(
                `Submitting funding proof to deposit ${this.address} for ` +
                `Bitcoin transaction ${transaction.transactionID}...`
            )
            const proofArgs = await this.constructFundingProof(transaction, requiredConfirmations)
            return this.contract.methods.provideBTCFundingProof(...proofArgs).send()
        })

        return state
    }

    // Finds an existing event from the keep backing the Deposit to access the
    // keep's public key, then submits it to the deposit to transition from
    // state AWAITING_SIGNER_SETUP to state AWAITING_BTC_FUNDING_PROOF and
    // provide access to the Bitcoin address for the deposit.
    //
    // Note that the client must do this public key submission to the deposit
    // manually; the deposit is not currently informed by the Keep of its newly-
    // generated pubkey for a variety of reasons.
    //
    // Returns a promise that will be fulfilled once the public key is
    // available, with a public key point with x and y properties.
    async findOrWaitForPublicKeyPoint() {
        let signerPubkeyEvent = await this.readPublishedPubkeyEvent()
        if (signerPubkeyEvent) {
            console.debug(
                `Found existing Bitcoin address for deposit ${this.address}...`,
            )
            return {
                x: signerPubkeyEvent.args._signingGroupPubkeyX,
                y: signerPubkeyEvent.args._signingGroupPubkeyY,
            }
        }

        console.debug(`Waiting for deposit ${this.address} keep public key...`)

        // Wait for the Keep to be ready.
        await EthereumHelpers.getEvent(this.keepContract, 'PublicKeyPublished')

        console.debug(`Waiting for deposit ${this.address} to retrieve public key...`)
        // Ask the deposit to fetch and store the signer pubkey.
        const pubkeyTransaction = await this.contract.methods.retrieveSignerPubkey().send()

        console.debug(`Found public key for deposit ${this.address}...`)
        const {
            _signingGroupPubkeyX,
            _signingGroupPubkeyY,
        } = EthereumHelpers.readEventFromTransaction(
                this.factory.config.web3,
                pubkeyTransaction,
                this.factory.systemContract,
                'RegisteredPubkey',
            )

        return {
            x: _signingGroupPubkeyX,
            y: _signingGroupPubkeyY,
        }
    }

    // Returns a promise that is fulfilled when the contract has entered the
    // active state.
    async waitForActiveState() {
        const depositIsActive = await this.contract.methods.inActive().call()
        if (depositIsActive) {
            return true
        }

        console.debug(`Monitoring deposit ${this.address} for transition to ACTIVE.`)

        // If we weren't active, wait for Funded, then mark as active.
        // FIXME/NOTE: We could be inactive due to being outside of the funding
        // FIXME/NOTE: path, e.g. in liquidation or courtesy call.
        await EthereumHelpers.getEvent(
            this.factory.systemContract,
            'Funded',
            { _depositContractAddress: this.address },
        )
        console.debug(`Deposit ${this.address} transitioned to ACTIVE.`)

        return true
    }

        return this.contract.provideBTCFundingProof(...proofArgs)
      }
    )

    return state
  }

  // Finds an existing event from the keep backing the Deposit to access the
  // keep's public key, then submits it to the deposit to transition from
  // state AWAITING_SIGNER_SETUP to state AWAITING_BTC_FUNDING_PROOF and
  // provide access to the Bitcoin address for the deposit.
  //
  // Note that the client must do this public key submission to the deposit
  // manually; the deposit is not currently informed by the Keep of its newly-
  // generated pubkey for a variety of reasons.
  //
  // Returns a promise that will be fulfilled once the public key is
  // available, with a public key point with x and y properties.
  async findOrWaitForPublicKeyPoint() {
    const signerPubkeyEvent = await this.readPublishedPubkeyEvent()
    if (signerPubkeyEvent) {
      console.debug(
        `Found existing Bitcoin address for deposit ${this.address}...`
      )
      return {
        x: signerPubkeyEvent.args._signingGroupPubkeyX,
        y: signerPubkeyEvent.args._signingGroupPubkeyY
      }
    }

    console.debug(`Waiting for deposit ${this.address} keep public key...`)

    // Wait for the Keep to be ready.
    await EthereumHelpers.getEvent(this.keepContract, "PublicKeyPublished")

    console.debug(
      `Waiting for deposit ${this.address} to retrieve public key...`
    )
    // Ask the deposit to fetch and store the signer pubkey.
    const pubkeyTransaction = await this.contract.retrieveSignerPubkey({
      from: this.factory.config.web3.eth.defaultAccount
    })

    console.debug(`Found public key for deposit ${this.address}...`)
    const {
      _signingGroupPubkeyX,
      _signingGroupPubkeyY
    } = EthereumHelpers.readEventFromTransaction(
      this.factory.config.web3,
      pubkeyTransaction,
      this.factory.systemContract,
      "RegisteredPubkey"
    )

    return {
      x: _signingGroupPubkeyX,
      y: _signingGroupPubkeyY
    }
  }

  // Returns a promise that is fulfilled when the contract has entered the
  // active state.
  async waitForActiveState() {
    const depositIsActive = await this.contract.inActive()
    if (depositIsActive) {
      return true
    }

    console.debug(
      `Monitoring deposit ${this.address} for transition to ACTIVE.`
    )

    // If we weren't active, wait for Funded, then mark as active.
    // FIXME/NOTE: We could be inactive due to being outside of the funding
    // FIXME/NOTE: path, e.g. in liquidation or courtesy call.
    await EthereumHelpers.getEvent(this.factory.systemContract, "Funded", {
      _depositContractAddress: this.address
    })

    console.debug(`Deposit ${this.address} transitioned to ACTIVE.`)

    return true
  }

  async readPublishedPubkeyEvent() {
    return EthereumHelpers.getExistingEvent(
      this.factory.systemContract,
      "RegisteredPubkey",
      { _depositContractAddress: this.address }
    )
  }

  async publicKeyPointToBitcoinAddress(publicKeyPoint) {
    return BitcoinHelpers.Address.publicKeyPointToP2WPKHAddress(
      publicKeyPoint.x,
      publicKeyPoint.y,
      this.factory.config.bitcoinNetwork
    )
  }

  // Given a Bitcoin transaction and the number of confirmations that need to
  // be proven constructs an SPV proof and returns the raw parameters that
  // would be given to an on-chain contract.
  //
  // These are:
  // - version
  // - txInVector
  // - txOutVector
  // - locktime
  // - outputPosition
  // - merkleProof
  // - txInBlockIndex
  // - chainHeaders
  //
  // Constructed this way to serve both qualify + mint and simple
  // qualification flows.
  async constructFundingProof(bitcoinTransaction, confirmations) {
    const { transactionID, outputPosition } = bitcoinTransaction
    const {
      parsedTransaction,
      merkleProof,
      chainHeaders,
      txInBlockIndex
    } = await BitcoinHelpers.Transaction.getSPVProof(
      transactionID,
      confirmations
    )

    const { version, txInVector, txOutVector, locktime } = parsedTransaction

    return [
      Buffer.from(version, "hex"),
      Buffer.from(txInVector, "hex"),
      Buffer.from(txOutVector, "hex"),
      Buffer.from(locktime, "hex"),
      outputPosition,
      Buffer.from(merkleProof, "hex"),
      txInBlockIndex,
      Buffer.from(chainHeaders, "hex")
    ]
  }

  redemptionDetailsFromEvent(
    redemptionRequestedEventArgs
  ) /* : RedemptionDetails*/ {
    const {
      _utxoSize,
      _redeemerOutputScript,
      _requestedFee,
      _outpoint,
      _digest
    } = redemptionRequestedEventArgs

    const toBN = this.factory.config.web3.utils.toBN
    return {
      utxoSize: toBN(_utxoSize),
      redeemerOutputScript: _redeemerOutputScript,
      requestedFee: toBN(_requestedFee),
      outpoint: _outpoint,
      digest: _digest
    }
  }
}
