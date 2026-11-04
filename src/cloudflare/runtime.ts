import {
  type ClientControl,
  type CloseReason,
  frameHeaderBytes,
  maxRendezvousBytes,
  parseClientControl,
  parseRelayProbe,
  type RelayRole,
  type ServerControl,
  targetKeyDomain,
} from '@cherrystudio/relay-protocol'

import type { RuntimeConfig } from '../config.js'
import { BufferBudget, RateBudget, type RateSnapshot } from '../core/forwarding.js'
import type { RelayPeer } from '../core/ports.js'
import { RelaySession, type SessionSnapshot } from '../core/session.js'
import { cloudflareConfig } from './config.js'
import { type DurableSocket, ReceiptSender, type ReceiptSnapshot } from './sender.js'

export interface DurableHost {
  sockets(): DurableSocket[]
  now(): number
  randomHex(bytes: number): string
  sha256(text: string): Promise<string>
}

interface SessionRecord {
  readonly target: Target
  readonly app: Connection
  desktop: Connection | undefined
  readonly session: RelaySession
  ticket: string | undefined
}
interface Target {
  readonly id: string
  listener: Connection | undefined
  readonly sessions: Set<SessionRecord>
}
type State =
  | { kind: 'new'; deadline: number }
  | { kind: 'listener'; target: Target }
  | { kind: 'data'; role: RelayRole; record: SessionRecord }
  | { kind: 'closing' }
interface Connection {
  readonly id: string
  readonly socket: DurableSocket
  readonly sender: ReceiptSender
  readonly frames: RateBudget
  readonly bytes: RateBudget
  state: State
  admitting: boolean
}

type StoredState =
  | { kind: 'new'; deadline: number }
  | { kind: 'listener'; targetId: string }
  | { kind: 'app'; targetId: string; session: SessionSnapshot; ticket: string | undefined }
  | { kind: 'desktop'; sessionId: string }
  | { kind: 'closing' }
interface Attachment {
  readonly v: 1
  readonly id: string
  readonly ownerEpoch: string
  readonly state: StoredState
  readonly sender: ReceiptSnapshot
  readonly frames: RateSnapshot
  readonly bytes: RateSnapshot
}

/** One deployment, one owner, many targets and sessions. All resumable state follows live sockets.
 * No database rows, payload copies, periodic timers, account lookups, or outbound WebSockets. */
export class DurableRelayRuntime {
  readonly config: Readonly<RuntimeConfig>
  ownerEpoch: string
  private readonly connections = new Map<DurableSocket, Connection>()
  private readonly targets = new Map<string, Target>()
  private readonly sessions = new Map<string, SessionRecord>()
  private readonly dirty = new Set<Connection>()
  private readonly budget: BufferBudget
  private readonly upgrades: RateBudget
  private readonly frames: RateBudget
  private readonly bytes: RateBudget
  private recoveryFailed = false

  constructor(
    private readonly host: DurableHost,
    overrides: Partial<RuntimeConfig> = {},
  ) {
    this.config = cloudflareConfig(overrides)
    this.ownerEpoch = host.randomHex(16)
    this.budget = new BufferBudget(this.config.maxTotalBufferBytes)
    const now = host.now()
    this.upgrades = new RateBudget(this.config.connectionsPerSecond, now)
    this.frames = new RateBudget(this.config.totalFramesPerSecond, now)
    this.bytes = new RateBudget(this.config.totalBytesPerSecond, now)
    try {
      this.restore()
    } catch {
      // An incompatible/corrupt snapshot cannot safely resume an encrypted byte stream.
      this.recoveryFailed = true
      for (const socket of host.sockets()) socket.close(1012, 'RELAY_UNAVAILABLE')
      this.connections.clear()
      this.targets.clear()
      this.sessions.clear()
      this.dirty.clear()
    }
  }

  private target(id: string): Target {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('Invalid target snapshot')
    const existing = this.targets.get(id)
    if (existing) return existing
    if (this.targets.size >= this.config.maxTargets) throw new Error('Target limit exceeded')
    const target: Target = { id, listener: undefined, sessions: new Set() }
    this.targets.set(id, target)
    return target
  }

  private connection(socket: DurableSocket, saved?: Attachment): Connection {
    const now = this.host.now()
    const connection: Connection = {
      id: saved?.id ?? this.host.randomHex(16),
      socket,
      frames: saved
        ? RateBudget.restore(this.config.framesPerSecond, saved.frames)
        : new RateBudget(this.config.framesPerSecond, now),
      bytes: saved
        ? RateBudget.restore(this.config.bytesPerSecond, saved.bytes)
        : new RateBudget(this.config.bytesPerSecond, now),
      state: { kind: 'new', deadline: now + this.config.handshakeMs },
      admitting: false,
      sender: new ReceiptSender(
        socket,
        this.budget,
        this.config.maxSocketBufferBytes,
        this.config.maxQueueItems,
        this.config.stallMs,
        () => this.host.now(),
        () => this.host.randomHex(16),
        () => this.dirty.add(connection),
        saved?.sender,
      ),
    }
    this.connections.set(socket, connection)
    return connection
  }

  private restore(): void {
    const sockets = this.host.sockets().filter((socket) => socket.readyState !== 3)
    if (sockets.length > this.config.maxConnections) throw new Error('Connection limit exceeded')
    const pending: { connection: Connection; state: StoredState }[] = []
    const ids = new Set<string>()
    for (const socket of sockets) {
      const saved = socket.deserializeAttachment() as Attachment | undefined
      if (
        saved?.v !== 1 ||
        !/^[a-f0-9]{32}$/.test(saved.id) ||
        !/^[a-f0-9]{32}$/.test(saved.ownerEpoch) ||
        ids.has(saved.id)
      )
        throw new Error('Invalid socket attachment')
      if (!pending.length) this.ownerEpoch = saved.ownerEpoch
      if (this.ownerEpoch !== saved.ownerEpoch) throw new Error('Mixed owner epochs')
      ids.add(saved.id)
      const connection = this.connection(socket, saved)
      pending.push({ connection, state: saved.state })
    }
    // Rebuild listeners and indexes before restoring the authoritative session on its App socket.
    const desktops = new Map<string, Connection>()
    for (const { connection, state } of pending) {
      switch (state.kind) {
        case 'new':
          if (!Number.isFinite(state.deadline)) throw new Error('Invalid handshake deadline')
          connection.state = state
          break
        case 'closing':
          connection.state = state
          break
        case 'listener': {
          const target = this.target(state.targetId)
          if (target.listener) throw new Error('Duplicate listener')
          target.listener = connection
          connection.state = { kind: 'listener', target }
          break
        }
        case 'desktop':
          if (desktops.has(state.sessionId)) throw new Error('Duplicate desktop role')
          desktops.set(state.sessionId, connection)
          break
        case 'app':
          break
        default:
          throw new Error('Unknown socket state')
      }
    }
    for (const { connection: app, state } of pending) {
      if (state.kind !== 'app') continue
      const saved = state.session
      const id = saved.selection.sessionId
      const desktop = desktops.get(id)
      desktops.delete(id)
      const target = this.target(state.targetId)
      if (saved.hasDesktop !== Boolean(desktop)) {
        // A close may have reached the platform immediately before eviction.
        this.close(app, 'RELAY_UNAVAILABLE')
        if (desktop) this.close(desktop, 'RELAY_UNAVAILABLE')
        if (target.listener)
          this.control(target.listener, {
            v: 1,
            type: 'session_closed',
            sessionId: id,
            reason: 'RELAY_UNAVAILABLE',
          })
        continue
      }
      if (
        saved.selection.ownerEpoch !== this.ownerEpoch ||
        this.sessions.has(id) ||
        this.sessions.size >= this.config.maxSessions ||
        target.sessions.size >= this.config.maxSessionsPerTarget ||
        saved.selection.limits.maxInFlightFrames > 64 ||
        (desktop ? state.ticket !== undefined : !state.ticket || !/^[a-f0-9]{64}$/.test(state.ticket))
      ) {
        throw new Error('Invalid session ownership snapshot')
      }
      const session = RelaySession.restore(
        saved,
        this.peer(app),
        desktop ? this.peer(desktop) : undefined,
        this.config.stallMs,
        (reason) => this.sessionClosed(record, reason),
      )
      const record: SessionRecord = { target, app, desktop, session, ticket: state.ticket }
      this.sessions.set(id, record)
      target.sessions.add(record)
      app.state = { kind: 'data', record, role: 'app' }
      if (desktop) desktop.state = { kind: 'data', record, role: 'desktop' }
    }
    for (const connection of desktops.values()) this.close(connection, 'RELAY_UNAVAILABLE')
    for (const record of this.sessions.values()) {
      if (!record.target.listener && record.session.state === 'waiting')
        record.session.close('RELAY_UNAVAILABLE')
    }
    for (const target of this.targets.values()) this.dropTarget(target)
    this.tick()
    this.checkpoint()
  }

  reserveUpgrade(): 429 | 503 | undefined {
    this.tick()
    if (this.recoveryFailed || this.connections.size >= this.config.maxConnections) return 503
    if (!this.upgrades.take(1, this.host.now())) return 429
    return undefined
  }

  open(socket: DurableSocket): void {
    const connection = this.connection(socket)
    this.dirty.add(connection)
    if (!connection.sender.challenge()) this.close(connection, 'RESOURCE_EXHAUSTED')
  }

  private peer(connection: Connection): RelayPeer {
    return {
      send: (data, onSent) => connection.state.kind !== 'closing' && connection.sender.send(data, onSent),
      close: (reason) => this.close(connection, reason),
    }
  }

  private control(connection: Connection, message: ServerControl): boolean {
    if (this.peer(connection).send(JSON.stringify(message))) return true
    this.close(connection, 'RESOURCE_EXHAUSTED')
    return false
  }

  async message(socket: DurableSocket, message: string | ArrayBuffer): Promise<void> {
    this.tick()
    const connection = this.connections.get(socket)
    if (!connection || connection.state.kind === 'closing') return
    this.dirty.add(connection)
    const now = this.host.now()
    const size =
      typeof message === 'string' ? new TextEncoder().encode(message).byteLength : message.byteLength
    if (
      size >
        (typeof message === 'string'
          ? maxRendezvousBytes
          : this.config.limits.maxFrameBytes + frameHeaderBytes) ||
      !connection.frames.take(1, now) ||
      !this.frames.take(1, now) ||
      !connection.bytes.take(size, now) ||
      !this.bytes.take(size, now)
    ) {
      this.close(connection, 'RESOURCE_EXHAUSTED')
      return
    }
    try {
      if (typeof message !== 'string') {
        if (connection.state.kind !== 'data') throw new Error('Unexpected DATA')
        const { record, role } = connection.state
        this.dirty.add(record.app)
        record.session.receive(role, new Uint8Array(message), now)
        return
      }
      const probe = parseRelayProbe(message)
      if (probe) {
        if (probe.type !== 'probe_ack') throw new Error('Unexpected transport challenge')
        if (!connection.sender.acknowledge(probe.nonce)) this.close(connection, 'RESOURCE_EXHAUSTED')
        return
      }
      // A transport receipt can arrive while listen's SHA-256 is pending. It does not compete
      // for the role; only overlapping rendezvous commands are rejected during admission.
      if (connection.admitting) throw new Error('Admission already in progress')
      const control = parseClientControl(message)
      if (connection.state.kind === 'new') {
        connection.admitting = true
        try {
          await this.admit(connection, control, now)
        } finally {
          connection.admitting = false
        }
      } else if (connection.state.kind === 'listener' && control.type === 'cancel') {
        const record = this.sessions.get(control.sessionId)
        if (!record) return
        if (record.target !== connection.state.target) throw new Error('Wrong target')
        record.session.close('CANCELLED')
      } else if (connection.state.kind === 'data' && control.type === 'start') {
        const { record, role } = connection.state
        if (
          record.session.selection.sessionId !== control.sessionId ||
          control.ownerEpoch !== this.ownerEpoch
        )
          throw new Error('Wrong session')
        this.dirty.add(record.app)
        record.session.start(role, now)
      } else throw new Error('Unexpected control message')
    } catch {
      this.close(connection, 'PROTOCOL_ERROR')
    }
  }

  private async admit(connection: Connection, message: ClientControl, now: number): Promise<void> {
    if (message.type === 'listen') {
      const id = await this.host.sha256(targetKeyDomain + message.hostKey)
      if (connection.state.kind !== 'new') return
      if (this.host.now() >= connection.state.deadline) {
        this.close(connection, 'CANCELLED')
        return
      }
      const existing = this.targets.get(id)
      if (existing?.listener) {
        this.close(connection, 'RESOURCE_EXHAUSTED', 'TARGET_BUSY')
        return
      }
      if (!existing && this.targets.size >= this.config.maxTargets) {
        this.close(connection, 'RESOURCE_EXHAUSTED')
        return
      }
      const target = this.target(id)
      target.listener = connection
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
        sessionId: this.host.randomHex(16),
        ownerEpoch: this.ownerEpoch,
        limits: this.config.limits,
      }
      const ticket = this.host.randomHex(32)
      const session = new RelaySession(
        selection,
        now + this.config.rendezvousMs,
        this.peer(connection),
        this.config.stallMs,
        (reason) => this.sessionClosed(record, reason),
      )
      const record: SessionRecord = { target, app: connection, desktop: undefined, session, ticket }
      this.sessions.set(selection.sessionId, record)
      target.sessions.add(record)
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
      if (
        !this.control(target.listener, {
          v: 1,
          type: 'offer',
          ...selection,
          ticket,
          expiresInMs: this.config.rendezvousMs,
        })
      ) {
        session.close('RELAY_UNAVAILABLE')
      }
    } else if (message.type === 'attach') {
      const record = this.sessions.get(message.sessionId)
      if (
        !record ||
        message.ownerEpoch !== this.ownerEpoch ||
        record.session.state !== 'waiting' ||
        now >= record.session.expiresAt ||
        !record.ticket ||
        !equalTicket(message.ticket, record.ticket)
      ) {
        this.close(connection, 'PROTOCOL_ERROR', 'INVALID_TICKET')
        return
      }
      record.ticket = undefined
      record.desktop = connection
      this.dirty.add(record.app)
      record.session.attach(this.peer(connection), now)
      connection.state = { kind: 'data', record, role: 'desktop' }
      this.control(connection, {
        v: 1,
        type: 'pending',
        ...record.session.selection,
        expiresInMs: Math.max(1, Math.ceil(record.session.expiresAt - now)),
      })
    } else throw new Error('Expected admission')
  }

  private sessionClosed(record: SessionRecord, reason: CloseReason): void {
    const id = record.session.selection.sessionId
    if (this.sessions.get(id) !== record) return
    this.sessions.delete(id)
    record.ticket = undefined
    record.target.sessions.delete(record)
    if (record.target.listener)
      this.control(record.target.listener, { v: 1, type: 'session_closed', sessionId: id, reason })
    this.dropTarget(record.target)
  }

  private dropTarget(target: Target): void {
    if (!target.listener && !target.sessions.size) this.targets.delete(target.id)
  }

  private close(connection: Connection, reason: CloseReason, detail: string = reason): void {
    if (connection.state.kind === 'closing') return
    const previous = connection.state
    connection.state = { kind: 'closing' }
    this.dirty.add(connection)
    if (previous.kind === 'data') previous.record.session.close(reason)
    else if (previous.kind === 'listener') {
      const target = previous.target
      if (target.listener === connection) target.listener = undefined
      for (const record of target.sessions)
        if (record.session.state === 'waiting') record.session.close('RELAY_UNAVAILABLE')
      this.dropTarget(target)
    }
    if (connection.socket.readyState !== 3)
      connection.socket.close(reason === 'NORMAL' ? 1000 : reason === 'PROTOCOL_ERROR' ? 1002 : 1008, detail)
    // Workers has no terminate(). Hold the reservation and connection slot until the native close.
  }

  closed(socket: DurableSocket): void {
    const connection = this.connections.get(socket)
    if (!connection) return
    this.close(connection, 'RELAY_UNAVAILABLE')
    // Called only by the platform's terminal close/error callback. Some error callbacks expose
    // CLOSING on the JS wrapper even though the underlying connection has already failed.
    this.forget(connection)
  }

  private forget(connection: Connection): void {
    connection.sender.dispose()
    this.connections.delete(connection.socket)
    this.dirty.delete(connection)
  }

  tick(): void {
    const now = this.host.now()
    const live = new Set(this.host.sockets())
    if (this.recoveryFailed && !live.size) {
      this.recoveryFailed = false
      this.budget.used = 0
      this.ownerEpoch = this.host.randomHex(16)
    }
    for (const connection of this.connections.values()) {
      if (connection.socket.readyState === 3 || !live.has(connection.socket)) {
        this.close(connection, 'RELAY_UNAVAILABLE')
        this.forget(connection)
      } else if (connection.state.kind !== 'closing') {
        if (connection.state.kind === 'new' && now >= connection.state.deadline)
          this.close(connection, 'CANCELLED')
        else if (connection.sender.nextDeadline !== undefined && now >= connection.sender.nextDeadline)
          this.close(connection, 'STALLED')
      }
    }
    for (const record of this.sessions.values()) record.session.tick(now)
  }

  get nextDeadline(): number | undefined {
    const deadlines: number[] = []
    for (const connection of this.connections.values()) {
      if (connection.state.kind === 'closing') continue
      if (connection.state.kind === 'new') deadlines.push(connection.state.deadline)
      if (connection.sender.nextDeadline !== undefined) deadlines.push(connection.sender.nextDeadline)
    }
    for (const record of this.sessions.values())
      if (record.session.nextDeadline !== undefined) deadlines.push(record.session.nextDeadline)
    return deadlines.length ? Math.min(...deadlines) : undefined
  }

  checkpoint(): void {
    for (const connection of this.dirty) {
      const current = connection.state
      let state: StoredState
      if (current.kind === 'listener') state = { kind: 'listener', targetId: current.target.id }
      else if (current.kind === 'data') {
        state =
          current.role === 'desktop'
            ? { kind: 'desktop', sessionId: current.record.session.selection.sessionId }
            : {
                kind: 'app',
                targetId: current.record.target.id,
                session: current.record.session.snapshot(),
                ticket: current.record.ticket,
              }
      } else state = current
      const attachment: Attachment = {
        v: 1,
        id: connection.id,
        ownerEpoch: this.ownerEpoch,
        state,
        sender: connection.sender.snapshot(),
        frames: connection.frames.snapshot(),
        bytes: connection.bytes.snapshot(),
      }
      connection.socket.serializeAttachment(attachment)
    }
    this.dirty.clear()
  }

  getStats() {
    return {
      connections: this.connections.size,
      targets: this.targets.size,
      sessions: this.sessions.size,
      bufferBytes: this.budget.used,
      recoveryFailed: this.recoveryFailed,
      nextDeadline: this.nextDeadline,
    }
  }
}

function equalTicket(a: string, b: string): boolean {
  if (a.length !== 64 || b.length !== 64) return false
  let difference = 0
  for (let i = 0; i < 64; i++) difference |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return difference === 0
}
