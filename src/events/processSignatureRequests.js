require('dotenv').config()
const promiseLimit = require('promise-limit')
const logger = require('../services/logger')
const { web3Home } = require('../services/web3')
const { createMessage } = require('../utils/message')
const { MAX_CONCURRENT_EVENTS } = require('../utils/constants')

const { VALIDATOR_ADDRESS, VALIDATOR_ADDRESS_PRIVATE_KEY } = process.env

const limit = promiseLimit(MAX_CONCURRENT_EVENTS)

let expectedMessageLength = null

function processSignatureRequestsBuilder(config) {
  const homeBridge = new web3Home.eth.Contract(config.homeBridgeAbi, config.homeBridgeAddress)

  return async function processSignatureRequests(signatureRequests) {
    const txToSend = []

    if (expectedMessageLength === null) {
      expectedMessageLength = await homeBridge.methods.requiredMessageLength().call()
    }

    const callbacks = signatureRequests.map(signatureRequest =>
      limit(async () => {
        const { recipient, value } = signatureRequest.returnValues

        logger.info(
          { eventTransactionHash: signatureRequest.transactionHash, sender: recipient, value },
          `Processing signatureRequest ${signatureRequest.transactionHash}`
        )

        const message = createMessage({
          recipient,
          value,
          transactionHash: signatureRequest.transactionHash,
          bridgeAddress: config.foreignBridgeAddress,
          expectedMessageLength
        })

        const signature = web3Home.eth.accounts.sign(message, `0x${VALIDATOR_ADDRESS_PRIVATE_KEY}`)

        let gasEstimate
        try {
          gasEstimate = await homeBridge.methods
            .submitSignature(signature.signature, message)
            .estimateGas({ from: VALIDATOR_ADDRESS })
        } catch (e) {
          if (e.message.includes('Invalid JSON RPC response')) {
            throw new Error(
              `RPC Connection Error: submitSignature Gas Estimate cannot be obtained.`
            )
          }
          logger.info(
            { eventTransactionHash: signatureRequest.transactionHash },
            `Already processed signatureRequest ${signatureRequest.transactionHash}`
          )
          return
        }

        const data = await homeBridge.methods
          .submitSignature(signature.signature, message)
          .encodeABI({ from: VALIDATOR_ADDRESS })

        txToSend.push({
          data,
          gasEstimate,
          transactionReference: signatureRequest.transactionHash,
          to: config.homeBridgeAddress
        })
      })
    )

    await Promise.all(callbacks)
    return txToSend
  }
}

module.exports = processSignatureRequestsBuilder
