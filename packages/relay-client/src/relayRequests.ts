import {
  bytesToHex,
  encodeProofTranscript,
  payloadBytes,
  type ProofContext,
} from '@cherrystudio/relay-protocol'

import type { ProofSigner, SignedRelayRequest } from './ports.js'

/** No fetch, credential storage, key export, automatic retry or authentication-service dependency. */
export async function signRelayRequest(
  payloadJson: string,
  context: ProofContext,
  signer: ProofSigner,
): Promise<SignedRelayRequest> {
  // Freeze the request identity before any asynchronous signer callback.
  const boundContext = Object.freeze({ ...context })
  const digest = await signer.sha256(payloadBytes(payloadJson))
  const signature = await signer.sign(encodeProofTranscript(boundContext, digest))
  if (signature.byteLength !== 64) throw new Error('Expected an Ed25519 signature')
  return {
    context: boundContext,
    envelope: {
      payloadJson,
      proof: {
        challengeId: boundContext.challengeId,
        nonce: boundContext.nonce,
        signature: bytesToHex(signature),
      },
    },
  }
}
