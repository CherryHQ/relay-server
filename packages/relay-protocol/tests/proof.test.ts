import { expect, test } from 'bun:test'
import { createHash, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto'

import {
  bytesToHex,
  canonicalRelayOrigin,
  encodeProofTranscript,
  payloadBytes,
  type ProofContext,
} from '../src/index.js'
import vector from '../vectors/proof-v1.json'

const context: ProofContext = {
  origin: 'https://relay.example',
  purpose: 'session',
  method: 'POST',
  path: '/v1/sessions',
  targetRef: 'desktop_1',
  sessionId: '',
  role: 'mobile',
  peerId: 'peer_1',
  challengeId: 'challenge_1',
  nonce: 'nonce_1',
}
const hash = (text: string) => createHash('sha256').update(payloadBytes(text)).digest()

test('matches the independent fixed transcript and Ed25519 verification vector', () => {
  const digest = hash(vector.payloadJson)
  expect(bytesToHex(digest)).toBe(vector.payloadSha256)
  const transcript = encodeProofTranscript(vector.context as ProofContext, digest)
  expect(bytesToHex(transcript)).toBe(vector.transcriptHex)
  const publicKey = createPublicKey({
    key: Buffer.from(vector.publicKeySpkiHex, 'hex'),
    format: 'der',
    type: 'spki',
  })
  expect(verify(null, transcript, publicKey, Buffer.from(vector.signatureHex, 'hex'))).toBe(true)
})

test('length prefixes are UTF-8 byte lengths and use fixed field order', () => {
  const transcript = encodeProofTranscript({ ...context, targetRef: '设备' }, hash('{}'))
  const view = new DataView(transcript.buffer)
  const fields: string[] = []
  for (let offset = 0; offset < transcript.length;) {
    const length = view.getUint32(offset)
    fields.push(new TextDecoder().decode(transcript.subarray(offset + 4, offset + 4 + length)))
    offset += 4 + length
  }
  expect(fields).toEqual([
    'cherry-relay-auth-v1',
    '1',
    context.origin,
    'session',
    'POST /v1/sessions',
    '设备',
    '',
    'mobile',
    'peer_1',
    'challenge_1',
    'nonce_1',
    bytesToHex(hash('{}')),
  ])
})

test('real Ed25519 signatures bind every context field and exact payload text', () => {
  const keys = generateKeyPairSync('ed25519')
  const digest = hash('{"a":1,"b":2}')
  const signature = sign(null, encodeProofTranscript(context, digest), keys.privateKey)
  expect(verify(null, encodeProofTranscript(context, digest), keys.publicKey, signature)).toBe(true)
  for (const [key, value] of Object.entries({
    origin: 'https://other.example',
    purpose: 'attach',
    method: 'DELETE',
    path: '/v1/other',
    targetRef: 'other',
    sessionId: 'new',
    role: 'desktop',
    peerId: 'other',
    challengeId: 'other',
    nonce: 'other',
  })) {
    const changed = { ...context, [key]: value } as ProofContext
    expect(verify(null, encodeProofTranscript(changed, digest), keys.publicKey, signature)).toBe(false)
  }
  expect(
    verify(null, encodeProofTranscript(context, hash('{ "a":1,"b":2}')), keys.publicKey, signature),
  ).toBe(false)
  expect(verify(null, encodeProofTranscript(context, hash('{"b":2,"a":1}')), keys.publicKey, signature)).toBe(
    false,
  )
})

test('origins and proof input sizes are bounded before signing', () => {
  expect(canonicalRelayOrigin('https://RELAY.example:443/')).toBe('https://relay.example')
  for (const origin of [
    'http://relay.example',
    'https://u:p@relay.example',
    'https://relay.example/a/..',
    'https://relay.example/?',
    'https://relay.example/#',
    'https://relay.example/route',
    ' https://relay.example',
    'https://relay.example\\path',
  ]) {
    expect(() => canonicalRelayOrigin(origin)).toThrow()
  }
  expect(canonicalRelayOrigin('http://127.0.0.1:3000', true)).toBe('http://127.0.0.1:3000')
  expect(() => payloadBytes('界'.repeat(25_000))).toThrow()
  expect(() => encodeProofTranscript({ ...context, path: '/v1/sessions?token=x' }, hash('{}'))).toThrow()
  expect(() => encodeProofTranscript(context, new Uint8Array(31))).toThrow()
})
