import { describe, expect, test } from 'bun:test'

import { bytesToHex, decodeFrame, encodeFrame, maxDataBytes, maxUint64 } from '../src/index.js'
import vectors from '../vectors/frame-v1.json'

describe('Relay v1 frame codec', () => {
  for (const vector of vectors) {
    test(vector.name, () => {
      const bytes = Uint8Array.from(Buffer.from(vector.hex, 'hex'))
      const frame = decodeFrame(bytes)
      expect(String(frame.type)).toBe(vector.type)
      if (frame.type === 'close') throw new Error('Unexpected close')
      expect(frame.seq.toString()).toBe(vector.seq)
      expect(frame.cumulativeBytes.toString()).toBe(vector.cumulativeBytes)
      if (frame.type === 'data') expect(bytesToHex(frame.payload)).toBe(vector.payloadHex ?? '')
      expect(bytesToHex(encodeFrame(frame))).toBe(vector.hex)
    })
  }

  test('decodes nonzero buffer offsets and preserves payload bytes', () => {
    const expected = encodeFrame({
      type: 'data',
      seq: 1n,
      cumulativeBytes: 3n,
      payload: new Uint8Array([1, 2, 3]),
    })
    const surrounding = new Uint8Array(expected.length + 8)
    surrounding.set(expected, 4)
    expect(decodeFrame(surrounding.subarray(4, -4))).toEqual(decodeFrame(expected))
  })

  test('accepts the largest payload and rejects empty, oversized and overflowing frames', () => {
    expect(
      decodeFrame(
        encodeFrame({
          type: 'data',
          seq: 1n,
          cumulativeBytes: BigInt(maxDataBytes),
          payload: new Uint8Array(maxDataBytes),
        }),
      ).type,
    ).toBe('data')
    for (const size of [0, maxDataBytes + 1]) {
      expect(() =>
        encodeFrame({ type: 'data', seq: 1n, cumulativeBytes: BigInt(size), payload: new Uint8Array(size) }),
      ).toThrow()
    }
    for (const seq of [-1n, 0n, maxUint64 + 1n]) {
      expect(() => encodeFrame({ type: 'ack', seq, cumulativeBytes: 1n })).toThrow()
    }
  })

  test('rejects corrupt headers, truncation, appended bytes and unknown types', () => {
    const original = encodeFrame({
      type: 'data',
      seq: 1n,
      cumulativeBytes: 3n,
      payload: new Uint8Array([1, 2, 3]),
    })
    for (const [offset, value] of [
      [0, 2],
      [1, 0],
      [1, 99],
      [3, 1],
      [23, 2],
      [11, 0],
      [19, 2],
    ]) {
      const malformed = original.slice()
      malformed[offset as number] = value as number
      expect(() => decodeFrame(malformed)).toThrow()
    }
    for (let size = 0; size < original.byteLength; size++) {
      expect(() => decodeFrame(original.subarray(0, size))).toThrow()
    }
    expect(() => decodeFrame(new Uint8Array([...original, 0]))).toThrow()
  })

  test('CLOSE accepts only bounded, enumerated JSON with zero counters', () => {
    expect(decodeFrame(encodeFrame({ type: 'close', reason: 'CANCELLED' }))).toEqual({
      type: 'close',
      reason: 'CANCELLED',
    })
    const frame = encodeFrame({ type: 'close', reason: 'NORMAL' })
    frame[11] = 1
    expect(() => decodeFrame(frame)).toThrow()
    const malicious = new TextEncoder().encode('{"reason":"NORMAL","stack":"secret"}')
    const bytes = new Uint8Array(24 + malicious.length)
    bytes.set([1, 3])
    new DataView(bytes.buffer).setUint32(20, malicious.length)
    bytes.set(malicious, 24)
    expect(() => decodeFrame(bytes)).toThrow()
  })
})
