import { type CloseReason, isCloseReason, RelayProtocolError } from './errors.js'
import { frameHeaderBytes, maxCloseBytes, maxDataBytes, maxUint64, relayVersion } from './limits.js'

export interface DataFrame {
  readonly type: 'data'
  readonly seq: bigint
  readonly cumulativeBytes: bigint
  readonly payload: Uint8Array
}

export interface AckFrame {
  readonly type: 'ack'
  readonly seq: bigint
  readonly cumulativeBytes: bigint
}

export interface CloseFrame {
  readonly type: 'close'
  readonly reason: CloseReason
}

export type RelayFrame = DataFrame | AckFrame | CloseFrame

function checkCounter(value: bigint): void {
  if (typeof value !== 'bigint' || value < 1n || value > maxUint64) {
    throw new RelayProtocolError('Counter is outside uint64 range')
  }
}

export function encodeFrame(frame: RelayFrame): Uint8Array<ArrayBuffer> {
  let payload: Uint8Array = new Uint8Array(0)
  let seq = 0n
  let cumulativeBytes = 0n
  let type: number
  switch (frame.type) {
    case 'data':
      type = 1
      payload = frame.payload
      if (!(payload instanceof Uint8Array) || payload.byteLength < 1 || payload.byteLength > maxDataBytes) {
        throw new RelayProtocolError('Invalid DATA length')
      }
      seq = frame.seq
      cumulativeBytes = frame.cumulativeBytes
      break
    case 'ack':
      type = 2
      seq = frame.seq
      cumulativeBytes = frame.cumulativeBytes
      break
    case 'close':
      type = 3
      if (!isCloseReason(frame.reason)) throw new RelayProtocolError('Invalid CLOSE reason')
      payload = new TextEncoder().encode(JSON.stringify({ reason: frame.reason }))
      break
    default:
      throw new RelayProtocolError('Unknown frame type')
  }
  if (frame.type !== 'close') {
    checkCounter(seq)
    checkCounter(cumulativeBytes)
    if (cumulativeBytes < BigInt(payload.byteLength)) throw new RelayProtocolError('Invalid cumulative size')
  }
  const result = new Uint8Array(frameHeaderBytes + payload.byteLength)
  const view = new DataView(result.buffer)
  view.setUint8(0, relayVersion)
  view.setUint8(1, type)
  view.setBigUint64(4, seq)
  view.setBigUint64(12, cumulativeBytes)
  view.setUint32(20, payload.byteLength)
  result.set(payload, frameHeaderBytes)
  return result
}

/** DATA borrows the input buffer. Copy the payload before retaining or mutating the input. */
export function decodeFrame(bytes: Uint8Array): RelayFrame {
  if (bytes.byteLength < frameHeaderBytes || bytes.byteLength > frameHeaderBytes + maxDataBytes) {
    throw new RelayProtocolError('Invalid frame length')
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (view.getUint8(0) !== relayVersion || view.getUint16(2) !== 0) {
    throw new RelayProtocolError('Unsupported version or flags')
  }
  const type = view.getUint8(1)
  const seq = view.getBigUint64(4)
  const cumulativeBytes = view.getBigUint64(12)
  const size = view.getUint32(20)
  if (size !== bytes.byteLength - frameHeaderBytes) throw new RelayProtocolError('Payload length mismatch')
  const payload = bytes.subarray(frameHeaderBytes)
  if (type === 3) {
    if (seq !== 0n || cumulativeBytes !== 0n || size < 1 || size > maxCloseBytes) {
      throw new RelayProtocolError('Invalid CLOSE frame')
    }
    try {
      const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(payload))
      if (
        typeof parsed !== 'object' ||
        parsed === null ||
        Object.keys(parsed).length !== 1 ||
        !('reason' in parsed) ||
        !isCloseReason(parsed.reason)
      ) {
        throw new RelayProtocolError('Invalid CLOSE reason')
      }
      return { type: 'close', reason: parsed.reason }
    } catch {
      throw new RelayProtocolError('Invalid CLOSE payload')
    }
  }
  checkCounter(seq)
  checkCounter(cumulativeBytes)
  if (type === 1 && size > 0 && size <= maxDataBytes && cumulativeBytes >= BigInt(size)) {
    return { type: 'data', seq, cumulativeBytes, payload }
  }
  if (type === 2 && size === 0) return { type: 'ack', seq, cumulativeBytes }
  throw new RelayProtocolError('Invalid DATA/ACK frame')
}
