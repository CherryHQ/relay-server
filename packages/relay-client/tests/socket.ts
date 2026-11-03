import type { RelaySocket } from '../src/ports.js'

/** A deliberately asynchronous socket: WebSocket message callbacks are never reentrant in send(). */
export class TestSocket implements RelaySocket {
  binaryType = 'arraybuffer'
  readyState = 1
  bufferedAmount = 0
  sendResult: undefined | number = undefined
  readonly sent: Uint8Array[] = []
  closes = 0
  peer: TestSocket | undefined
  private readonly listeners = new Map<string, Set<(event: { data: unknown }) => void>>()

  send(bytes: Uint8Array): undefined | number {
    if (this.readyState !== 1) throw new Error('Socket closed')
    if (this.sendResult === 0) return 0
    const copy = bytes.slice()
    this.sent.push(copy)
    queueMicrotask(() => this.peer?.inject(copy))
    return this.sendResult
  }

  close(): void {
    this.closes++
    if (this.readyState === 3) return
    this.readyState = 3
    this.emit('close', undefined)
  }

  addEventListener(type: string, listener: (event: { data: unknown }) => void): void {
    const listeners = this.listeners.get(type) ?? new Set()
    listeners.add(listener)
    this.listeners.set(type, listeners)
  }

  removeEventListener(type: string, listener: (event: { data: unknown }) => void): void {
    this.listeners.get(type)?.delete(listener)
  }

  get listenerCount(): number {
    return [...this.listeners.values()].reduce((total, listeners) => total + listeners.size, 0)
  }

  inject(data: unknown): void {
    this.emit('message', data)
  }

  private emit(type: string, data: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener({ data })
  }
}

export const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0))
