import type { ProofContext, ProofEnvelope } from '@cherrystudio/relay-protocol'

export interface RelaySocket {
  binaryType: string
  readonly readyState: number
  readonly bufferedAmount: number
  /** undefined/positive/-1 means accepted; 0 means a nonempty frame was dropped. */
  // biome-ignore lint/suspicious/noConfusingVoidType: Native browser WebSocket.send returns void; adapters may return a status.
  send(data: Uint8Array<ArrayBuffer>): void | number
  close(code?: number, reason?: string): void
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void
  addEventListener(type: 'close' | 'error', listener: () => void): void
  removeEventListener(type: 'message', listener: (event: { data: unknown }) => void): void
  removeEventListener(type: 'close' | 'error', listener: () => void): void
}

/** The factory must not follow redirects to another origin and must deliver events asynchronously. */
export interface RelayWebSocket extends RelaySocket {
  // biome-ignore lint/suspicious/noConfusingVoidType: Browser send returns void; adapters may report acceptance.
  send(data: string | Uint8Array<ArrayBuffer>): void | number
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void
  addEventListener(type: 'open' | 'close' | 'error', listener: () => void): void
  removeEventListener(type: 'message', listener: (event: { data: unknown }) => void): void
  removeEventListener(type: 'open' | 'close' | 'error', listener: () => void): void
}

export type RelaySocketFactory = (url: string) => RelayWebSocket

export interface ProofSigner {
  sha256(bytes: Uint8Array): Promise<Uint8Array>
  sign(transcript: Uint8Array): Promise<Uint8Array>
}

export interface SignedRelayRequest {
  readonly context: ProofContext
  readonly envelope: ProofEnvelope
}
