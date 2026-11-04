import {
  assertReadyMatches,
  canonicalRelayOrigin,
  type ClientControl,
  parseClientControl,
  parseServerControl,
  type RelayOffer,
  type RelayPending,
  RelayProtocolError,
  rendezvousPath,
} from '@cherrystudio/relay-protocol'
import type { Logger } from '@libp2p/interface'

import type { RelaySocketFactory } from './ports.js'
import { respondToRelayProbe } from './probe.js'
import { RelayStream } from './RelayStream.js'

export interface RelayConnectOptions {
  readonly origin: string
  readonly createSocket: RelaySocketFactory
  readonly log: Logger
  /** Owns the attempt and the returned stream until the caller closes it. */
  readonly signal: AbortSignal
  readonly timeoutMs?: number
  /** Development only; never permits cleartext connections outside loopback. */
  readonly allowLoopbackHttp?: boolean
}

export function connectRelayStream(targetId: string, options: RelayConnectOptions): Promise<RelayStream> {
  return rendezvous({ v: 1, type: 'connect', targetId }, options)
}

export async function attachRelayStream(
  offer: RelayOffer,
  options: RelayConnectOptions,
): Promise<RelayStream> {
  // Snapshot before the asynchronous exchange so the caller cannot change the accepted selection.
  const expected = parseServerControl(JSON.stringify(offer))
  if (expected.type !== 'offer') return Promise.reject(new RelayProtocolError('Expected a relay offer'))
  return rendezvous(
    {
      v: 1,
      type: 'attach',
      sessionId: expected.sessionId,
      ownerEpoch: expected.ownerEpoch,
      ticket: expected.ticket,
    },
    options,
    expected,
  )
}

async function rendezvous(
  request: ClientControl,
  options: RelayConnectOptions,
  expected?: RelayOffer,
): Promise<RelayStream> {
  const { createSocket, signal, log } = options
  signal.throwIfAborted()
  const timeoutMs = options.timeoutMs ?? 15_000
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    throw new RelayProtocolError('Invalid rendezvous timeout')
  }
  const origin = canonicalRelayOrigin(options.origin, options.allowLoopbackHttp)
  const encoded = JSON.stringify(parseClientControl(JSON.stringify(request)))
  const socket = createSocket(`${origin.replace(/^http/, 'ws')}${rendezvousPath}`)
  return new Promise((resolve, reject) => {
    let settled = false
    let opened = false
    let pending: RelayPending | undefined
    let expiry: ReturnType<typeof setTimeout> | undefined
    const timer = setTimeout(() => fail(new Error('Relay rendezvous timed out')), timeoutMs)
    const cleanup = () => {
      clearTimeout(timer)
      clearTimeout(expiry)
      signal.removeEventListener('abort', abort)
      socket.removeEventListener('open', open)
      socket.removeEventListener('message', message)
      socket.removeEventListener('close', closed)
      socket.removeEventListener('error', closed)
    }
    const fail = (error: unknown) => {
      if (settled) return
      settled = true
      cleanup()
      try {
        socket.close(error instanceof RelayProtocolError ? 1002 : 1000, 'CANCELLED')
      } catch {
        /* Closing a failed native socket must not mask the original failure. */
      }
      reject(error instanceof Error ? error : new Error('Relay connection cancelled'))
    }
    const abort = () => fail(signal.reason)
    const closed = () => fail(new Error('Relay connection ended before ready'))
    const send = (json: string) => {
      if (socket.readyState !== 1 || socket.send(json) === 0) {
        throw new Error('Relay socket rejected control message')
      }
    }
    const open = () => {
      if (settled || opened) return
      opened = true
      try {
        send(encoded)
      } catch (error) {
        fail(error)
      }
    }
    const message = (event: { data: unknown }) => {
      if (settled) return
      try {
        if (!opened || typeof event.data !== 'string') {
          throw new RelayProtocolError('Expected relay control message')
        }
        if (respondToRelayProbe(socket, event.data)) return
        const control = parseServerControl(event.data)
        if (control.type === 'pending' && !pending) {
          if (expected) assertReadyMatches({ ...control, type: 'ready' }, expected)
          pending = control
          expiry = setTimeout(() => fail(new Error('Relay rendezvous expired')), control.expiresInMs)
          send(
            JSON.stringify({
              v: 1,
              type: 'start',
              sessionId: pending.sessionId,
              ownerEpoch: pending.ownerEpoch,
            }),
          )
          return
        }
        if (control.type !== 'ready' || !pending) {
          throw new RelayProtocolError('Unexpected relay control message')
        }
        assertReadyMatches(control, pending)
        // Install during this callback: the peer's first DATA may precede a promise continuation.
        const stream = new RelayStream(socket, {
          log,
          limits: pending.limits,
          direction: expected ? 'inbound' : 'outbound',
          signal,
        })
        settled = true
        cleanup()
        resolve(stream)
      } catch (error) {
        fail(error)
      }
    }
    socket.binaryType = 'arraybuffer'
    socket.addEventListener('open', open)
    socket.addEventListener('message', message)
    socket.addEventListener('close', closed)
    socket.addEventListener('error', closed)
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    else if (socket.readyState === 1) open()
    else if (socket.readyState !== 0) closed()
  })
}
