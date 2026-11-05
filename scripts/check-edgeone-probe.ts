import { randomBytes } from 'node:crypto'

import { probeFrameBytes } from '../src/edgeone/probe.js'

type Frame = string | Uint8Array
type Role = 'listener' | 'app' | 'desktop'
const timeoutMs = 10_000

class ProbePeer {
  readonly socket: WebSocket
  private readonly messages: Frame[] = []
  private wake: (() => void) | undefined
  private failure: Error | undefined
  private ended = false

  constructor(url: URL, id: string, role: Role, ticket?: string) {
    this.socket = new WebSocket(url, {
      headers: {
        'Makers-Conversation-Id': id,
        'X-Relay-Probe-Role': role,
        ...(ticket ? { 'X-Relay-Probe-Ticket': ticket } : {}),
      },
      perMessageDeflate: false,
    })
    this.socket.binaryType = 'arraybuffer'
    this.socket.addEventListener('message', (event) => {
      if (this.messages.length >= 8) {
        this.failure = new Error('Probe received unsolicited frames')
        this.socket.terminate()
      } else if (typeof event.data === 'string') {
        this.messages.push(event.data)
      } else if (event.data instanceof ArrayBuffer && event.data.byteLength <= probeFrameBytes) {
        this.messages.push(new Uint8Array(event.data))
      } else {
        this.failure = new Error('Probe received an invalid binary frame')
        this.socket.terminate()
      }
      this.wake?.()
    })
    this.socket.addEventListener('error', () => {
      this.failure = new Error(`${role}: WebSocket upgrade or transport failed at ${url.pathname}`)
      this.wake?.()
    })
    this.socket.addEventListener('close', () => {
      this.ended = true
      this.wake?.()
    })
  }

  private async wait(condition: () => boolean): Promise<void> {
    if (this.wake) throw new Error('Concurrent reads on a probe peer')
    const deadline = Date.now() + timeoutMs
    while (!condition()) {
      if (this.failure) throw this.failure
      if (Date.now() >= deadline) throw new Error('Probe timed out')
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => this.wake?.(), Math.max(1, deadline - Date.now()))
        this.wake = () => {
          clearTimeout(timer)
          this.wake = undefined
          resolve()
        }
      })
    }
    if (this.failure) throw this.failure
  }

  async next(): Promise<Frame> {
    await this.wait(() => this.messages.length > 0 || this.ended)
    const frame = this.messages.shift()
    if (frame === undefined) throw new Error('Probe socket closed before the expected frame')
    return frame
  }

  async control(type: string): Promise<Record<string, unknown>> {
    const frame = await this.next()
    if (typeof frame !== 'string') throw new Error(`Expected ${type}, received binary`)
    const value: unknown = JSON.parse(frame)
    if (!value || typeof value !== 'object' || !('type' in value) || value.type !== type)
      throw new Error(`Expected control ${type}`)
    return value as Record<string, unknown>
  }

  async closed(): Promise<void> {
    await this.wait(() => this.ended)
    if (this.messages.length) throw new Error('Unexpected frames before close')
  }

  async ping(): Promise<void> {
    this.socket.send('ping')
    if ((await this.next()) !== 'pong') throw new Error('Listener failed to survive data connection closure')
  }
}

function probeUrl(origin: string, kind: 'cloud' | 'agent'): URL {
  const url = new URL(origin)
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if (
    (url.protocol !== 'https:' && !(loopback && url.protocol === 'http:')) ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  )
    throw new Error('Supply an HTTPS origin, or HTTP loopback origin, without a path or credentials')
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  url.pathname = `/probe/${kind}`
  return url
}

/** Exercise the native callback contract using synthetic data only. A successful
 * batch is not a platform affinity guarantee, production adapter, or benchmark. */
export async function checkEdgeOneProbe(origin: string, kind: 'cloud' | 'agent') {
  const url = probeUrl(origin, kind)
  const peers: ProbePeer[] = []
  const open = async (id: string, role: Role, ticket?: string) => {
    const peer = new ProbePeer(url, id, role, ticket)
    peers.push(peer)
    const hello = await peer.control('hello')
    if (hello.role !== role || typeof hello.bootId !== 'string' || !hello.bootId)
      throw new Error('Invalid owner handshake')
    return { peer, bootId: hello.bootId }
  }
  const pair = async () => {
    const id = crypto.randomUUID()
    const listener = await open(id, 'listener')
    const app = await open(id, 'app')
    const offer = await listener.peer.control('offer')
    if (typeof offer.ticket !== 'string' || !/^[a-f0-9]{64}$/.test(offer.ticket))
      throw new Error('Invalid attach offer')
    const desktop = await open(id, 'desktop', offer.ticket)
    if (app.bootId !== listener.bootId || desktop.bootId !== listener.bootId)
      throw new Error('Three sockets reached different owners')
    return { listener: listener.peer, app: app.peer, desktop: desktop.peer, bootId: listener.bootId }
  }
  const transfer = async (sender: ProbePeer, receiver: ProbePeer, bytes = probeFrameBytes) => {
    const payload = randomBytes(bytes)
    sender.socket.send(payload)
    const received = await receiver.next()
    if (!(received instanceof Uint8Array) || !payload.equals(received))
      throw new Error('Binary payload mismatch or cross-session delivery')
  }
  try {
    const first = await pair()
    const second = await pair()
    for (let frame = 0; frame < 16; frame++) {
      await Promise.all([transfer(first.app, first.desktop), transfer(second.app, second.desktop)])
      await Promise.all([transfer(first.desktop, first.app), transfer(second.desktop, second.app)])
    }
    first.app.socket.close(1000, 'Data complete')
    await Promise.all([first.app.closed(), first.desktop.closed()])
    await first.listener.ping()
    await transfer(second.app, second.desktop, 37)
    // Closing one listener must remove only its group.
    first.listener.socket.close(1000, 'Group complete')
    await first.listener.closed()
    await second.listener.ping()
    await transfer(second.desktop, second.app, 53)
    second.listener.socket.close(1000, 'Probe complete')
    await Promise.all([second.listener.closed(), second.app.closed(), second.desktop.closed()])
    return {
      kind,
      groups: 2,
      ownerBootIds: [first.bootId, second.bootId],
      frameBytes: probeFrameBytes,
      bytesPerDirectionPerGroup: 16 * probeFrameBytes,
    }
  } finally {
    for (const peer of peers) peer.socket.terminate()
  }
}

if (import.meta.main) {
  const [origin, selected = 'all', ...extra] = process.argv.slice(2)
  if (!origin || !['all', 'cloud', 'agent'].includes(selected) || extra.length)
    throw new Error('Usage: bun run check:edgeone-probe https://<host> [all|cloud|agent]')
  const kinds = selected === 'all' ? (['cloud', 'agent'] as const) : [selected as 'cloud' | 'agent']
  let failed = false
  for (const kind of kinds) {
    try {
      console.log(JSON.stringify({ status: 'passed', ...(await checkEdgeOneProbe(origin, kind)) }))
    } catch (error) {
      failed = true
      console.error(
        JSON.stringify({
          kind,
          status: 'failed',
          message: error instanceof Error ? error.message : String(error),
        }),
      )
    }
  }
  if (failed) process.exitCode = 1
}
