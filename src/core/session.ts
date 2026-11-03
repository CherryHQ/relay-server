import {
  type CloseReason,
  decodeFrame,
  encodeFrame,
  RelayProtocolError,
  type RelayRole,
  type RelaySelection,
} from '@cherrystudio/relay-protocol'

import { ForwardingDirection } from './forwarding.js'
import type { RelayPeer } from './ports.js'

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
