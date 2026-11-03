import { expect, test } from 'bun:test'

import { BufferBudget, BufferedSender, ForwardingDirection, RateBudget } from '../../src/core/forwarding.js'
import type { NativeSender } from '../../src/core/ports.js'

const limits = { maxFrameBytes: 4, windowBytes: 8, maxInFlightFrames: 2 }
const data = (seq: bigint, size = 4) => ({
  type: 'data' as const,
  seq,
  cumulativeBytes: seq * BigInt(size),
  payload: new Uint8Array(size),
})
const ack = (seq: bigint, bytes = seq * 4n) => ({ type: 'ack' as const, seq, cumulativeBytes: bytes })

test('server credit rejects unsent, forged and regressing ACKs; only advancing ACKs extend stall time', () => {
  const direction = new ForwardingDirection(limits, 100)
  direction.data(data(1n), 0)
  expect(() => direction.ack(ack(1n), 1)).toThrow()
  direction.forwarded(1n)
  expect(() => direction.ack(ack(1n, 3n), 1)).toThrow()
  expect(() => direction.ack(ack(2n), 1)).toThrow()
  direction.data(data(2n), 1)
  direction.forwarded(2n)
  expect(() => direction.data(data(3n), 2)).toThrow()
  expect(direction.ack(ack(1n), 50)).toBe(true)
  expect(direction.ack(ack(1n), 140)).toBe(false)
  expect(direction.stalled(150)).toBe(true)
  expect(direction.ack(ack(2n), 151)).toBe(true)
  expect(direction.stalled(1000)).toBe(false)
  expect(() => direction.ack(ack(1n), 1001)).toThrow()
})

test('server enforces frame ordering, item limits and byte limits independently', () => {
  const direction = new ForwardingDirection(limits, 100)
  expect(() => direction.data(data(2n), 0)).toThrow()
  expect(() => direction.data({ ...data(1n), cumulativeBytes: 5n }, 0)).toThrow()
  expect(() => direction.data(data(1n, 5), 0)).toThrow()
  direction.data(data(1n, 1), 0)
  direction.data(data(2n, 1), 0)
  expect(() => direction.data(data(3n, 1), 0)).toThrow()
})

class FakeNative implements NativeSender {
  bufferedAmount = 0
  result = -1
  readonly sent: (string | Uint8Array)[] = []
  send(data: string | Uint8Array): number {
    this.sent.push(typeof data === 'string' ? data : Uint8Array.from(data))
    if (this.result === -1) this.bufferedAmount += typeof data === 'string' ? data.length : data.byteLength
    return this.result
  }
}

test('-1 is sent once; queued buffers are copied and callbacks wait for native acceptance', () => {
  const native = new FakeNative()
  const budget = new BufferBudget(100)
  const sender = new BufferedSender(native, budget, 100, 2)
  const delivered: number[] = []
  expect(sender.send(new Uint8Array([1]), () => delivered.push(1))).toBe(true)
  const source = new Uint8Array([2])
  expect(sender.send(source, () => delivered.push(2))).toBe(true)
  source[0] = 99
  expect(native.sent).toEqual([new Uint8Array([1])])
  expect(delivered).toEqual([1])
  native.bufferedAmount = 0
  native.result = 1
  expect(sender.drain()).toBe(true)
  expect(native.sent).toEqual([new Uint8Array([1]), new Uint8Array([2])])
  expect(delivered).toEqual([1, 2])
  expect(budget.used).toBe(0)
  expect(sender.drain()).toBe(true)
  expect(native.sent).toHaveLength(2)
  sender.dispose()
  sender.dispose()
  expect(budget.used).toBe(0)
})

test('native + queued bytes, queue items and shared capacity are bounded even while closing', () => {
  const native = new FakeNative()
  const budget = new BufferBudget(50)
  const sender = new BufferedSender(native, budget, 40, 1)
  expect(sender.send(new Uint8Array(20))).toBe(true)
  expect(sender.send(new Uint8Array(10))).toBe(true)
  expect(sender.send(new Uint8Array(1))).toBe(false)
  const second = new BufferedSender(new FakeNative(), budget, 40, 1)
  expect(second.send(new Uint8Array(1))).toBe(false)
  sender.discardQueue()
  expect(budget.used).toBe(20) // Native bytes remain reserved until actual socket closure.
  expect(second.send(new Uint8Array(10))).toBe(true)
  sender.dispose()
  second.dispose()
  expect(budget.used).toBe(0)
})

test('native rejection is never counted as delivered; blocked senders expire without drain progress', () => {
  const native = new FakeNative()
  const budget = new BufferBudget(100)
  const sender = new BufferedSender(native, budget, 100, 10)
  expect(sender.send(new Uint8Array(20))).toBe(true)
  expect(sender.healthy(0, 100)).toBe(true)
  expect(sender.healthy(100, 100)).toBe(false)
  native.bufferedAmount = 10
  expect(sender.healthy(101, 100)).toBe(true)
  expect(sender.healthy(201, 100)).toBe(false)
  sender.dispose()
  const dropped = new FakeNative()
  dropped.result = 0
  const output = new BufferedSender(dropped, budget, 100, 10)
  let accepted = false
  expect(
    output.send(new Uint8Array(1), () => {
      accepted = true
    }),
  ).toBe(false)
  expect(accepted).toBe(false)
  output.dispose()
  expect(budget.used).toBe(0)
})

test('rate protection has a finite burst and replenishes by elapsed monotonic time', () => {
  const rate = new RateBudget(10, 0)
  expect(rate.take(10, 0)).toBe(true)
  expect(rate.take(1, 0)).toBe(false)
  expect(rate.take(5, 500)).toBe(true)
  expect(rate.take(6, 1000)).toBe(false)
  expect(rate.take(10, 10_000)).toBe(true)
  expect(rate.take(1, 10_000)).toBe(false)
})
