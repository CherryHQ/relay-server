import type { CloseReason } from '@cherrystudio/relay-protocol'

export interface RelayPeer {
  /** Accepted into a bounded queue. onSent runs only after the native transport accepts the message. */
  send(data: string | Uint8Array, onSent?: () => void): boolean
  close(reason: CloseReason): void
}

export interface NativeSender {
  readonly bufferedAmount: number
  /** Positive or -1 accepts exactly once; 0 drops a nonempty message. */
  send(data: string | Uint8Array): number
}
