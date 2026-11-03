import {
  type AckFrame,
  type DataFrame,
  type RelayLimits,
  RelayProtocolError,
} from '@cherrystudio/relay-protocol'

import type { NativeSender } from './ports.js'

/** One second of burst capacity; no per-account state or persistent usage ledger. */
export class RateBudget {
  private tokens: number
  private updatedAt: number

  constructor(
    private readonly perSecond: number,
    now: number,
  ) {
    this.tokens = perSecond
    this.updatedAt = now
  }

  take(amount: number, now: number): boolean {
    this.tokens = Math.min(
      this.perSecond,
      this.tokens + (Math.max(0, now - this.updatedAt) * this.perSecond) / 1000,
    )
    this.updatedAt = now
    if (amount > this.tokens) return false
    this.tokens -= amount
    return true
  }
}

/** Metadata only. The host owns bounded byte queues; opaque DATA is never replayed. */
export class ForwardingDirection {
  private receivedSeq = 0n
  private receivedBytes = 0n
  private forwardedSeq = 0n
  private ackedSeq = 0n
  private ackedBytes = 0n
  private readonly boundaries = new Map<bigint, bigint>()
  private deadline: number | undefined

  constructor(
    private readonly limits: RelayLimits,
    private readonly stallMs: number,
  ) {}

  data(frame: DataFrame, now: number): void {
    if (
      frame.seq !== this.receivedSeq + 1n ||
      frame.cumulativeBytes !== this.receivedBytes + BigInt(frame.payload.byteLength) ||
      frame.payload.byteLength > this.limits.maxFrameBytes ||
      frame.cumulativeBytes - this.ackedBytes > BigInt(this.limits.windowBytes) ||
      this.boundaries.size >= this.limits.maxInFlightFrames
    )
      throw new RelayProtocolError('DATA exceeds sequence or credit')
    this.receivedSeq = frame.seq
    this.receivedBytes = frame.cumulativeBytes
    this.boundaries.set(frame.seq, frame.cumulativeBytes)
    this.deadline ??= now + this.stallMs
  }

  forwarded(seq: bigint): void {
    this.forwardedSeq = seq
  }

  ack(frame: AckFrame, now: number): boolean {
    if (frame.seq === this.ackedSeq && frame.cumulativeBytes === this.ackedBytes) return false
    if (
      frame.seq <= this.ackedSeq ||
      frame.seq > this.forwardedSeq ||
      this.boundaries.get(frame.seq) !== frame.cumulativeBytes
    ) {
      throw new RelayProtocolError('ACK does not match a forwarded DATA boundary')
    }
    this.ackedSeq = frame.seq
    this.ackedBytes = frame.cumulativeBytes
    for (const seq of this.boundaries.keys()) {
      if (seq > frame.seq) break
      this.boundaries.delete(seq)
    }
    this.deadline = this.boundaries.size ? now + this.stallMs : undefined
    return true
  }

  stalled(now: number): boolean {
    return this.deadline !== undefined && now >= this.deadline
  }

  clear(): void {
    this.boundaries.clear()
    this.deadline = undefined
  }
}

export class BufferBudget {
  used = 0
  constructor(readonly limit: number) {}

  reserve(bytes: number): boolean {
    if (this.used + bytes > this.limit) return false
    this.used += bytes
    return true
  }

  adjust(delta: number): boolean {
    this.used += delta
    return this.used <= this.limit
  }
}

interface QueuedMessage {
  readonly data: string | Uint8Array
  readonly cost: number
  readonly onSent: (() => void) | undefined
}

/** Accounts for JS queues AND native buffers, including at most 10 bytes of WS framing per message. */
export class BufferedSender {
  private readonly queue: QueuedMessage[] = []
  private queuedBytes = 0
  private nativeBytes = 0
  private blocked = false
  private disposed = false
  private progressAt: number | undefined
  private lastBytes = 0

  constructor(
    private readonly native: NativeSender,
    private readonly budget: BufferBudget,
    private readonly maxBytes: number,
    private readonly maxItems: number,
  ) {}

  get stats() {
    return { queuedBytes: this.queuedBytes, nativeBytes: this.nativeBytes, queuedItems: this.queue.length }
  }

  private observe(): boolean {
    const bytes = this.native.bufferedAmount
    if (!Number.isSafeInteger(bytes) || bytes < 0) return false
    const withinBudget = this.budget.adjust(bytes - this.nativeBytes)
    this.nativeBytes = bytes
    return withinBudget && this.nativeBytes + this.queuedBytes <= this.maxBytes
  }

  send(data: string | Uint8Array, onSent?: () => void): boolean {
    if (this.disposed || !this.observe()) return false
    const cost = (typeof data === 'string' ? new TextEncoder().encode(data).byteLength : data.byteLength) + 10
    if (
      this.queue.length >= this.maxItems ||
      this.nativeBytes + this.queuedBytes + cost > this.maxBytes ||
      !this.budget.reserve(cost)
    )
      return false
    if (this.blocked || this.queue.length) {
      this.queuedBytes += cost
      // Bun's callback input can be reused after the handler returns. Retain only a bounded copy.
      this.queue.push({ data: typeof data === 'string' ? data : Uint8Array.from(data), cost, onSent })
      return true
    }
    return this.write({ data, cost, onSent })
  }

  private write(message: QueuedMessage): boolean {
    this.nativeBytes += message.cost // Transfer the reservation to the native side before send().
    let result: number
    try {
      result = this.native.send(message.data)
    } catch {
      return false
    }
    const bounded = this.observe()
    if (result === 0 || !bounded) return false
    this.blocked = result === -1 || this.nativeBytes > 0
    message.onSent?.()
    return true
  }

  drain(): boolean {
    if (this.disposed || !this.observe()) return false
    this.blocked = this.nativeBytes > 0
    while (!this.blocked && this.queue.length && !this.disposed) {
      const message = this.queue.shift()
      if (!message) break
      this.queuedBytes -= message.cost
      if (!this.write(message)) return false
    }
    return true
  }

  healthy(now: number, stallMs: number): boolean {
    if (this.disposed || !this.observe()) return false
    const bytes = this.queuedBytes + this.nativeBytes
    if (!this.blocked && bytes === 0) this.progressAt = undefined
    else if (this.progressAt === undefined || bytes < this.lastBytes) this.progressAt = now
    this.lastBytes = bytes
    return this.progressAt === undefined || now - this.progressAt < stallMs
  }

  discardQueue(): void {
    this.budget.adjust(-this.queuedBytes)
    this.queuedBytes = 0
    this.queue.length = 0
  }

  /** Call only after the socket has closed/terminated; otherwise native bytes still consume capacity. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.discardQueue()
    this.budget.adjust(-this.nativeBytes)
    this.nativeBytes = 0
  }
}
