import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

import {
  type ClientControl,
  type CloseReason,
  frameHeaderBytes,
  maxRendezvousBytes,
  parseClientControl,
  type RelayRole,
  rendezvousPath,
  type ServerControl,
  targetKeyDomain,
} from '@cherrystudio/relay-protocol'
import type { Server, ServerWebSocket, TLSOptions } from 'bun'

import { type RuntimeConfig, runtimeConfig } from '../config.js'
import { BufferBudget, BufferedSender, RateBudget } from '../core/forwarding.js'
import type { RelayPeer } from '../core/ports.js'
import { RelaySession } from '../core/session.js'

interface Target {
  readonly id: string
  listener: Connection | undefined
  readonly sessions: Set<SessionRecord>
}

interface SessionRecord {
  readonly target: Target
  readonly session: RelaySession
  ticket: string | undefined
}

type ConnectionState =
  | { kind: 'new' }
  | { kind: 'listener'; target: Target }
  | { kind: 'data'; record: SessionRecord; role: RelayRole }
  | { kind: 'closing' }

interface Connection {
  socket: ServerWebSocket<SocketData> | undefined
  sender: BufferedSender | undefined
  state: ConnectionState
  deadline: number
  readonly frames: RateBudget
  readonly bytes: RateBudget
}

interface SocketData {
  readonly connection: Connection
}

export interface BunRelayOptions {
  readonly hostname?: string
  readonly port?: number
  readonly tls?: TLSOptions
  readonly config?: Partial<RuntimeConfig>
}

export class BunRelayRuntime {
  readonly config: Readonly<RuntimeConfig>
  readonly ownerEpoch = randomBytes(16).toString('hex')
  readonly server: Server<SocketData>
  private readonly connections = new Set<Connection>()
  private readonly targets = new Map<string, Target>()
  private readonly sessions = new Map<string, SessionRecord>()
  private readonly bufferBudget: BufferBudget
  private readonly upgrades: RateBudget
  private readonly incomingBytes: RateBudget
  private readonly incomingFrames: RateBudget
  private readonly ticker: ReturnType<typeof setInterval>
  private draining = false
  private stopping: Promise<void> | undefined
  private onDrained: (() => void) | undefined
  private acceptedConnections = 0
  private rejectedConnections = 0
  private protocolErrors = 0
  private rateRejections = 0
  private sessionsCreated = 0
  private sessionsClosed = 0
  private receivedBytes = 0n
  private sentBinaryBytes = 0n

  constructor(options: BunRelayOptions = {}) {
    this.config = runtimeConfig(options.config)
    this.bufferBudget = new BufferBudget(this.config.maxTotalBufferBytes)
    const now = performance.now()
    this.upgrades = new RateBudget(this.config.connectionsPerSecond, now)
    this.incomingBytes = new RateBudget(this.config.totalBytesPerSecond, now)
    this.incomingFrames = new RateBudget(this.config.totalFramesPerSecond, now)
    this.server = Bun.serve<SocketData>({
      hostname: options.hostname ?? '127.0.0.1',
      port: options.port ?? 8787,
      ...(options.tls ? { tls: options.tls } : {}),
      maxRequestBodySize: maxRendezvousBytes,
      idleTimeout: 10,
      fetch: (request, server) => {
        const url = new URL(request.url)
        if (request.method !== 'GET') return new Response('Method not allowed', { status: 405 })
        if (url.search) return new Response('Query parameters are not accepted', { status: 400 })
        if (url.pathname === '/healthz') return Response.json({ status: 'ok' })
        if (url.pathname === '/readyz')
          return Response.json(
            { status: this.draining ? 'draining' : 'ready' },
            { status: this.draining ? 503 : 200 },
          )
        if (url.pathname !== rendezvousPath) return new Response('Not found', { status: 404 })
        if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket')
          return new Response('WebSocket required', { status: 426 })
        if (this.draining || this.connections.size >= this.config.maxConnections) {
          this.rejectedConnections++
          return new Response('Relay unavailable', { status: 503 })
        }
        const time = performance.now()
        if (!this.upgrades.take(1, time)) {
          this.rejectedConnections++
          return new Response('Connection rate exceeded', { status: 429 })
        }
        // Reserve before upgrade, not in open(): concurrent pending upgrades count toward the cap.
        const connection: Connection = {
          socket: undefined,
          sender: undefined,
          state: { kind: 'new' },
          deadline: time + this.config.handshakeMs,
          frames: new RateBudget(this.config.framesPerSecond, time),
          bytes: new RateBudget(this.config.bytesPerSecond, time),
        }
        this.connections.add(connection)
        if (server.upgrade(request, { data: { connection } })) {
          this.acceptedConnections++
          return
        }
        this.connections.delete(connection)
        return new Response('Upgrade failed', { status: 400 })
      },
      websocket: {
        perMessageDeflate: false,
        maxPayloadLength: Math.max(maxRendezvousBytes, this.config.limits.maxFrameBytes + frameHeaderBytes),
        backpressureLimit: this.config.maxSocketBufferBytes,
        closeOnBackpressureLimit: true,
        idleTimeout: 120,
        sendPings: true,
        open: (socket) => this.open(socket),
        message: (socket, message) => this.message(socket.data.connection, message),
        drain: (socket) => {
          const connection = socket.data.connection
          if (connection.state.kind !== 'closing' && !connection.sender?.drain())
            this.close(connection, 'RESOURCE_EXHAUSTED')
        },
        close: (socket) => {
          this.close(socket.data.connection, 'RELAY_UNAVAILABLE')
          this.forget(socket.data.connection)
        },
        error: (_error, socket) => {
          if (socket) this.close(socket.data.connection, 'RELAY_UNAVAILABLE')
        },
      },
    })
    this.ticker = setInterval(
      () => this.tick(),
      Math.max(
        1,
        Math.min(50, this.config.handshakeMs / 4, this.config.rendezvousMs / 4, this.config.stallMs / 4),
      ),
    )
    this.ticker.unref()
  }

  private open(socket: ServerWebSocket<SocketData>): void {
    const connection = socket.data.connection
    if (!this.connections.has(connection) || connection.state.kind !== 'new' || this.draining) {
      socket.terminate()
      this.forget(connection)
      return
    }
    connection.socket = socket
    connection.sender = new BufferedSender(
      {
        get bufferedAmount() {
          return socket.getBufferedAmount()
        },
        send: (data) => socket.send(data, false),
      },
      this.bufferBudget,
      this.config.maxSocketBufferBytes,
      this.config.maxQueueItems,
    )
  }

  private peer(connection: Connection): RelayPeer {
    return {
      send: (data, onSent) => {
        if (connection.state.kind === 'closing') return false
        const binaryBytes = typeof data === 'string' ? 0 : data.byteLength
        return (
          connection.sender?.send(data, () => {
            this.sentBinaryBytes += BigInt(binaryBytes)
            onSent?.()
          }) ?? false
        )
      },
      close: (reason) => this.close(connection, reason),
    }
  }

  private control(connection: Connection, message: ServerControl): boolean {
    if (this.peer(connection).send(JSON.stringify(message))) return true
    this.close(connection, 'RESOURCE_EXHAUSTED')
    return false
  }

  private message(connection: Connection, message: string | Uint8Array): void {
    if (connection.state.kind === 'closing') return
    const now = performance.now()
    const size = typeof message === 'string' ? Buffer.byteLength(message) : message.byteLength
    if (
      !connection.frames.take(1, now) ||
      !this.incomingFrames.take(1, now) ||
      !connection.bytes.take(size, now) ||
      !this.incomingBytes.take(size, now)
    ) {
      this.rateRejections++
      this.close(connection, 'RESOURCE_EXHAUSTED')
      return
    }
    this.receivedBytes += BigInt(size)
    try {
      if (typeof message !== 'string') {
        if (connection.state.kind !== 'data') throw new Error('Unexpected binary message')
        connection.state.record.session.receive(connection.state.role, message, now)
        return
      }
      const control = parseClientControl(message)
      if (connection.state.kind === 'new') {
        if (now >= connection.deadline || this.draining) {
          this.close(connection, 'CANCELLED')
          return
        }
        this.admit(connection, control, now)
      } else if (connection.state.kind === 'listener' && control.type === 'cancel') {
        const record = this.sessions.get(control.sessionId)
        // A remote close/expiry can win the race with the desktop's cancel message.
        if (!record) return
        if (record.target !== connection.state.target) throw new Error('Wrong target')
        record.session.close('CANCELLED')
      } else if (connection.state.kind === 'data' && control.type === 'start') {
        const { session } = connection.state.record
        if (control.sessionId !== session.selection.sessionId || control.ownerEpoch !== this.ownerEpoch)
          throw new Error('Wrong session')
        session.start(connection.state.role, now)
      } else throw new Error('Unexpected control message')
    } catch {
      this.protocolErrors++
      this.close(connection, 'PROTOCOL_ERROR')
    }
  }

  private admit(connection: Connection, message: ClientControl, now: number): void {
    if (message.type === 'listen') {
      const id = createHash('sha256').update(targetKeyDomain).update(message.hostKey).digest('hex')
      const existing = this.targets.get(id)
      if (existing?.listener) {
        this.close(connection, 'RESOURCE_EXHAUSTED', 'TARGET_BUSY')
        return
      }
      if (!existing && this.targets.size >= this.config.maxTargets) {
        this.close(connection, 'RESOURCE_EXHAUSTED')
        return
      }
      const target = existing ?? { id, listener: undefined, sessions: new Set<SessionRecord>() }
      target.listener = connection
      this.targets.set(id, target)
      connection.state = { kind: 'listener', target }
      this.control(connection, { v: 1, type: 'listening', targetId: id, ownerEpoch: this.ownerEpoch })
    } else if (message.type === 'connect') {
      const target = this.targets.get(message.targetId)
      if (!target?.listener) {
        this.close(connection, 'RELAY_UNAVAILABLE', 'TARGET_OFFLINE')
        return
      }
      if (
        this.sessions.size >= this.config.maxSessions ||
        target.sessions.size >= this.config.maxSessionsPerTarget
      ) {
        this.close(connection, 'RESOURCE_EXHAUSTED')
        return
      }
      const selection = {
        sessionId: randomBytes(16).toString('hex'),
        ownerEpoch: this.ownerEpoch,
        limits: this.config.limits,
      }
      const ticket = randomBytes(32).toString('hex')
      const session = new RelaySession(
        selection,
        now + this.config.rendezvousMs,
        this.peer(connection),
        this.config.stallMs,
        (reason) => this.sessionClosed(record, reason),
      )
      const record: SessionRecord = { target, session, ticket }
      this.sessions.set(selection.sessionId, record)
      target.sessions.add(record)
      this.sessionsCreated++
      connection.state = { kind: 'data', record, role: 'app' }
      if (
        !this.control(connection, {
          v: 1,
          type: 'pending',
          ...selection,
          expiresInMs: this.config.rendezvousMs,
        })
      )
        return
      this.control(target.listener, {
        v: 1,
        type: 'offer',
        ...selection,
        ticket,
        expiresInMs: this.config.rendezvousMs,
      })
    } else if (message.type === 'attach') {
      const record = this.sessions.get(message.sessionId)
      if (
        !record ||
        message.ownerEpoch !== this.ownerEpoch ||
        record.session.state !== 'waiting' ||
        now >= record.session.expiresAt ||
        !record.ticket ||
        !timingSafeEqual(Buffer.from(message.ticket), Buffer.from(record.ticket))
      ) {
        this.close(connection, 'PROTOCOL_ERROR', 'INVALID_TICKET')
        return
      }
      record.ticket = undefined // Consume atomically before accepting this role, even if the next send fails.
      record.session.attach(this.peer(connection), now)
      connection.state = { kind: 'data', record, role: 'desktop' }
      this.control(connection, {
        v: 1,
        type: 'pending',
        ...record.session.selection,
        expiresInMs: Math.max(1, Math.ceil(record.session.expiresAt - now)),
      })
    } else throw new Error('Expected initial rendezvous message')
  }

  private sessionClosed(record: SessionRecord, reason: CloseReason): void {
    const id = record.session.selection.sessionId
    if (this.sessions.get(id) !== record) return
    this.sessions.delete(id)
    record.ticket = undefined
    record.target.sessions.delete(record)
    this.sessionsClosed++
    if (record.target.listener)
      this.control(record.target.listener, { v: 1, type: 'session_closed', sessionId: id, reason })
    this.dropTarget(record.target)
    if (this.sessions.size === 0) this.onDrained?.()
  }

  private dropTarget(target: Target): void {
    if (!target.listener && !target.sessions.size && this.targets.get(target.id) === target)
      this.targets.delete(target.id)
  }

  private close(connection: Connection, reason: CloseReason, detail: string = reason): void {
    if (connection.state.kind === 'closing') return
    const previous = connection.state
    connection.state = { kind: 'closing' }
    connection.deadline = performance.now() + this.config.closeGraceMs
    if (previous.kind === 'data') previous.record.session.close(reason)
    else if (previous.kind === 'listener') {
      const target = previous.target
      if (target.listener === connection) target.listener = undefined
      // Already-ready streams survive loss of the rendezvous listener; only incomplete offers end.
      for (const record of target.sessions)
        if (record.session.state === 'waiting') record.session.close('RELAY_UNAVAILABLE')
      this.dropTarget(target)
    }
    connection.sender?.discardQueue()
    if (!connection.socket) {
      this.forget(connection)
      return
    }
    connection.socket.close(reason === 'NORMAL' ? 1000 : reason === 'PROTOCOL_ERROR' ? 1002 : 1008, detail)
  }

  private forget(connection: Connection): void {
    if (!this.connections.delete(connection)) return
    connection.sender?.dispose()
    connection.socket = undefined
    connection.sender = undefined
  }

  private tick(): void {
    const now = performance.now()
    for (const connection of this.connections) {
      if (connection.state.kind === 'closing') {
        if (now >= connection.deadline) {
          connection.socket?.terminate()
          this.forget(connection)
        }
      } else if (connection.state.kind === 'new' && now >= connection.deadline)
        this.close(connection, 'CANCELLED')
      else if (connection.sender && !connection.sender.healthy(now, this.config.stallMs))
        this.close(connection, 'STALLED')
    }
    for (const { session } of this.sessions.values()) session.tick(now)
  }

  getStats() {
    let pendingSessions = 0
    let queuedBytes = 0
    let nativeBytes = 0
    for (const { session } of this.sessions.values()) if (session.state === 'waiting') pendingSessions++
    for (const connection of this.connections) {
      const stats = connection.sender?.stats
      queuedBytes += stats?.queuedBytes ?? 0
      nativeBytes += stats?.nativeBytes ?? 0
    }
    return {
      draining: this.draining,
      connections: this.connections.size,
      targets: this.targets.size,
      pendingSessions,
      activeSessions: this.sessions.size - pendingSessions,
      bufferBytes: this.bufferBudget.used,
      queuedBytes,
      nativeBytes,
      acceptedConnections: this.acceptedConnections,
      rejectedConnections: this.rejectedConnections,
      sessionsCreated: this.sessionsCreated,
      sessionsClosed: this.sessionsClosed,
      protocolErrors: this.protocolErrors,
      rateRejections: this.rateRejections,
      receivedBytes: this.receivedBytes.toString(),
      sentBinaryBytes: this.sentBinaryBytes.toString(),
    }
  }

  beginDrain(): void {
    if (this.draining) return
    this.draining = true
    for (const connection of this.connections) {
      if (connection.state.kind !== 'data' || connection.state.record.session.state !== 'ready')
        this.close(connection, 'RELAY_UNAVAILABLE')
    }
  }

  stop(graceMs = this.config.drainMs): Promise<void> {
    if (this.stopping) return this.stopping
    if (!Number.isSafeInteger(graceMs) || graceMs < 0) throw new Error('Invalid drain deadline')
    this.beginDrain()
    this.stopping = (async () => {
      if (this.sessions.size && graceMs > 0) {
        let timer: ReturnType<typeof setTimeout> | undefined
        await new Promise<void>((resolve) => {
          this.onDrained = resolve
          timer = setTimeout(resolve, graceMs)
        })
        clearTimeout(timer)
        this.onDrained = undefined
      }
      clearInterval(this.ticker)
      for (const connection of this.connections) {
        this.close(connection, 'RELAY_UNAVAILABLE')
        connection.socket?.terminate()
        this.forget(connection)
      }
      await this.server.stop(true)
    })()
    return this.stopping
  }
}
