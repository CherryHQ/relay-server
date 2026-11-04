import { afterEach, describe, expect, test } from 'bun:test'

import { decodeFrame, encodeFrame } from '@cherrystudio/relay-protocol'
import { defaultLogger } from '@libp2p/logger'

import { RelayStream, type RelayStreamOptions } from '../src/index.js'
import { flush, TestSocket } from './socket.js'

const streams: RelayStream[] = []
const small = { maxFrameBytes: 4, windowBytes: 8, maxInFlightFrames: 2 }
function create(socket = new TestSocket(), options: Partial<RelayStreamOptions> = {}) {
  const stream = new RelayStream(socket, { log: defaultLogger().forComponent('test'), ...options })
  streams.push(stream)
  return { socket, stream }
}
function data(seq: number, cumulativeBytes: number, size = 1) {
  return encodeFrame({
    type: 'data',
    seq: BigInt(seq),
    cumulativeBytes: BigInt(cumulativeBytes),
    payload: new Uint8Array(size),
  })
}
function ack(seq: number, cumulativeBytes: number) {
  return encodeFrame({ type: 'ack', seq: BigInt(seq), cumulativeBytes: BigInt(cumulativeBytes) })
}
afterEach(() => {
  for (const stream of streams.splice(0)) stream.abort(new Error('Test cleanup'))
})

describe('RelayStream flow control', () => {
  test('transport receipts never release DATA credit or reach the application', () => {
    const { socket, stream } = create(undefined, { limits: small })
    stream.send(new Uint8Array(8))
    socket.inject(JSON.stringify({ v: 1, type: 'probe', nonce: 'ab'.repeat(16) }))
    expect(stream.stats.unacknowledgedBytes).toBe(8n)
    expect(stream.stats.receivedBytes).toBe(0n)
    expect(JSON.parse(socket.controls[0] as string)).toEqual({
      v: 1,
      type: 'probe_ack',
      nonce: 'ab'.repeat(16),
    })
    socket.inject(JSON.stringify({ v: 1, type: 'probe', nonce: 'invalid' }))
    expect(stream.status).toBe('aborted')
  })
  test('each drain wait needs new credit; a timer tick cannot invent credit', async () => {
    const { socket, stream } = create(undefined, { limits: small })
    for (let cycle = 1; cycle <= 2; cycle++) {
      stream.send(new Uint8Array(8))
      let drained = false
      const pending = stream.onDrain().then(() => {
        drained = true
      })
      await Bun.sleep(30)
      expect(drained).toBe(false)
      socket.inject(ack(cycle * 2, cycle * 8))
      await pending
      expect(drained).toBe(true)
    }
  })

  test('fragments, copies caller bytes, stops at credit, resumes only on matching ACK', async () => {
    const { socket, stream } = create(undefined, { limits: small })
    const bytes = Uint8Array.from({ length: 20 }, (_, index) => index)
    expect(stream.send(bytes)).toBe(false)
    bytes.fill(255)
    expect(socket.sent).toHaveLength(2)
    expect(stream.stats.unacknowledgedBytes).toBe(8n)
    expect(stream.stats.sendQueueBytes).toBe(12)
    socket.inject(ack(2, 8))
    await flush()
    expect(socket.sent).toHaveLength(4)
    socket.inject(ack(4, 16))
    await flush()
    socket.inject(ack(5, 20))
    expect(stream.stats.unacknowledgedFrames).toBe(0)
    const received = socket.sent.flatMap((bytes) => {
      const frame = decodeFrame(bytes)
      return frame.type === 'data' ? [...frame.payload] : []
    })
    expect(received).toEqual(Array.from({ length: 20 }, (_, index) => index))
    await stream.close()
    expect(socket.closes).toBe(1)
    expect(socket.listenerCount).toBe(0)
  })

  test('limits tiny-frame metadata independently of byte credit', () => {
    const { socket, stream } = create()
    for (let i = 0; i < 1024; i++) stream.send(new Uint8Array([i]))
    expect(stream.stats.unacknowledgedFrames).toBe(1024)
    expect(socket.sent).toHaveLength(1024)
    for (let i = 0; i < 1024; i++) stream.send(new Uint8Array([i]))
    expect(stream.stats.sendQueueItems).toBe(1024)
    expect(() => stream.send(new Uint8Array([0]))).toThrow('queue limit')
    expect(stream.status).toBe('aborted')
    expect(stream.stats.sendQueueBytes).toBe(0)
  })

  test('rejects oversized writes before copying them', () => {
    const { socket, stream } = create()
    expect(() => stream.send(new Uint8Array(2 * 1024 * 1024 + 1))).toThrow('queue limit')
    expect(socket.sent.map(decodeFrame)).toEqual([{ type: 'close', reason: 'RESOURCE_EXHAUSTED' }])
  })

  test('slow async reader keeps one yielded chunk and bounded stream queues', async () => {
    const left = new TestSocket()
    const right = new TestSocket()
    left.peer = right
    right.peer = left
    const sender = create(left).stream
    const reader = create(right).stream
    const iterator = reader[Symbol.asyncIterator]()
    const first = iterator.next()
    const expected = Uint8Array.from({ length: 1024 * 1024 }, (_, index) => index % 251)
    sender.send(expected)
    const chunks: Uint8Array[] = []
    const result = await first
    if (result.done) throw new Error('Expected bytes')
    chunks.push(result.value.subarray().slice())
    await flush()
    await flush()
    expect(reader.readStatus).toBe('paused')
    expect(reader.stats.receiveQueueBytes).toBeLessThanOrEqual(1024 * 1024)
    expect(reader.stats.receiveQueueItems).toBeLessThanOrEqual(1024)
    expect(sender.stats.unacknowledgedBytes).toBeLessThanOrEqual(256n * 1024n)
    let received = chunks[0]?.byteLength ?? 0
    while (received < expected.byteLength) {
      const next = await iterator.next()
      if (next.done) throw new Error('Premature end')
      const bytes = next.value.subarray().slice()
      chunks.push(bytes)
      received += bytes.byteLength
    }
    expect(Buffer.concat(chunks)).toEqual(Buffer.from(expected))
    await iterator.return(undefined)
    expect(reader.status).toBe('aborted')
    expect(right.listenerCount).toBe(0)
  })
})

describe('RelayStream failure and teardown', () => {
  test('ignores exact duplicate ACK but rejects backward, forged and future ACK', () => {
    for (const invalid of [ack(1, 4), ack(2, 7), ack(3, 12)]) {
      const { socket, stream } = create(undefined, { limits: small })
      stream.send(new Uint8Array(8))
      socket.inject(ack(2, 8))
      socket.inject(ack(2, 8))
      expect(stream.status).toBe('open')
      socket.inject(invalid)
      expect(stream.status).toBe('aborted')
      expect(socket.closes).toBe(1)
    }
  })

  test('rejects reordered DATA, credit violations and text frames', () => {
    for (const invalid of [data(2, 4, 4), data(1, 5, 4), data(1, 5, 5), '{}']) {
      const { socket, stream } = create(undefined, { limits: small })
      socket.inject(invalid)
      expect(stream.status).toBe('aborted')
    }
    const { socket, stream } = create()
    for (let i = 1; i <= 1025; i++) socket.inject(data(i, i))
    expect(stream.status).toBe('aborted')
    expect(stream.stats.receiveQueueBytes).toBe(0)
  })

  test('a -1 send is accepted once; a 0 send fails without retry', async () => {
    const accepted = create()
    accepted.socket.sendResult = -1
    accepted.socket.bufferedAmount = 100
    accepted.stream.send(new Uint8Array([1]))
    await Bun.sleep(30)
    expect(accepted.socket.sent).toHaveLength(1)
    accepted.socket.bufferedAmount = 0
    accepted.socket.inject(ack(1, 1))
    await accepted.stream.close()
    const dropped = create()
    dropped.socket.sendResult = 0
    expect(() => dropped.stream.send(new Uint8Array([1]))).toThrow('rejected')
    expect(dropped.stream.status).toBe('aborted')
    expect(dropped.socket.sent).toHaveLength(0)
  })

  test('socket buffering uses its own byte budget and waits for drain', async () => {
    const { socket, stream } = create()
    socket.bufferedAmount = 1024 * 1024
    stream.send(new Uint8Array([1]))
    expect(socket.sent).toHaveLength(0)
    socket.bufferedAmount = 0
    await Bun.sleep(40)
    expect(socket.sent).toHaveLength(1)
    socket.inject(ack(1, 1))
    await stream.close()
  })

  test('stalled ACK closes and rejects graceful close; cleanup is idempotent', async () => {
    const { socket, stream } = create(undefined, { stallMs: 30 })
    stream.send(new Uint8Array([1]))
    await expect(stream.close()).rejects.toThrow('stalled')
    stream.abort(new Error('Late error'))
    socket.inject(ack(1, 1))
    expect(socket.closes).toBe(1)
    expect(socket.listenerCount).toBe(0)
    expect(stream.stats.unacknowledgedFrames).toBe(0)
  })

  test('ongoing socket drain is progress even if the buffer does not reach zero', async () => {
    const { socket, stream } = create(undefined, { stallMs: 80 })
    socket.bufferedAmount = 1000
    stream.send(new Uint8Array([1]))
    socket.inject(ack(1, 1))
    for (let i = 0; i < 4; i++) {
      await Bun.sleep(30)
      socket.bufferedAmount -= 100
    }
    expect(stream.status).toBe('open')
    socket.bufferedAmount = 0
    await stream.close()
  })

  test('cancellation unblocks the reader and clears every socket listener', async () => {
    const controller = new AbortController()
    const { socket, stream } = create(undefined, { signal: controller.signal })
    const iterator = stream[Symbol.asyncIterator]()
    const pending = iterator.next()
    controller.abort()
    await expect(pending).rejects.toThrow('cancelled')
    expect(socket.listenerCount).toBe(0)
    expect(socket.closes).toBe(1)
  })

  test('normal close preserves unread bytes and ends an iterator', async () => {
    const { socket, stream } = create()
    socket.inject(data(1, 3, 3))
    socket.inject(encodeFrame({ type: 'close', reason: 'NORMAL' }))
    const iterator = stream[Symbol.asyncIterator]()
    expect((await iterator.next()).value?.byteLength).toBe(3)
    expect((await iterator.next()).done).toBe(true)
  })
})
