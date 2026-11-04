import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'

import { respondToRelayProbe } from '@cherrystudio/relay-client'
import {
  assertReadyMatches,
  type ClientControl,
  encodeFrame,
  parseServerControl,
  type ServerControl,
} from '@cherrystudio/relay-protocol'

class ProbePeer {
  readonly socket: WebSocket
  readonly opened: Promise<void>
  private readonly inbox: (string | Uint8Array)[] = []
  private wake: (() => void) | undefined

  constructor(url: string) {
    this.socket = new WebSocket(url, { perMessageDeflate: false })
    this.socket.binaryType = 'arraybuffer'
    this.opened = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('WebSocket upgrade timed out')), 10_000)
      this.socket.addEventListener(
        'open',
        () => {
          clearTimeout(timer)
          resolve()
        },
        { once: true },
      )
      this.socket.addEventListener(
        'error',
        () => {
          clearTimeout(timer)
          reject(new Error('WebSocket upgrade failed'))
        },
        { once: true },
      )
      this.socket.addEventListener(
        'close',
        () => {
          clearTimeout(timer)
          reject(new Error('WebSocket closed before upgrade'))
        },
        { once: true },
      )
    })
    this.socket.addEventListener('message', (event) => {
      if (typeof event.data === 'string' && respondToRelayProbe(this.socket, event.data)) return
      this.inbox.push(typeof event.data === 'string' ? event.data : new Uint8Array(event.data as ArrayBuffer))
      this.wake?.()
    })
    this.socket.addEventListener('close', () => this.wake?.())
  }

  send(message: ClientControl | Uint8Array) {
    this.socket.send(message instanceof Uint8Array ? message : JSON.stringify(message))
  }

  async read(): Promise<string | Uint8Array> {
    if (!this.inbox.length && this.socket.readyState === WebSocket.OPEN) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Relay response timed out')), 10_000)
        this.wake = () => {
          clearTimeout(timer)
          resolve()
        }
      }).finally(() => {
        this.wake = undefined
      })
    }
    const result = this.inbox.shift()
    assert(result !== undefined, 'Relay connection closed before expected response')
    return result
  }

  async control<T extends ServerControl['type']>(type: T): Promise<Extract<ServerControl, { type: T }>> {
    const raw = await this.read()
    assert(typeof raw === 'string', 'Expected a control message')
    const control = parseServerControl(raw)
    assert.equal(control.type, type, 'Unexpected control message type')
    return control as Extract<ServerControl, { type: T }>
  }
}

/** Exercises the public endpoint without accounts, private APIs or persistent host keys. */
export async function smokeRelay(endpoint: string, progress: (message: string) => void = () => {}) {
  const url = new URL(endpoint)
  assert(['ws:', 'wss:'].includes(url.protocol), 'Use ws:// or wss://')
  assert(
    url.pathname === '/v1/relay' && !url.search && !url.hash && !url.username && !url.password,
    'Use the exact /v1/relay URL without credentials, a query or fragment',
  )
  const loopback = ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)
  assert(url.protocol === 'wss:' || loopback, 'Public endpoints require WSS')
  const http = new URL(url)
  http.protocol = url.protocol === 'wss:' ? 'https:' : 'http:'
  for (const path of ['/healthz', '/readyz']) {
    http.pathname = path
    const response = await fetch(http, { redirect: 'error', signal: AbortSignal.timeout(10_000) })
    assert.equal(response.status, 200, `${path} failed`)
    assert.deepEqual(await response.json(), { status: path === '/healthz' ? 'ok' : 'ready' })
  }
  progress('Health and readiness passed')
  const peers: ProbePeer[] = []
  const open = async (message: ClientControl) => {
    const peer = new ProbePeer(url.href)
    peers.push(peer)
    await peer.opened
    peer.send(message)
    return peer
  }
  try {
    const host = await open({ v: 1, type: 'listen', hostKey: randomBytes(32).toString('hex') })
    const listening = await host.control('listening')
    const app = await open({ v: 1, type: 'connect', targetId: listening.targetId })
    const pending = await app.control('pending')
    const offer = await host.control('offer')
    assertReadyMatches({ ...pending, type: 'ready' }, offer)
    const desktop = await open({
      v: 1,
      type: 'attach',
      sessionId: offer.sessionId,
      ownerEpoch: offer.ownerEpoch,
      ticket: offer.ticket,
    })
    assertReadyMatches({ ...(await desktop.control('pending')), type: 'ready' }, pending)
    const start: ClientControl = {
      v: 1,
      type: 'start',
      sessionId: offer.sessionId,
      ownerEpoch: offer.ownerEpoch,
    }
    app.send(start)
    desktop.send(start)
    assertReadyMatches(await app.control('ready'), pending)
    assertReadyMatches(await desktop.control('ready'), pending)
    progress('Listener, connect and attach reached the same session')
    // Each direction has its own sequence and cumulative ACK. Stop-and-wait avoids load testing a public relay.
    const size = Math.min(64 * 1024, pending.limits.maxFrameBytes)
    const chunks = Math.ceil((1024 * 1024) / size)
    for (const [sender, receiver] of [
      [app, desktop],
      [desktop, app],
    ] as const) {
      for (let index = 1; index <= chunks; index++) {
        const seq = BigInt(index)
        const cumulativeBytes = seq * BigInt(size)
        const frame = encodeFrame({ type: 'data', seq, cumulativeBytes, payload: randomBytes(size) })
        sender.send(frame)
        assert.deepEqual(await receiver.read(), new Uint8Array(frame), 'Binary payload was modified')
        const ack = encodeFrame({ type: 'ack', seq, cumulativeBytes })
        receiver.send(ack)
        assert.deepEqual(await sender.read(), new Uint8Array(ack), 'ACK was modified')
      }
      progress(`Verified ${size * chunks} binary bytes and ACKs in one direction`)
    }
    const close = encodeFrame({ type: 'close', reason: 'NORMAL' })
    app.send(close)
    assert.deepEqual(await desktop.read(), new Uint8Array(close))
    assert.equal((await host.control('session_closed')).reason, 'NORMAL')
    return { health: 'ok', rendezvous: 'ok', bytesPerDirection: size * chunks, close: 'ok' }
  } finally {
    for (const peer of peers) peer.socket.terminate()
  }
}

if (import.meta.main) {
  const endpoint = process.argv[2]
  if (!endpoint) throw new Error('Usage: bun run smoke:relay wss://relay.example.com/v1/relay')
  const deadline = setTimeout(() => {
    console.error('Smoke check exceeded its 180-second deadline')
    process.exit(1)
  }, 180_000)
  try {
    console.log(await smokeRelay(endpoint, console.log))
  } finally {
    clearTimeout(deadline)
  }
}
