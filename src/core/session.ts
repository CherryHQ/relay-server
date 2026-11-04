import {
  type CloseReason,
  decodeFrame,
  encodeFrame,
  parseRelayReady,
  RelayProtocolError,
  type RelayRole,
  type RelaySelection,
} from '@cherrystudio/relay-protocol'

import { ForwardingDirection, type ForwardingSnapshot } from './forwarding.js'
import type { RelayPeer } from './ports.js'

export interface SessionSnapshot {
  readonly state: 'waiting' | 'ready'
  readonly selection: RelaySelection
  readonly expiresAt: number
  readonly hasDesktop: boolean
  readonly started: readonly RelayRole[]
  readonly directions: Readonly<Record<RelayRole, ForwardingSnapshot>>
}

export class RelaySession {
  state: 'waiting' | 'ready' | 'closed' = 'waiting'
  private readonly peers: Partial<Record<RelayRole, RelayPeer>>
  private readonly started = new Set<RelayRole>()
  private readonly directions: Record<RelayRole, ForwardingDirection>

  private isClosed(): boolean {
    return this.state === 'closed'
  }

  constructor(
    readonly selection: RelaySelection,
    readonly expiresAt: number,
    app: RelayPeer,
    stallMs: number,
    private readonly onClose: (reason: CloseReason) => void,
  ) {
    this.peers = { app }
    this.directions = {
      app: new ForwardingDirection(selection.limits, stallMs),
      desktop: new ForwardingDirection(selection.limits, stallMs),
    }
  }

  attach(desktop: RelayPeer, now: number): void {
    if (this.state !== 'waiting' || this.peers.desktop || now >= this.expiresAt) {
      throw new RelayProtocolError('Session cannot be attached')
    }
    this.peers.desktop = desktop
  }

  start(role: RelayRole, now: number): void {
    if (this.state !== 'waiting' || !this.peers[role] || this.started.has(role) || now >= this.expiresAt) {
      throw new RelayProtocolError('Invalid start')
    }
    this.started.add(role)
    if (this.started.size !== 2) return
    // Both receivers are installed. Each peer's ready is queued before any DATA for that peer.
    this.state = 'ready'
    const ready = JSON.stringify({ v: 1, type: 'ready', ...this.selection })
    for (const peer of Object.values(this.peers)) {
      if (this.isClosed()) break
      if (!peer.send(ready)) this.close('RESOURCE_EXHAUSTED')
    }
  }

  receive(role: RelayRole, bytes: Uint8Array, now: number): void {
    if (this.state === 'closed') return
    if (this.state !== 'ready') throw new RelayProtocolError('DATA before ready')
    const other: RelayRole = role === 'app' ? 'desktop' : 'app'
    const peer = this.peers[other]
    if (!peer) throw new RelayProtocolError('Missing peer')
    const frame = decodeFrame(bytes)
    if (frame.type === 'close') {
      this.close(frame.reason)
    } else if (frame.type === 'data') {
      const direction = this.directions[role]
      direction.data(frame, now)
      const seq = frame.seq
      if (
        !peer.send(bytes, () => {
          if (this.state !== 'closed') direction.forwarded(seq)
        })
      ) {
        this.close('RESOURCE_EXHAUSTED')
      }
    } else if (this.directions[other].ack(frame, now) && !peer.send(bytes)) {
      this.close('RESOURCE_EXHAUSTED')
    }
  }

  tick(now: number): void {
    if (this.state === 'waiting' && now >= this.expiresAt) this.close('CANCELLED')
    else if (
      this.state === 'ready' &&
      Object.values(this.directions).some((direction) => direction.stalled(now))
    )
      this.close('STALLED')
  }

  get nextDeadline(): number | undefined {
    if (this.state === 'waiting') return this.expiresAt
    const deadlines = Object.values(this.directions).flatMap((direction) => direction.nextDeadline ?? [])
    return deadlines.length ? Math.min(...deadlines) : undefined
  }

  snapshot(): SessionSnapshot {
    if (this.state === 'closed') throw new RelayProtocolError('Cannot snapshot a closed session')
    return {
      state: this.state,
      selection: this.selection,
      expiresAt: this.expiresAt,
      hasDesktop: this.peers.desktop !== undefined,
      started: [...this.started],
      directions: { app: this.directions.app.snapshot(), desktop: this.directions.desktop.snapshot() },
    }
  }

  static restore(
    state: SessionSnapshot,
    app: RelayPeer,
    desktop: RelayPeer | undefined,
    stallMs: number,
    onClose: (reason: CloseReason) => void,
  ): RelaySession {
    const {
      v: _version,
      type: _type,
      ...selection
    } = parseRelayReady(
      JSON.stringify({
        v: 1,
        type: 'ready',
        ...state.selection,
      }),
    )
    if (
      !['waiting', 'ready'].includes(state.state) ||
      !Number.isFinite(state.expiresAt) ||
      state.hasDesktop !== Boolean(desktop) ||
      new Set(state.started).size !== state.started.length ||
      state.started.some((role) => role !== 'app' && role !== 'desktop') ||
      (state.started.includes('desktop') && !desktop) ||
      (state.state === 'ready') !== (state.started.length === 2)
    )
      throw new RelayProtocolError('Invalid session snapshot')
    const session = new RelaySession(selection, state.expiresAt, app, stallMs, onClose)
    if (desktop) session.peers.desktop = desktop
    for (const role of state.started) session.started.add(role)
    for (const role of ['app', 'desktop'] as const) {
      const direction = state.directions[role]
      if (state.state === 'waiting' && (direction.receivedSeq !== 0n || direction.ackedSeq !== 0n)) {
        throw new RelayProtocolError('Waiting session contains DATA')
      }
      session.directions[role] = ForwardingDirection.restore(selection.limits, stallMs, direction)
    }
    session.state = state.state
    return session
  }

  close(reason: CloseReason): void {
    if (this.state === 'closed') return
    const wasReady = this.state === 'ready'
    this.state = 'closed'
    for (const direction of Object.values(this.directions)) direction.clear()
    this.started.clear()
    if (wasReady)
      for (const peer of Object.values(this.peers)) peer.send(encodeFrame({ type: 'close', reason }))
    this.onClose(reason)
    for (const peer of Object.values(this.peers)) peer.close(reason)
    delete this.peers.app
    delete this.peers.desktop
  }
}
