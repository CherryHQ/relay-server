import { createHash, randomBytes } from 'node:crypto'
import { serialize } from 'node:v8'

import {
  type ClientControl,
  parseRelayProbe,
  parseServerControl,
  type RelayOffer,
  type ServerControl,
} from '@cherrystudio/relay-protocol'

import type { DiagnosticFields } from '../../src/cloudflare/diagnostics.js'
import { DurableRelayRuntime } from '../../src/cloudflare/runtime.js'
import type { DurableSocket } from '../../src/cloudflare/sender.js'
import type { RuntimeConfig } from '../../src/config.js'

export class MemorySocket implements DurableSocket {
  readyState = 1
  readonly inbox: (string | Uint8Array)[] = []
  attachment: unknown
  reason: string | undefined
  maxAttachmentBytes = 0
  send(data: string | Uint8Array) {
    this.inbox.push(typeof data === 'string' ? data : Uint8Array.from(data))
  }
  close(_code: number, reason: string) {
    this.readyState = 2
    this.reason = reason
  }
  serializeAttachment(value: unknown) {
    const size = serialize(value).byteLength
    if (size > 16_384) throw new Error('Attachment too large')
    this.maxAttachmentBytes = Math.max(this.maxAttachmentBytes, size)
    this.attachment = structuredClone(value)
  }
  deserializeAttachment() {
    return structuredClone(this.attachment)
  }
  control<T extends ServerControl['type']>(type: T): Extract<ServerControl, { type: T }> {
    const index = this.inbox.findIndex(
      (message) =>
        typeof message === 'string' && !parseRelayProbe(message) && parseServerControl(message).type === type,
    )
    const raw = this.inbox.splice(index, 1)[0]
    if (index < 0 || typeof raw !== 'string') throw new Error(`Missing ${type}; closed=${this.reason}`)
    return parseServerControl(raw) as Extract<ServerControl, { type: T }>
  }
}

export function durableFixture(config: Partial<RuntimeConfig> = {}) {
  let now = 1_000_000
  const sockets: MemorySocket[] = []
  const events: { event: string; fields: DiagnosticFields }[] = []
  const host = {
    now: () => now,
    sockets: () => sockets.filter((socket) => socket.readyState !== 3),
    randomHex: (bytes: number) => randomBytes(bytes).toString('hex'),
    sha256: async (text: string) => createHash('sha256').update(text).digest('hex'),
    log: (event: string, fields: DiagnosticFields) => events.push({ event, fields }),
  }
  let runtime = new DurableRelayRuntime(host, config)
  const send = async (socket: MemorySocket, message: ClientControl | Uint8Array | string) => {
    await runtime.message(
      socket,
      typeof message === 'string'
        ? message
        : message instanceof Uint8Array
          ? Uint8Array.from(message).buffer
          : JSON.stringify(message),
    )
    runtime.checkpoint()
  }
  const receipts = async (socket: MemorySocket) => {
    for (let i = 0; i < socket.inbox.length;) {
      const raw = socket.inbox[i]
      const probe = typeof raw === 'string' ? parseRelayProbe(raw) : undefined
      if (probe?.type === 'probe') {
        socket.inbox.splice(i, 1)
        await send(socket, JSON.stringify({ ...probe, type: 'probe_ack' }))
      } else i++
    }
  }
  const open = async (message?: ClientControl, autoReceipts = true) => {
    if (runtime.reserveUpgrade()) throw new Error('Upgrade rejected')
    const socket = new MemorySocket()
    sockets.push(socket)
    runtime.open(socket)
    runtime.checkpoint()
    if (autoReceipts) await receipts(socket)
    if (message) await send(socket, message)
    return socket
  }
  const listen = async (hostKey = randomBytes(32).toString('hex')) => {
    const socket = await open({ v: 1, type: 'listen', hostKey })
    return { socket, info: socket.control('listening'), hostKey }
  }
  const pending = async (host: Awaited<ReturnType<typeof listen>>) => {
    const app = await open({ v: 1, type: 'connect', targetId: host.info.targetId })
    app.control('pending')
    return { app, offer: host.socket.control('offer') }
  }
  const attach = async (offer: RelayOffer) => {
    return open({
      v: 1,
      type: 'attach',
      sessionId: offer.sessionId,
      ownerEpoch: offer.ownerEpoch,
      ticket: offer.ticket,
    })
  }
  const pair = async (host: Awaited<ReturnType<typeof listen>>) => {
    const { app, offer } = await pending(host)
    const desktop = await attach(offer)
    desktop.control('pending')
    const start = {
      v: 1 as const,
      type: 'start' as const,
      sessionId: offer.sessionId,
      ownerEpoch: offer.ownerEpoch,
    }
    await send(app, start)
    await send(desktop, start)
    app.control('ready')
    desktop.control('ready')
    return { app, desktop, offer }
  }
  return {
    host,
    get runtime() {
      return runtime
    },
    sockets,
    events,
    send,
    receipts,
    open,
    listen,
    pending,
    attach,
    pair,
    hibernate() {
      runtime.checkpoint()
      runtime = new DurableRelayRuntime(host, config)
    },
    advance(ms: number) {
      now += ms
      runtime.tick()
      runtime.checkpoint()
    },
    close(socket: MemorySocket) {
      socket.readyState = 3
      runtime.closed(socket)
      runtime.checkpoint()
    },
  }
}
