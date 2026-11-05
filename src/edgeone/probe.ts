import { randomBytes, timingSafeEqual } from 'node:crypto'

/** The Node Functions callback shape in Tencent's voice template and edgeone@1.6.47.
 * Agents support for this return value is deliberately what the probe must test. */
export interface ProbeSocket {
  readonly readyState: number
  readonly bufferedAmount: number
  send(data: string | Uint8Array): void
  close(code: number, reason: string): void
}

export interface ProbeUpgrade {
  websocket: {
    onopen(socket: ProbeSocket): void
    onmessage(socket: ProbeSocket, data: unknown, isBinary: boolean): void
    onclose(socket: ProbeSocket): void
    onerror(socket: ProbeSocket): void
  }
}

type Role = 'listener' | 'app' | 'desktop'
interface Group {
  readonly id: string
  readonly peers: Partial<Record<Role, ProbeSocket>>
  readonly reserved: Map<Role, symbol>
  readonly expiresAt: number
  readonly timer: ReturnType<typeof setTimeout>
  ticket: string | undefined
  bytes: number
  frames: number
}

export const probeFrameBytes = 64 * 1024 + 24
const maxBufferedBytes = 1024 * 1024

/** A bounded, short-lived capability experiment, not the /v1/relay service.
 * No account access, storage, background AI work, or outbound network requests. */
export class EdgeOneProbe {
  readonly bootId = crypto.randomUUID()
  private readonly groups = new Map<string, Group>()

  constructor(
    readonly kind: 'cloud' | 'agent',
    private readonly lifetimeMs = 60_000,
  ) {}

  handle(request: Pick<Request, 'url' | 'method' | 'headers'>): Response | ProbeUpgrade {
    const url = new URL(request.url)
    if (request.method !== 'GET') return new Response('GET required', { status: 405 })
    if (url.pathname !== `/probe/${this.kind}` || url.search)
      return new Response('Unknown probe endpoint', { status: 404 })
    if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
      return Response.json(
        { probe: 1, kind: this.kind, bootId: this.bootId, groups: this.groups.size },
        { headers: { 'cache-control': 'no-store' } },
      )
    }
    const id = request.headers.get('makers-conversation-id') ?? ''
    const role = request.headers.get('x-relay-probe-role')
    if (!/^[a-zA-Z0-9_.-]{6,36}$/.test(id) || !['listener', 'app', 'desktop'].includes(role ?? ''))
      return new Response('Invalid probe headers', { status: 400 })
    const acceptedRole = role as Role
    let group = this.groups.get(id)
    if (group && Date.now() >= group.expiresAt) {
      this.remove(group)
      group = undefined
    }
    if (acceptedRole === 'listener') {
      if (group) return new Response('Listener already exists', { status: 409 })
      if (this.groups.size >= 4) return new Response('Probe capacity exceeded', { status: 429 })
      const timer = setTimeout(() => {
        if (group) this.remove(group)
      }, this.lifetimeMs)
      timer.unref()
      group = {
        id,
        peers: {},
        reserved: new Map(),
        expiresAt: Date.now() + this.lifetimeMs,
        timer,
        ticket: undefined,
        bytes: 0,
        frames: 0,
      }
      this.groups.set(id, group)
    } else {
      if (!group?.peers.listener)
        return new Response('Listener is on another owner or offline', { status: 404 })
      if (group.reserved.has(acceptedRole)) return new Response('Role already reserved', { status: 409 })
      if (acceptedRole === 'desktop') {
        const ticket = request.headers.get('x-relay-probe-ticket') ?? ''
        if (
          !group.peers.app ||
          !group.ticket ||
          !/^[a-f0-9]{64}$/.test(ticket) ||
          !timingSafeEqual(Buffer.from(ticket), Buffer.from(group.ticket))
        )
          return new Response('Invalid one-time ticket', { status: 403 })
        group.ticket = undefined
      }
    }
    const accepted = group
    const reservation = Symbol(acceptedRole)
    accepted.reserved.set(acceptedRole, reservation)
    const current = () =>
      this.groups.get(id) === accepted &&
      accepted.reserved.get(acceptedRole) === reservation &&
      Date.now() < accepted.expiresAt
    const closed = (socket: ProbeSocket) => {
      if (accepted.peers[acceptedRole] !== socket) return
      if (acceptedRole === 'listener') this.remove(accepted)
      else this.closeData(accepted)
    }
    return {
      websocket: {
        onopen: (socket) => {
          if (!current() || accepted.peers[acceptedRole]) {
            this.close(socket)
            return
          }
          accepted.peers[acceptedRole] = socket
          if (
            !this.send(socket, JSON.stringify({ type: 'hello', role: acceptedRole, bootId: this.bootId }))
          ) {
            closed(socket)
            return
          }
          if (acceptedRole === 'app') {
            accepted.ticket = randomBytes(32).toString('hex')
            if (
              !this.send(accepted.peers.listener, JSON.stringify({ type: 'offer', ticket: accepted.ticket }))
            )
              this.remove(accepted)
          }
        },
        onmessage: (socket, input, isBinary) => {
          if (!current() || accepted.peers[acceptedRole] !== socket) {
            this.close(socket)
            return
          }
          if (++accepted.frames > 128) {
            this.remove(accepted)
            return
          }
          if (!isBinary && acceptedRole === 'listener') {
            const text =
              typeof input === 'string'
                ? input
                : input instanceof Uint8Array && input.byteLength === 4
                  ? new TextDecoder().decode(input)
                  : ''
            if (text === 'ping' && this.send(socket, 'pong')) return
          } else if (isBinary && acceptedRole !== 'listener') {
            const bytes =
              input instanceof Uint8Array
                ? input
                : input instanceof ArrayBuffer
                  ? new Uint8Array(input)
                  : undefined
            if (bytes && bytes.byteLength <= probeFrameBytes) {
              accepted.bytes += bytes.byteLength
              const other = accepted.peers[acceptedRole === 'app' ? 'desktop' : 'app']
              if (accepted.bytes <= 4 * 1024 * 1024 && this.send(other, bytes)) return
            }
          }
          if (acceptedRole === 'listener') this.remove(accepted)
          else this.closeData(accepted)
        },
        onclose: closed,
        onerror: closed,
      },
    }
  }

  private send(socket: ProbeSocket | undefined, data: string | Uint8Array): boolean {
    const bytes = typeof data === 'string' ? Buffer.byteLength(data) : data.byteLength
    if (
      socket?.readyState !== 1 ||
      !Number.isSafeInteger(socket.bufferedAmount) ||
      socket.bufferedAmount < 0 ||
      socket.bufferedAmount + bytes + 10 > maxBufferedBytes
    )
      return false
    try {
      socket.send(data)
      return true
    } catch {
      return false
    }
  }

  private closeData(group: Group): void {
    const peers = [group.peers.app, group.peers.desktop]
    delete group.peers.app
    delete group.peers.desktop
    group.reserved.delete('app')
    group.reserved.delete('desktop')
    group.ticket = undefined
    for (const peer of peers) this.close(peer)
  }

  private close(socket: ProbeSocket | undefined): void {
    try {
      socket?.close(1000, 'Probe finished')
    } catch {
      // State was removed first; a failed native close cannot revive the probe group.
    }
  }

  private remove(group: Group): void {
    if (this.groups.get(group.id) !== group) return
    this.groups.delete(group.id)
    clearTimeout(group.timer)
    this.closeData(group)
    const listener = group.peers.listener
    delete group.peers.listener
    this.close(listener)
  }

  dispose(): void {
    for (const group of this.groups.values()) this.remove(group)
  }
}
