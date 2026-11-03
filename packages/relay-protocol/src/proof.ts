import { RelayProtocolError } from './errors.js'
import { maxControlBytes, relayVersion } from './limits.js'

export interface ProofContext {
  readonly origin: string
  readonly purpose: string
  readonly method: 'POST' | 'DELETE'
  readonly path: string
  readonly targetRef: string
  readonly sessionId: string
  readonly role: 'desktop' | 'mobile'
  readonly peerId: string
  readonly challengeId: string
  readonly nonce: string
}

export interface ProofEnvelope {
  readonly payloadJson: string
  readonly proof: {
    readonly challengeId: string
    readonly nonce: string
    /** Ed25519 signature as 128 lowercase hexadecimal characters. */
    readonly signature: string
  }
}

export function canonicalRelayOrigin(value: string, allowLoopbackHttp = false): string {
  if (!/^https?:\/\/[^/?#]+\/?$/.test(value) || /\s/.test(value)) {
    throw new RelayProtocolError('Expected an HTTP origin without a path, query or fragment')
  }
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new RelayProtocolError('Invalid relay origin')
  }
  const loopback = ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)
  if (
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    (url.protocol !== 'https:' && !(allowLoopbackHttp && url.protocol === 'http:' && loopback))
  ) {
    throw new RelayProtocolError('Invalid or insecure relay origin')
  }
  return url.origin
}

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

export function payloadBytes(payloadJson: string): Uint8Array {
  // Check UTF-16 length first to bound allocation before UTF-8 encoding.
  if (payloadJson.length === 0 || payloadJson.length > maxControlBytes) {
    throw new RelayProtocolError('Invalid authenticated payload size')
  }
  const bytes = new TextEncoder().encode(payloadJson)
  if (bytes.byteLength > maxControlBytes) throw new RelayProtocolError('Authenticated payload is too large')
  return bytes
}

/** Hash the exact payloadJson UTF-8 bytes; never parse and reserialize before signing. */
export function encodeProofTranscript(
  context: ProofContext,
  payloadSha256: Uint8Array,
  allowLoopbackHttp = false,
): Uint8Array {
  if (payloadSha256.byteLength !== 32) throw new RelayProtocolError('Expected a SHA-256 digest')
  if (context.method !== 'POST' && context.method !== 'DELETE') throw new RelayProtocolError('Invalid method')
  if (context.role !== 'desktop' && context.role !== 'mobile') throw new RelayProtocolError('Invalid role')
  if (!/^\/v1\/[a-zA-Z0-9/_-]+$/.test(context.path) || context.path.includes('//')) {
    throw new RelayProtocolError('Expected a canonical request path')
  }
  const origin = canonicalRelayOrigin(context.origin, allowLoopbackHttp)
  const fields = [
    'cherry-relay-auth-v1',
    String(relayVersion),
    origin,
    context.purpose,
    `${context.method} ${context.path}`,
    context.targetRef,
    context.sessionId,
    context.role,
    context.peerId,
    context.challengeId,
    context.nonce,
    bytesToHex(payloadSha256),
  ]
  const encoder = new TextEncoder()
  const parts = fields.map((field, index) => {
    if (typeof field !== 'string' || field.length > 512 || (field.length === 0 && index !== 6)) {
      throw new RelayProtocolError('Invalid proof field')
    }
    const bytes = encoder.encode(field)
    if (bytes.byteLength > 1024) throw new RelayProtocolError('Proof field is too large')
    return bytes
  })
  const result = new Uint8Array(parts.reduce((total, part) => total + 4 + part.byteLength, 0))
  const view = new DataView(result.buffer)
  let offset = 0
  for (const part of parts) {
    view.setUint32(offset, part.byteLength)
    result.set(part, offset + 4)
    offset += 4 + part.byteLength
  }
  return result
}
