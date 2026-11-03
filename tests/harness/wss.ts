import { RelayStream } from '@cherrystudio/relay-client'
import {
  assertReadyMatches,
  decodeFrame,
  defaultRelayLimits,
  parseRelayReady,
  type RelayLimits,
  type RelayReady,
} from '@cherrystudio/relay-protocol'
import { defaultLogger } from '@libp2p/logger'
import type { ServerWebSocket } from 'bun'

import { createTestTls } from './tls.js'

/** Loopback-only test fixture. Has no enrollment/auth/attach implementation and is never exported. */
export async function createWssHarness(limits: RelayLimits = defaultRelayLimits) {
  const fixture = await createTestTls()
  const { cert, key } = fixture.tls
  const sockets = new Map<string, ServerWebSocket<{ role: string }>>()
  const clients = new Set<WebSocket>()
  const ready: RelayReady = {
    v: 1,
    type: 'ready',
    sessionId: 'test_session',
    ownerEpoch: 'test_epoch',
    limits,
  }
  const stats = { dataFrames: 0, ackFrames: 0, maxPayloadBytes: 0, wireBytes: 0 }
  const server = Bun.serve<{ role: string }>({
    hostname: '127.0.0.1',
    port: 0,
    tls: { cert, key },
    fetch(request, server) {
      const role = new URL(request.url).pathname.slice(1)
      if (!['desktop', 'mobile'].includes(role) || sockets.has(role))
        return new Response('Not found', { status: 404 })
      if (server.upgrade(request, { data: { role } })) return
      return new Response('Upgrade required', { status: 426 })
    },
    websocket: {
      perMessageDeflate: false,
      maxPayloadLength: 64 * 1024 + 24,
      backpressureLimit: 1024 * 1024,
      closeOnBackpressureLimit: true,
      open(socket) {
        sockets.set(socket.data.role, socket)
        if (sockets.size === 2) for (const peer of sockets.values()) peer.send(JSON.stringify(ready))
      },
      message(socket, bytes) {
        if (typeof bytes === 'string') {
          socket.close(1003, 'Binary only')
          return
        }
        const other = sockets.get(socket.data.role === 'desktop' ? 'mobile' : 'desktop')
        if (!other || other.getBufferedAmount() + bytes.byteLength > 1024 * 1024) {
          socket.close(1008, 'Peer unavailable or slow')
          return
        }
        try {
          const frame = decodeFrame(bytes)
          stats.wireBytes += bytes.byteLength
          if (frame.type === 'data') {
            stats.dataFrames++
            stats.maxPayloadBytes = Math.max(stats.maxPayloadBytes, frame.payload.byteLength)
          } else if (frame.type === 'ack') stats.ackFrames++
          // Forward the original bytes, including ACK/CLOSE. -1 is accepted, not a retry request.
          if (other.send(bytes, true) === 0) socket.close(1011, 'Forward failed')
        } catch {
          socket.close(1002, 'Invalid frame')
        }
      },
      close(socket) {
        sockets.delete(socket.data.role)
        for (const peer of sockets.values()) peer.close(1000, 'Peer closed')
      },
    },
  })

  const connect = (role: string): Promise<RelayStream> =>
    new Promise((resolve, reject) => {
      // Trust only this fixture's ephemeral certificate; never disable TLS verification globally.
      const socket = new WebSocket(`wss://127.0.0.1:${server.port}/${role}`, {
        tls: { ca: cert },
        perMessageDeflate: false,
      })
      clients.add(socket)
      const timer = setTimeout(() => fail(new Error('Test ready timeout')), 5000)
      const cleanup = () => {
        clearTimeout(timer)
        socket.removeEventListener('message', message)
        socket.removeEventListener('error', failed)
        socket.removeEventListener('close', failed)
      }
      const fail = (error: Error) => {
        cleanup()
        socket.close()
        reject(error)
      }
      const failed = () => fail(new Error('Test connection failed before ready'))
      const message = (event: MessageEvent) => {
        try {
          if (typeof event.data !== 'string') throw new Error('Expected ready')
          if (socket.extensions) throw new Error('Unexpected WebSocket extension')
          assertReadyMatches(parseRelayReady(event.data), ready)
          cleanup()
          resolve(new RelayStream(socket, { log: defaultLogger().forComponent(role), limits }))
        } catch (error) {
          fail(error instanceof Error ? error : new Error('Invalid ready'))
        }
      }
      socket.addEventListener('message', message)
      socket.addEventListener('error', failed)
      socket.addEventListener('close', failed)
    })
  return {
    stats,
    pair: () => Promise.all([connect('desktop'), connect('mobile')]),
    async dispose() {
      for (const socket of clients) socket.close()
      await server.stop(true)
      await fixture.dispose()
    },
  }
}
