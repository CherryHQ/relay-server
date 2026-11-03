import { afterEach, expect, test } from 'bun:test'

import { defaultRelayLimits, encodeFrame, type RelayOffer } from '@cherrystudio/relay-protocol'
import { defaultLogger } from '@libp2p/logger'

import { attachRelayStream, connectRelayStream, type RelayConnectOptions } from '../src/index.js'

class Socket {
  private readonly events = new EventTarget()
  binaryType = ''
  readyState = 0
  bufferedAmount = 0
  readonly sent: (string | Uint8Array)[] = []
  closeCount = 0
  send(data: string | Uint8Array) {
    this.sent.push(data)
  }
  close() {
    this.closeCount++
    this.readyState = 3
    this.events.dispatchEvent(new Event('close'))
  }
  open() {
    this.readyState = 1
    this.events.dispatchEvent(new Event('open'))
  }
  receive(data: unknown) {
    this.events.dispatchEvent(new MessageEvent('message', { data }))
  }
  addEventListener(type: string, listener: (event: never) => void) {
    this.events.addEventListener(type, listener as EventListener)
  }
  removeEventListener(type: string, listener: (event: never) => void) {
    this.events.removeEventListener(type, listener as EventListener)
  }
}

const pending = {
  v: 1 as const,
  type: 'pending' as const,
  sessionId: 'session',
  ownerEpoch: 'epoch',
  limits: defaultRelayLimits,
  expiresInMs: 5000,
}
const ready = { v: 1, type: 'ready', sessionId: 'session', ownerEpoch: 'epoch', limits: defaultRelayLimits }
const offer: RelayOffer = { ...pending, type: 'offer', ticket: 'ab'.repeat(32) }
const controllers: AbortController[] = []
function fixture(options: Partial<RelayConnectOptions> = {}) {
  const socket = new Socket()
  const controller = new AbortController()
  controllers.push(controller)
  const urls: string[] = []
  return {
    socket,
    controller,
    urls,
    options: {
      origin: 'https://relay.example',
      createSocket: (url: string) => {
        urls.push(url)
        return socket
      },
      log: defaultLogger().forComponent('rendezvous-test'),
      signal: controller.signal,
      ...options,
    },
  }
}
afterEach(() => {
  for (const controller of controllers.splice(0)) controller.abort()
})

test('connect installs the stream synchronously before pipelined DATA and keeps cancellation ownership', async () => {
  const h = fixture()
  const connected = connectRelayStream('01'.repeat(32), h.options)
  h.socket.open()
  expect(h.urls).toEqual(['wss://relay.example/v1/relay'])
  expect(JSON.parse(h.socket.sent[0] as string)).toEqual({ v: 1, type: 'connect', targetId: '01'.repeat(32) })
  h.socket.receive(JSON.stringify(pending))
  expect(JSON.parse(h.socket.sent[1] as string)).toEqual({
    v: 1,
    type: 'start',
    sessionId: 'session',
    ownerEpoch: 'epoch',
  })
  h.socket.receive(JSON.stringify(ready))
  h.socket.receive(
    encodeFrame({ type: 'data', seq: 1n, cumulativeBytes: 3n, payload: new Uint8Array([1, 2, 3]) }),
  )
  const stream = await connected
  const iterator = stream[Symbol.asyncIterator]()
  expect((await iterator.next()).value?.subarray()).toEqual(new Uint8Array([1, 2, 3]))
  h.controller.abort()
  expect(stream.status).toBe('aborted')
  expect(h.socket.closeCount).toBe(1)
})

test('attach freezes its offer and rejects pending selection changes before sending start', async () => {
  const h = fixture()
  const input = { ...offer, limits: { ...offer.limits } }
  const connecting = attachRelayStream(input, h.options)
  input.ownerEpoch = 'replaced'
  input.limits.windowBytes = 1024
  h.socket.open()
  expect(JSON.parse(h.socket.sent[0] as string).ownerEpoch).toBe('epoch')
  h.socket.receive(JSON.stringify({ ...pending, ownerEpoch: 'replaced' }))
  await expect(connecting).rejects.toThrow('does not match')
  expect(h.socket.sent).toHaveLength(1)
  expect(h.socket.closeCount).toBe(1)
})

test('ready must match pending; duplicate pending, early ready and binary control are rejected', async () => {
  for (const controls of [
    [ready],
    [new Uint8Array([1])],
    [pending, pending],
    [pending, { ...ready, sessionId: 'other' }],
    [pending, { ...ready, limits: { ...defaultRelayLimits, windowBytes: 65536 } }],
  ]) {
    const h = fixture()
    const connecting = connectRelayStream('01'.repeat(32), h.options)
    h.socket.open()
    for (const control of controls)
      h.socket.receive(control instanceof Uint8Array ? control : JSON.stringify(control))
    await expect(connecting).rejects.toThrow()
    expect(h.socket.closeCount).toBe(1)
    h.socket.receive(JSON.stringify(ready))
    expect(h.socket.closeCount).toBe(1)
  }
})

test('abort before opening and while waiting closes exactly once and cannot send late control', async () => {
  for (const opened of [false, true]) {
    const h = fixture()
    const connecting = connectRelayStream('01'.repeat(32), h.options)
    if (opened) {
      h.socket.open()
      h.socket.receive(JSON.stringify(pending))
    }
    const sent = h.socket.sent.length
    h.controller.abort(new Error('User cancelled'))
    await expect(connecting).rejects.toThrow('User cancelled')
    h.socket.open()
    h.socket.receive(JSON.stringify(pending))
    expect(h.socket.sent).toHaveLength(sent)
    expect(h.socket.closeCount).toBe(1)
  }
  const h = fixture()
  h.controller.abort()
  await expect(connectRelayStream('01'.repeat(32), h.options)).rejects.toThrow()
  expect(h.urls).toHaveLength(0)
})

test('opening timeout and server waiting expiry terminate attempts', async () => {
  const opening = fixture({ timeoutMs: 20 })
  await expect(connectRelayStream('01'.repeat(32), opening.options)).rejects.toThrow('timed out')
  expect(opening.socket.closeCount).toBe(1)
  const waiting = fixture()
  const connecting = attachRelayStream(offer, waiting.options)
  waiting.socket.open()
  waiting.socket.receive(JSON.stringify({ ...pending, expiresInMs: 20 }))
  await expect(connecting).rejects.toThrow('expired')
  expect(waiting.socket.closeCount).toBe(1)
})

test('invalid origins and targets never create a socket', async () => {
  for (const origin of [
    'http://relay.example',
    'https://user:secret@relay.example',
    'https://relay.example/path',
    'https://relay.example/?ticket=x',
  ]) {
    const h = fixture({ origin })
    await expect(connectRelayStream('01'.repeat(32), h.options)).rejects.toThrow()
    expect(h.urls).toHaveLength(0)
  }
  const h = fixture()
  await expect(connectRelayStream('invalid', h.options)).rejects.toThrow()
  expect(h.urls).toHaveLength(0)
})
