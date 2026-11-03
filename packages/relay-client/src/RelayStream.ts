import {
  type AckFrame,
  type CloseReason,
  type DataFrame,
  decodeFrame,
  defaultRelayLimits,
  encodeFrame,
  maxUint64,
  type RelayLimits,
  RelayProtocolError,
  validateRelayLimits,
} from '@cherrystudio/relay-protocol'
import type { AbortOptions, Logger } from '@libp2p/interface'
import { AbstractMessageStream } from '@libp2p/utils'

import type { RelaySocket } from './ports.js'

type StreamData = Parameters<AbstractMessageStream['send']>[0]
const queueBytes = 1024 * 1024
// Existing remote-transport can hand us a complete encrypted 1 MiB upload record plus headers/tags.
const sendQueueBytes = 2 * 1024 * 1024
const queueItems = 1024

export interface RelayStreamOptions {
  readonly log: Logger
  readonly direction?: 'inbound' | 'outbound'
  /** The selection already authenticated by the connection owner, not public discovery metadata. */
  readonly limits?: RelayLimits
  readonly signal?: AbortSignal
  readonly stallMs?: number
}

function countChunks(data: Iterable<Uint8Array>): number {
  let count = 0
  for (const _chunk of data) count++
  return count
}

/**
 * Data adapter for an already admitted, ready WebSocket. The connection owner performs
 * authentication/ready matching before constructing this stream. It never owns business retries.
 */
export class RelayStream extends AbstractMessageStream {
  readonly limits: Readonly<RelayLimits>
  private readonly socket: RelaySocket
  private readonly signal: AbortSignal | undefined
  private readonly stallMs: number
  private readonly inFlight = new Map<bigint, bigint>()
  private sentSeq = 0n
  private sentBytes = 0n
  private ackedSeq = 0n
  private ackedBytes = 0n
  private receivedSeq = 0n
  private receivedBytes = 0n
  private receiptSeq = 0n
  private receiptBytes = 0n
  private sendDeadline: number | undefined
  private socketBlockedAt: number | undefined
  private lastSocketBuffered = 0
  private timer: ReturnType<typeof setTimeout> | undefined
  private finished = false
  private failure: Error | undefined
  private closePromise: Promise<void> | undefined
  private resolveClose: (() => void) | undefined
  private rejectClose: ((error: Error) => void) | undefined
  private iterating = false

  constructor(socket: RelaySocket, options: RelayStreamOptions) {
    const limits = validateRelayLimits(options.limits ?? defaultRelayLimits)
    const stallMs = options.stallMs ?? 15_000
    if (!Number.isSafeInteger(stallMs) || stallMs < 1 || stallMs > 15_000) {
      throw new RelayProtocolError('Invalid stall timeout')
    }
    if (socket.readyState !== 1) throw new Error('Relay socket must already be open and admitted')
    if (options.signal?.aborted) throw new Error('Relay connection cancelled')
    super({
      log: options.log,
      direction: options.direction ?? 'outbound',
      maxMessageSize: limits.maxFrameBytes,
      maxReadBufferLength: queueBytes,
      maxWriteBufferLength: sendQueueBytes,
      inactivityTimeout: 0,
    })
    this.socket = socket
    this.limits = limits
    this.signal = options.signal
    this.stallMs = stallMs
    socket.binaryType = 'arraybuffer'
    socket.addEventListener('message', this.receive)
    socket.addEventListener('close', this.socketClosed)
    socket.addEventListener('error', this.socketFailed)
    this.signal?.addEventListener('abort', this.cancel, { once: true })
  }

  get stats() {
    return {
      sentBytes: this.sentBytes,
      receivedBytes: this.receivedBytes,
      unacknowledgedBytes: this.sentBytes - this.ackedBytes,
      unacknowledgedFrames: this.inFlight.size,
      sendQueueBytes: this.writeBufferLength,
      receiveQueueBytes: this.readBufferLength,
      sendQueueItems: countChunks(this.writeBuffer),
      receiveQueueItems: countChunks(this.readBuffer),
      socketBufferedBytes: this.socket.bufferedAmount,
    }
  }

  override send(data: StreamData): boolean {
    if (this.finished || this.writeStatus !== 'writable') throw new Error('Relay stream is closed')
    if (data.byteLength === 0) return true
    if (
      this.writeBufferLength + data.byteLength > sendQueueBytes ||
      countChunks(this.writeBuffer) >= queueItems
    ) {
      const error = new RelayProtocolError('Relay send queue limit exceeded')
      this.finish('RESOURCE_EXHAUSTED', error)
      throw error
    }
    // The caller may reuse its buffer immediately after send(). Retain only this bounded copy.
    const copy = new Uint8Array(data.byteLength)
    if (data instanceof Uint8Array) copy.set(data)
    else {
      let offset = 0
      for (const chunk of data) {
        copy.set(chunk, offset)
        offset += chunk.byteLength
      }
    }
    const writable = super.send(copy)
    this.schedule()
    return writable
  }

  override sendData(data: Parameters<AbstractMessageStream['sendData']>[0]) {
    if (this.finished) throw new Error('Relay stream is closed')
    const remaining = this.limits.windowBytes - Number(this.sentBytes - this.ackedBytes)
    const size = Math.min(data.byteLength, this.limits.maxFrameBytes, remaining)
    if (size === 0 || this.inFlight.size >= this.limits.maxInFlightFrames) {
      this.schedule()
      return { sentBytes: 0, canSendMore: false }
    }
    if (this.sentSeq === maxUint64 || this.sentBytes + BigInt(size) > maxUint64) {
      throw new RelayProtocolError('Relay counters exhausted')
    }
    const seq = this.sentSeq + 1n
    const cumulativeBytes = this.sentBytes + BigInt(size)
    const frame = encodeFrame({ type: 'data', seq, cumulativeBytes, payload: data.subarray(0, size) })
    if (!this.writeFrame(frame)) {
      this.schedule()
      return { sentBytes: 0, canSendMore: false }
    }
    this.sentSeq = seq
    this.sentBytes = cumulativeBytes
    this.inFlight.set(seq, cumulativeBytes)
    this.sendDeadline ??= performance.now() + this.stallMs
    this.schedule()
    return {
      sentBytes: size,
      canSendMore:
        size === data.byteLength &&
        this.inFlight.size < this.limits.maxInFlightFrames &&
        this.sentBytes - this.ackedBytes < BigInt(this.limits.windowBytes) &&
        this.socket.bufferedAmount === 0,
    }
  }

  private writeFrame(bytes: Uint8Array<ArrayBuffer>): boolean {
    const buffered = this.observeSocketBuffer()
    if (buffered + bytes.byteLength > queueBytes) return false
    if (this.socket.readyState !== 1 || this.socket.send(bytes) === 0) {
      throw new Error('Relay socket rejected a frame')
    }
    this.observeSocketBuffer()
    // In particular, a -1 result is already enqueued. Never send this frame a second time.
    return true
  }

  private observeSocketBuffer(): number {
    const buffered = this.socket.bufferedAmount
    if (!Number.isSafeInteger(buffered) || buffered < 0 || buffered > queueBytes) {
      throw new RelayProtocolError('Invalid or excessive socket buffer')
    }
    if (buffered === 0) this.socketBlockedAt = undefined
    else if (this.socketBlockedAt === undefined || buffered < this.lastSocketBuffered) {
      this.socketBlockedAt = performance.now()
    }
    this.lastSocketBuffered = buffered
    return buffered
  }

  private readonly receive = (event: { data: unknown }): void => {
    if (this.finished) return
    try {
      const data = event.data
      const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : data
      if (!(bytes instanceof Uint8Array)) throw new RelayProtocolError('Expected a binary relay frame')
      const frame = decodeFrame(bytes)
      if (frame.type === 'data') this.receiveData(frame)
      else if (frame.type === 'ack') this.receiveAck(frame)
      else {
        const error = frame.reason === 'NORMAL' ? undefined : new Error(`Relay closed: ${frame.reason}`)
        this.finish(frame.reason, error, false)
      }
    } catch (error) {
      this.finish('PROTOCOL_ERROR', error instanceof Error ? error : new Error('Invalid relay message'))
    }
  }

  private receiveData(frame: DataFrame): void {
    if (
      frame.seq !== this.receivedSeq + 1n ||
      frame.cumulativeBytes !== this.receivedBytes + BigInt(frame.payload.byteLength) ||
      frame.payload.byteLength > this.limits.maxFrameBytes ||
      frame.seq - this.receiptSeq > BigInt(this.limits.maxInFlightFrames) ||
      frame.cumulativeBytes - this.receiptBytes > BigInt(this.limits.windowBytes)
    ) {
      throw new RelayProtocolError('DATA sequence, size or receive credit violation')
    }
    if (
      this.readBufferLength + frame.payload.byteLength > queueBytes ||
      countChunks(this.readBuffer) >= queueItems
    ) {
      throw new RelayProtocolError('Relay receive queue limit exceeded')
    }
    this.receivedSeq = frame.seq
    this.receivedBytes = frame.cumulativeBytes
    this.onData(Uint8Array.from(frame.payload))
    this.schedule()
  }

  private receiveAck(frame: AckFrame): void {
    if (frame.seq === this.ackedSeq && frame.cumulativeBytes === this.ackedBytes) return
    if (frame.seq <= this.ackedSeq || this.inFlight.get(frame.seq) !== frame.cumulativeBytes) {
      throw new RelayProtocolError('ACK does not match a sent frame boundary')
    }
    this.ackedSeq = frame.seq
    this.ackedBytes = frame.cumulativeBytes
    for (const seq of this.inFlight.keys()) {
      if (seq > frame.seq) break
      this.inFlight.delete(seq)
    }
    this.sendDeadline = this.inFlight.size ? performance.now() + this.stallMs : undefined
    if (this.canWrite()) this.onMuxerDrain()
    this.schedule()
    this.maybeClose()
  }

  private canAcknowledge(): boolean {
    // Reserve room for an entire new window before returning credit, including tiny-frame metadata.
    return (
      this.readBufferLength + this.limits.windowBytes <= queueBytes &&
      countChunks(this.readBuffer) + this.limits.maxInFlightFrames <= queueItems
    )
  }

  private acknowledge(): void {
    if (this.finished || this.receivedSeq === this.receiptSeq || !this.canAcknowledge()) return
    if (
      this.writeFrame(
        encodeFrame({ type: 'ack', seq: this.receivedSeq, cumulativeBytes: this.receivedBytes }),
      )
    ) {
      this.receiptSeq = this.receivedSeq
      this.receiptBytes = this.receivedBytes
    }
  }

  protected override dispatchReadBuffer(): void {
    super.dispatchReadBuffer()
    if (this.finished || this.socket === undefined) return
    try {
      this.acknowledge()
    } catch (error) {
      this.abort(error instanceof Error ? error : new Error('Relay ACK failed'))
    }
  }

  override sendPause(): void {}
  override sendResume(): void {
    this.acknowledge()
    this.schedule()
  }
  override sendReset(error: Error): void {
    if (!this.finished) this.finish('PROTOCOL_ERROR', error)
  }
  override abort(error: Error): void {
    this.finish('PROTOCOL_ERROR', error)
  }

  private canWrite(): boolean {
    return (
      this.inFlight.size < this.limits.maxInFlightFrames &&
      this.sentBytes - this.ackedBytes < BigInt(this.limits.windowBytes) &&
      this.socket.bufferedAmount < queueBytes / 2
    )
  }

  // Each backpressure cycle needs a fresh wait; do not reuse an already resolved drain promise.
  override onDrain(options?: AbortOptions): Promise<void> {
    if (this.finished) return Promise.reject(this.failure ?? new Error('Relay stream is closed'))
    const signal = options?.signal
    if (signal?.aborted) return Promise.reject(signal.reason)
    if (!this.writableNeedsDrain) return Promise.resolve()
    return new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        this.removeEventListener('drain', drained)
        this.removeEventListener('close', closed)
        signal?.removeEventListener('abort', cancelled)
      }
      const drained = () => {
        cleanup()
        resolve()
      }
      const closed = () => {
        cleanup()
        reject(this.failure ?? new Error('Relay stream is closed'))
      }
      const cancelled = () => {
        cleanup()
        reject(signal?.reason)
      }
      this.addEventListener('drain', drained)
      this.addEventListener('close', closed)
      signal?.addEventListener('abort', cancelled, { once: true })
    })
  }

  private schedule(): void {
    if (this.timer !== undefined || this.finished) return
    const work =
      this.inFlight.size > 0 ||
      this.writeBufferLength > 0 ||
      this.socket.bufferedAmount > 0 ||
      (this.receivedSeq !== this.receiptSeq && this.canAcknowledge())
    if (!work) return
    this.timer = setTimeout(this.tick, Math.max(1, Math.min(25, this.stallMs / 4)))
  }

  private readonly tick = (): void => {
    this.timer = undefined
    if (this.finished) return
    try {
      this.observeSocketBuffer()
      const now = performance.now()
      if (
        (this.sendDeadline !== undefined && now >= this.sendDeadline) ||
        (this.socketBlockedAt !== undefined && now - this.socketBlockedAt >= this.stallMs)
      ) {
        this.finish('STALLED', new Error('Relay stream stalled'))
        return
      }
      this.acknowledge()
      if (this.canWrite()) this.onMuxerDrain()
      this.maybeClose()
      this.schedule()
    } catch (error) {
      this.abort(error instanceof Error ? error : new Error('Relay drain failed'))
    }
  }

  override close(options?: AbortOptions): Promise<void> {
    if (this.closePromise) return this.closePromise
    if (this.finished) return this.failure ? Promise.reject(this.failure) : Promise.resolve()
    if (options?.signal?.aborted) {
      this.cancel()
      return Promise.reject(this.failure)
    }
    this.writeStatus = 'closing'
    const signal = options?.signal
    signal?.addEventListener('abort', this.cancel, { once: true })
    this.closePromise = new Promise<void>((resolve, reject) => {
      this.resolveClose = resolve
      this.rejectClose = reject
    }).finally(() => signal?.removeEventListener('abort', this.cancel))
    this.maybeClose()
    this.schedule()
    return this.closePromise
  }

  private maybeClose(): void {
    if (
      this.writeStatus === 'closing' &&
      this.writeBufferLength === 0 &&
      this.inFlight.size === 0 &&
      this.socket.bufferedAmount === 0
    ) {
      this.finish('NORMAL')
    }
  }

  private readonly cancel = (): void => this.finish('CANCELLED', new Error('Relay connection cancelled'))
  private readonly socketFailed = (): void =>
    this.finish('RELAY_UNAVAILABLE', new Error('Relay socket failed'), false)
  private readonly socketClosed = (): void =>
    this.finish('RELAY_UNAVAILABLE', new Error('Relay socket closed'), false)

  private finish(reason: CloseReason, error?: Error, notify = true): void {
    if (this.finished) return
    this.finished = true
    // A peer's normal close cannot silently discard this endpoint's outstanding writes.
    if (!error && (this.writeBufferLength > 0 || this.inFlight.size > 0)) {
      error = new Error('Relay closed with unacknowledged writes')
    }
    this.failure = error
    clearTimeout(this.timer)
    this.timer = undefined
    this.signal?.removeEventListener('abort', this.cancel)
    this.socket.removeEventListener('message', this.receive)
    this.socket.removeEventListener('close', this.socketClosed)
    this.socket.removeEventListener('error', this.socketFailed)
    if (notify) {
      try {
        this.writeFrame(encodeFrame({ type: 'close', reason }))
      } catch {
        // Closing the underlying socket is the final fallback; never retry opaque data.
      }
    }
    this.inFlight.clear()
    if (error) super.abort(error)
    else super.onTransportClosed()
    try {
      this.socket.close(error ? 1008 : 1000, 'Relay stream closed')
    } catch {
      // The transport may already be gone. Local teardown and waiters still settle exactly once.
    } finally {
      if (error) this.rejectClose?.(error)
      else this.resolveClose?.()
      this.resolveClose = undefined
      this.rejectClose = undefined
    }
  }

  /** Pause between pulls; the base class iterator otherwise queues message events without a bound. */
  override async *[Symbol.asyncIterator](): AsyncGenerator<StreamData> {
    if (this.iterating) throw new Error('Relay stream already has an iterator')
    this.iterating = true
    let next: ((data: StreamData | undefined) => void) | undefined
    let closed = this.finished
    const onMessage = (event: { data: StreamData }) => {
      this.pause()
      next?.(event.data)
      next = undefined
    }
    const onClose = () => {
      closed = true
      next?.(undefined)
      next = undefined
    }
    try {
      if (this.readStatus === 'readable') this.pause()
      this.addEventListener('message', onMessage)
      this.addEventListener('close', onClose)
      while (!closed || this.readBufferLength > 0) {
        const pending = new Promise<StreamData | undefined>((resolve) => {
          next = resolve
        })
        if (this.readStatus === 'paused') this.resume()
        const value = await pending
        if (value === undefined) break
        yield value
      }
      if (this.failure) throw this.failure
    } finally {
      this.removeEventListener('message', onMessage)
      this.removeEventListener('close', onClose)
      this.iterating = false
      if (!this.finished) this.cancel()
    }
  }
}
