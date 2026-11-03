import { expect, test } from 'bun:test'
import { createHash, generateKeyPairSync, sign, verify } from 'node:crypto'

import { encodeProofTranscript, type ProofContext } from '@cherrystudio/relay-protocol'

import { signRelayRequest } from '../src/index.js'

test('request signing freezes context before asynchronous key access and preserves raw JSON', async () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const context = {
    origin: 'https://relay.example',
    purpose: 'session',
    method: 'POST',
    path: '/v1/sessions',
    targetRef: 'target',
    sessionId: '',
    role: 'mobile',
    peerId: 'peer',
    challengeId: 'challenge',
    nonce: 'nonce',
  } satisfies ProofContext
  const payload = '{ "targetRef": "target" }'
  const pending = signRelayRequest(payload, context, {
    async sha256(bytes) {
      await Promise.resolve()
      return createHash('sha256').update(bytes).digest()
    },
    async sign(bytes) {
      return sign(null, bytes, privateKey)
    },
  })
  context.targetRef = 'mutated'
  const result = await pending
  expect(result.context.targetRef).toBe('target')
  expect(Object.isFrozen(result.context)).toBe(true)
  expect(result.envelope.payloadJson).toBe(payload)
  expect(
    verify(
      null,
      encodeProofTranscript(result.context, createHash('sha256').update(payload).digest()),
      publicKey,
      Buffer.from(result.envelope.proof.signature, 'hex'),
    ),
  ).toBe(true)
})
