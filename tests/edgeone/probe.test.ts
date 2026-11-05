import { afterEach, describe, expect, test } from 'bun:test'
import { randomBytes } from 'node:crypto'

import { onRequest as agentRequest } from '../../deploy/edgeone/probe/agent.js'
import { checkEdgeOneProbe } from '../../scripts/check-edgeone-probe.js'
import {
  EdgeOneProbe,
  probeFrameBytes,
  type ProbeSocket,
  type ProbeUpgrade,
} from '../../src/edgeone/probe.js'

class FakeSocket implements ProbeSocket {
  readyState = 1
  bufferedAmount = 0
  readonly frames: (string | Uint8Array)[] = []
  send(data: string | Uint8Array): void {
    this.frames.push(data)
  }
  close(): void {
    this.readyState = 3
  }
}

const probes: EdgeOneProbe[] = []
afterEach(() => {
  for (const probe of probes.splice(0)) probe.dispose()
})

function fixture(lifetimeMs = 60_000) {
  const probe = new EdgeOneProbe('cloud', lifetimeMs)
  probes.push(probe)
  const request = (id: string, role: string, ticket = '') =>
    probe.handle(
      new Request('http://localhost/probe/cloud', {
        headers: {
          upgrade: 'websocket',
          'makers-conversation-id': id,
          'x-relay-probe-role': role,
          'x-relay-probe-ticket': ticket,
        },
      }),
    )
  const reserve = (id: string, role: string, ticket = '') => {
    const result = request(id, role, ticket)
    if (result instanceof Response) throw new Error(`Reservation rejected: ${result.status}`)
    return result.websocket
  }
  const open = (id: string, role: string, ticket = '') => {
    const callbacks = reserve(id, role, ticket)
    const socket = new FakeSocket()
    callbacks.onopen(socket)
    return { callbacks, socket }
  }
  const pair = (id = crypto.randomUUID()) => {
    const listener = open(id, 'listener')
    const app = open(id, 'app')
    const offer = JSON.parse(String(listener.socket.frames[1])) as { ticket: string }
    const desktop = open(id, 'desktop', offer.ticket)
    return { id, listener, app, desktop, ticket: offer.ticket }
  }
  return { probe, request, reserve, open, pair }
}

describe('EdgeOne capability probe (not a production runtime)', () => {
  test('keeps binary frames and cleanup isolated; the listener survives data close', () => {
    const { pair } = fixture()
    const first = pair()
    const second = pair()
    const payload = randomBytes(probeFrameBytes)
    first.app.callbacks.onmessage(first.app.socket, payload, true)
    expect(first.desktop.socket.frames[1]).toEqual(payload)
    expect(second.desktop.socket.frames).toHaveLength(1)
    expect(first.listener.socket.frames).toHaveLength(2)
    second.desktop.callbacks.onmessage(
      second.desktop.socket,
      payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength),
      true,
    )
    expect(second.app.socket.frames[1]).toEqual(payload)
    first.app.callbacks.onclose(first.app.socket)
    expect(first.desktop.socket.readyState).toBe(3)
    first.listener.callbacks.onmessage(first.listener.socket, Buffer.from('ping'), false)
    expect(first.listener.socket.frames.at(-1)).toBe('pong')
    first.listener.callbacks.onclose(first.listener.socket)
    expect(second.listener.socket.readyState).toBe(1)
    expect(second.app.socket.readyState).toBe(1)
    expect(second.desktop.socket.readyState).toBe(1)
  })

  test('rejects another group ticket and a duplicate attach without displacing peers', () => {
    const { pair, open, request } = fixture()
    const first = pair()
    const secondId = crypto.randomUUID()
    open(secondId, 'listener')
    open(secondId, 'app')
    expect((request(secondId, 'desktop', first.ticket) as Response).status).toBe(403)
    expect((request(first.id, 'desktop', first.ticket) as Response).status).toBe(409)
    expect(first.desktop.socket.readyState).toBe(1)
    first.app.callbacks.onclose(first.app.socket)
    expect((request(first.id, 'desktop', first.ticket) as Response).status).toBe(403)
    expect(first.listener.socket.readyState).toBe(1)
  })

  test('a delayed upgrade or close from a cancelled pair cannot claim its replacement', () => {
    const { open, reserve, request } = fixture()
    const id = crypto.randomUUID()
    const listener = open(id, 'listener')
    const oldApp = open(id, 'app')
    const oldTicket = (JSON.parse(String(listener.socket.frames[1])) as { ticket: string }).ticket
    const lateDesktop = reserve(id, 'desktop', oldTicket)
    oldApp.callbacks.onclose(oldApp.socket)
    const app = open(id, 'app')
    const newTicket = (JSON.parse(String(listener.socket.frames[2])) as { ticket: string }).ticket
    expect((request(id, 'desktop', oldTicket) as Response).status).toBe(403)
    const desktopCallbacks = reserve(id, 'desktop', newTicket)
    const stale = new FakeSocket()
    lateDesktop.onopen(stale)
    expect(stale.readyState).toBe(3)
    const desktop = new FakeSocket()
    desktopCallbacks.onopen(desktop)
    oldApp.callbacks.onclose(oldApp.socket)
    lateDesktop.onclose(stale)
    expect(app.socket.readyState).toBe(1)
    expect(desktop.readyState).toBe(1)
    app.callbacks.onmessage(app.socket, Uint8Array.of(1, 2, 3), true)
    expect(desktop.frames[1]).toEqual(Uint8Array.of(1, 2, 3))
  })

  test('rejects oversized frames, unexpected text and saturated native output without dropping the listener', () => {
    const { pair } = fixture()
    const first = pair()
    first.app.callbacks.onmessage(first.app.socket, new Uint8Array(probeFrameBytes + 1), true)
    expect(first.desktop.socket.frames).toHaveLength(1)
    expect(first.desktop.socket.readyState).toBe(3)
    expect(first.listener.socket.readyState).toBe(1)
    const second = pair()
    second.desktop.socket.bufferedAmount = 1024 * 1024
    second.app.callbacks.onmessage(second.app.socket, new Uint8Array(1), true)
    expect(second.desktop.socket.frames).toHaveLength(1)
    expect(second.app.socket.readyState).toBe(3)
    expect(second.listener.socket.readyState).toBe(1)
    const third = pair()
    third.app.callbacks.onmessage(third.app.socket, 'unexpected', false)
    expect(third.desktop.socket.readyState).toBe(3)
    expect(third.listener.socket.readyState).toBe(1)
  })

  test('bounds reservations and expires groups including sockets that never finish upgrading', async () => {
    const { probe, reserve, request } = fixture(30)
    const delayed = reserve('group-1', 'listener')
    for (let i = 2; i <= 4; i++) reserve(`group-${i}`, 'listener')
    expect((request('group-5', 'listener') as Response).status).toBe(429)
    await Bun.sleep(60)
    const meta = probe.handle(new Request('http://localhost/probe/cloud')) as Response
    expect(await meta.json()).toMatchObject({ groups: 0 })
    const stale = new FakeSocket()
    delayed.onopen(stale)
    expect(stale.readyState).toBe(3)
    expect(request('group-1', 'listener')).not.toBeInstanceOf(Response)
  })

  test('adapts the Agents plain request header object', async () => {
    const result = agentRequest({
      request: {
        url: 'https://example.test/probe/agent',
        method: 'GET',
        headers: {},
      },
    })
    expect(result).toBeInstanceOf(Response)
    expect(await (result as Response).json()).toMatchObject({ kind: 'agent' })
  })

  test('runs the smoke client over real loopback WebSockets using a local callback harness', async () => {
    const { probe } = fixture()
    interface Data {
      callbacks: ProbeUpgrade['websocket']
      peer?: ProbeSocket
    }
    const server = Bun.serve<Data>({
      hostname: '127.0.0.1',
      port: 0,
      fetch(request, server) {
        const response = probe.handle(request)
        if (response instanceof Response) return response
        if (server.upgrade(request, { data: { callbacks: response.websocket } })) return
        return new Response('Upgrade failed', { status: 400 })
      },
      websocket: {
        perMessageDeflate: false,
        open(socket) {
          const peer: ProbeSocket = {
            get readyState() {
              return socket.readyState
            },
            get bufferedAmount() {
              return socket.getBufferedAmount()
            },
            send: (data) => {
              socket.send(data)
            },
            close: (code, reason) => socket.close(code, reason),
          }
          socket.data.peer = peer
          socket.data.callbacks.onopen(peer)
        },
        message(socket, data) {
          if (socket.data.peer)
            socket.data.callbacks.onmessage(socket.data.peer, data, typeof data !== 'string')
        },
        close(socket) {
          if (socket.data.peer) socket.data.callbacks.onclose(socket.data.peer)
        },
      },
    })
    try {
      const result = await checkEdgeOneProbe(`http://127.0.0.1:${server.port}`, 'cloud')
      expect(result.groups).toBe(2)
      expect(result.bytesPerDirectionPerGroup).toBeGreaterThanOrEqual(1024 * 1024)
    } finally {
      probe.dispose()
      await server.stop(true)
    }
  })

  test('the smoke client fails an HTTP JSON response instead of accepting it as a WebSocket', async () => {
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: () => Response.json({ websocket: {} }),
    })
    try {
      await expect(checkEdgeOneProbe(`http://127.0.0.1:${server.port}`, 'agent')).rejects.toThrow(
        'WebSocket upgrade or transport failed',
      )
    } finally {
      await server.stop(true)
    }
  })
})
