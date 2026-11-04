import { RelayProtocolError } from '@cherrystudio/relay-protocol'

import type { BufferBudget } from '../core/forwarding.js'

export interface ReceiptSnapshot {
  readonly sent: number
  readonly verified: number
  readonly items: number
  readonly verifiedItems: number
  readonly probe:
    | { readonly nonce: string; readonly end: number; readonly items: number; readonly deadline: number }
    | undefined
}

export interface DurableSocket {
  readonly readyState: number
  send(data: string | Uint8Array): void
  close(code: number, reason: string): void
  serializeAttachment(value: unknown): void
  deserializeAttachment(): unknown
}

/** Workers exposes neither bufferedAmount nor drain. A random receipt after FIFO output proves
 * that the receiver drained those bytes. Predictable DATA ACKs must never release this budget. */
export class ReceiptSender {
  private sent = 0
  private verified = 0
  private items = 0
  private verifiedItems = 0
  private probe: ReceiptSnapshot['probe']

  constructor(
    private readonly socket: DurableSocket,
    private readonly budget: BufferBudget,
    private readonly maxBytes: number,
    private readonly maxItems: number,
    private readonly stallMs: number,
    private readonly now: () => number,
    private readonly nonce: () => string,
    private readonly changed: () => void,
    state?: ReceiptSnapshot,
  ) {
    if (!state) return
    if (
      [state.sent, state.verified, state.items, state.verifiedItems].some(
        (n) => !Number.isSafeInteger(n) || n < 0,
      ) ||
      state.sent < state.verified ||
      state.sent - state.verified > maxBytes ||
      state.items < state.verifiedItems ||
      state.items - state.verifiedItems > maxItems ||
      (state.probe &&
        (!/^[a-f0-9]{32}$/.test(state.probe.nonce) ||
          !Number.isFinite(state.probe.deadline) ||
          state.probe.end <= state.verified ||
          state.probe.end > state.sent ||
          state.probe.items <= state.verifiedItems ||
          state.probe.items > state.items))
    ) {
      throw new RelayProtocolError('Invalid transport budget snapshot')
    }
    if (!budget.reserve(state.sent - state.verified))
      throw new RelayProtocolError('Transport budget exhausted')
    this.sent = state.sent
    this.verified = state.verified
    this.items = state.items
    this.verifiedItems = state.verifiedItems
    this.probe = state.probe
  }

  get pendingBytes(): number {
    return this.sent - this.verified
  }
  get nextDeadline(): number | undefined {
    return this.probe?.deadline
  }

  snapshot(): ReceiptSnapshot {
    return {
      sent: this.sent,
      verified: this.verified,
      items: this.items,
      verifiedItems: this.verifiedItems,
      probe: this.probe,
    }
  }

  private write(data: string | Uint8Array): boolean {
    if (this.socket.readyState !== 1) return false
    const cost = (typeof data === 'string' ? new TextEncoder().encode(data).byteLength : data.byteLength) + 10
    if (
      !Number.isSafeInteger(this.sent + cost) ||
      !Number.isSafeInteger(this.items + 1) ||
      this.pendingBytes + cost > this.maxBytes ||
      this.items - this.verifiedItems >= this.maxItems ||
      !this.budget.reserve(cost)
    )
      return false
    // Reserve before send; even a throwing native call must not free possibly enqueued bytes.
    this.sent += cost
    this.items++
    this.changed()
    try {
      this.socket.send(data)
      return true
    } catch {
      return false
    }
  }

  send(data: string | Uint8Array, onSent?: () => void): boolean {
    // Leave room for a probe even if DATA/ACK traffic fills the remainder of the budget.
    const cost = (typeof data === 'string' ? new TextEncoder().encode(data).byteLength : data.byteLength) + 10
    if (
      this.pendingBytes + cost > this.maxBytes - 128 ||
      this.items - this.verifiedItems >= this.maxItems - 1 ||
      !this.write(data)
    )
      return false
    onSent?.()
    if (
      !this.probe &&
      (this.pendingBytes >= Math.min(65_536, this.maxBytes / 2) ||
        this.items - this.verifiedItems >= Math.min(128, this.maxItems / 2))
    )
      return this.challenge()
    return true
  }

  /** The initial challenge also ensures an old client fails before accepting a long-lived session. */
  challenge(): boolean {
    if (this.probe) return true
    const nonce = this.nonce()
    if (!this.write(JSON.stringify({ v: 1, type: 'probe', nonce }))) return false
    this.probe = { nonce, end: this.sent, items: this.items, deadline: this.now() + this.stallMs }
    this.changed()
    return true
  }

  acknowledge(nonce: string): boolean {
    if (!this.probe || this.probe.nonce !== nonce || this.now() >= this.probe.deadline) {
      throw new RelayProtocolError('Unsolicited or expired transport receipt')
    }
    this.budget.adjust(-(this.probe.end - this.verified))
    this.verified = this.probe.end
    this.verifiedItems = this.probe.items
    this.probe = undefined
    this.changed()
    if (
      this.pendingBytes >= Math.min(65_536, this.maxBytes / 2) ||
      this.items - this.verifiedItems >= Math.min(128, this.maxItems / 2)
    )
      return this.challenge()
    return true
  }

  /** Release only after the platform reports CLOSED or no longer owns this socket. */
  dispose(): void {
    this.budget.adjust(-this.pendingBytes)
    this.verified = this.sent
    this.verifiedItems = this.items
    this.probe = undefined
  }
}
