import { expect, test } from 'bun:test'

import { decodeFrame, encodeFrame } from '@cherrystudio/relay-protocol'

import { durableFixture } from './fixture.js'

const data = (seq = 1n, size = 4) =>
  encodeFrame({
    type: 'data',
    seq,
    cumulativeBytes: seq * BigInt(size),
    payload: new Uint8Array(size).fill(7),
  })
const ack = (seq = 1n, bytes = seq * 4n) => encodeFrame({ type: 'ack', seq, cumulativeBytes: bytes })

test('the first transport receipt may arrive while listener hashing is still in progress', async () => {
  const h = durableFixture()
  const sha256 = h.host.sha256
  let release: (() => void) | undefined
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  h.host.sha256 = async (text) => {
    await gate
    return sha256(text)
  }
  const socket = await h.open(undefined, false)
  const admission = h.send(socket, { v: 1, type: 'listen', hostKey: 'ab'.repeat(32) })
  await h.receipts(socket)
  release?.()
  await admission
  expect(socket.reason).toBeUndefined()
  expect(socket.control('listening').ownerEpoch).toBe(h.runtime.ownerEpoch)
})

test('hibernation preserves listener, epoch, started roles and consumed tickets through rendezvous', async () => {
  const h = durableFixture()
  const host = await h.listen()
  h.hibernate()
  const { app, offer } = await h.pending(host)
  h.hibernate()
  const desktop = await h.attach(offer)
  desktop.control('pending')
  await h.send(app, { v: 1, type: 'start', sessionId: offer.sessionId, ownerEpoch: offer.ownerEpoch })
  h.hibernate()
  expect((await h.attach(offer)).reason).toBe('INVALID_TICKET')
  await h.send(desktop, { v: 1, type: 'start', sessionId: offer.sessionId, ownerEpoch: offer.ownerEpoch })
  app.control('ready')
  desktop.control('ready')
  expect(h.runtime.ownerEpoch).toBe(host.info.ownerEpoch)
  expect(h.runtime.getStats().sessions).toBe(1)
  expect(h.runtime.nextDeadline).toBeUndefined()
  h.hibernate()
  await h.send(app, data())
  expect(desktop.inbox).toContainEqual(data())
})

test('unacknowledged DATA and both sequence spaces survive eviction without new credit or replay', async () => {
  const h = durableFixture({ limits: { maxFrameBytes: 4, windowBytes: 8, maxInFlightFrames: 2 } })
  const host = await h.listen()
  const pair = await h.pair(host)
  await h.send(pair.app, data())
  await h.send(pair.app, data(2n))
  await h.send(pair.desktop, data())
  const before = pair.desktop.inbox.length
  h.hibernate()
  expect(pair.desktop.inbox).toHaveLength(before)
  await h.send(pair.desktop, ack(2n))
  h.hibernate()
  await h.send(pair.app, ack())
  await h.send(pair.app, data(3n))
  expect(pair.desktop.inbox).toContainEqual(data(3n))
  h.hibernate()
  await h.send(pair.desktop, ack(2n)) // Duplicate ACK still returns no extra credit.
  await h.send(pair.app, data(4n))
  await h.send(pair.app, data(5n))
  expect(pair.app.reason).toBe('PROTOCOL_ERROR')
  expect(h.runtime.getStats().sessions).toBe(0)
})

test('hibernation never forgives a forged ACK, old sequence or expired ticket', async () => {
  const h = durableFixture({ rendezvousMs: 100 })
  const host = await h.listen()
  const waiting = await h.pending(host)
  h.hibernate()
  h.advance(101)
  expect(waiting.app.reason).toBe('CANCELLED')
  host.socket.control('session_closed')
  expect((await h.attach(waiting.offer)).reason).toBe('INVALID_TICKET')
  for (const bad of [ack(2n), ack(1n, 3n), data()]) {
    const pair = await h.pair(host)
    await h.send(pair.app, data())
    h.hibernate()
    await h.send(decodeFrame(bad).type === 'ack' ? pair.desktop : pair.app, bad)
    expect(pair.app.reason).toBe('PROTOCOL_ERROR')
    host.socket.control('session_closed')
  }
})

test('stall deadlines survive hibernation; idle listeners do not need recurring alarms', async () => {
  const h = durableFixture({ stallMs: 100 })
  const host = await h.listen()
  expect(h.runtime.nextDeadline).toBeUndefined()
  const pair = await h.pair(host)
  await h.send(pair.app, data())
  const deadline = h.runtime.nextDeadline
  h.hibernate()
  expect(h.runtime.nextDeadline).toBe(deadline)
  h.advance(101)
  expect(pair.desktop.reason).toBe('STALLED')
  expect(h.runtime.nextDeadline).toBeUndefined()
  h.close(pair.app)
  h.close(pair.desktop)
  h.close(host.socket)
  expect(h.runtime.getStats()).toMatchObject({ connections: 0, targets: 0, sessions: 0, bufferBytes: 0 })
})

test('a lost listener cancels waiting sessions and leaves ready streams usable after eviction', async () => {
  const h = durableFixture()
  const host = await h.listen()
  const pair = await h.pair(host)
  const waiting = await h.pending(host)
  h.close(host.socket)
  expect(waiting.app.reason).toBe('RELAY_UNAVAILABLE')
  h.hibernate()
  await h.send(pair.app, data())
  expect(pair.desktop.inbox).toContainEqual(data())
  const restored = await h.listen(host.hostKey)
  expect(restored.info.targetId).toBe(host.info.targetId)
  expect((await h.open({ v: 1, type: 'listen', hostKey: host.hostKey })).reason).toBe('TARGET_BUSY')
})

test('fake DATA credit cannot free native output budget, even across eviction', async () => {
  const h = durableFixture({ maxSocketBufferBytes: 160_000, maxTotalBufferBytes: 640_000 })
  const host = await h.listen()
  const pair = await h.pair(host)
  await h.send(pair.app, data(1n, 65_536))
  await h.send(pair.desktop, ack(1n, 65_536n)) // Receiver predicts credit but never reads the random probe.
  h.hibernate()
  await h.send(pair.app, data(2n, 65_536))
  await h.send(pair.desktop, ack(2n, 131_072n))
  await h.send(pair.app, data(3n, 65_536))
  expect(pair.app.reason).toBe('RESOURCE_EXHAUSTED')
  expect(h.runtime.getStats().bufferBytes).toBeLessThanOrEqual(640_000)
  const retained = h.runtime.getStats().bufferBytes
  expect(retained).toBeGreaterThan(131_072)
  h.hibernate()
  expect(h.runtime.getStats().bufferBytes).toBe(retained)
  h.close(pair.app)
  h.close(pair.desktop)
  h.close(host.socket)
  expect(h.runtime.getStats().bufferBytes).toBe(0)
})

test('random receipts restore capacity while guessed, repeated or expired receipts fail closed', async () => {
  const h = durableFixture({ maxSocketBufferBytes: 160_000, maxTotalBufferBytes: 640_000 })
  const host = await h.listen()
  const pair = await h.pair(host)
  for (let i = 1n; i <= 20n; i++) {
    await h.send(pair.app, data(i, 65_536))
    h.hibernate()
    await h.receipts(pair.desktop)
    await h.send(pair.desktop, ack(i, i * 65_536n))
  }
  expect(pair.app.reason).toBeUndefined()
  await h.send(pair.desktop, JSON.stringify({ v: 1, type: 'probe_ack', nonce: '00'.repeat(16) }))
  expect(pair.app.reason).toBe('PROTOCOL_ERROR')
})

test('maximum tiny-frame metadata fits the native attachment budget in both directions', async () => {
  const h = durableFixture()
  const host = await h.listen()
  const pair = await h.pair(host)
  for (let seq = 1n; seq <= 64n; seq++) {
    await h.send(pair.app, data(seq, 1))
    await h.send(pair.desktop, data(seq, 1))
  }
  expect(pair.app.maxAttachmentBytes).toBeLessThan(16_384)
  h.hibernate()
  await h.send(pair.app, ack(64n, 64n))
  await h.send(pair.desktop, ack(64n, 64n))
  expect(h.runtime.nextDeadline).toBeUndefined()
})

test('a missing native peer is closed on restore, and incompatible attachments cannot resume', async () => {
  const h = durableFixture()
  const host = await h.listen()
  const pair = await h.pair(host)
  pair.desktop.readyState = 3 // The native close won the race with the callback.
  h.hibernate()
  expect(pair.app.reason).toBe('RELAY_UNAVAILABLE')
  expect(h.runtime.getStats().sessions).toBe(0)
  host.socket.attachment = { v: 999 }
  h.hibernate()
  expect(h.runtime.reserveUpgrade()).toBe(503)
  expect(h.events.find(({ event }) => event === 'restore_failed')?.fields).toMatchObject({
    cause: 'Invalid socket attachment',
  })
  for (const socket of h.sockets) h.close(socket)
  expect(h.runtime.reserveUpgrade()).toBeUndefined()
  const next = await h.listen(host.hostKey)
  expect(next.info.targetId).toBe(host.info.targetId)
  expect(next.info.ownerEpoch).not.toBe(host.info.ownerEpoch)
})

test('diagnostics correlate sessions across hibernation without closing the listener or logging credentials', async () => {
  const h = durableFixture()
  const host = await h.listen()
  const pair = await h.pair(host)
  h.hibernate()
  h.close(pair.app)
  expect(h.events.find(({ event }) => event === 'session_closed')?.fields).toMatchObject({
    sessionId: pair.offer.sessionId,
    ownerEpoch: host.info.ownerEpoch,
    listenerOnline: true,
  })
  expect(host.socket.readyState).toBe(1)
  expect(host.socket.control('session_closed').sessionId).toBe(pair.offer.sessionId)
  const next = await h.pair(host)
  await h.send(next.app, data())
  expect(next.desktop.inbox).toContainEqual(data())
  expect(
    h.events.filter(({ event, fields }) => event === 'socket_closing' && fields.state === 'listener'),
  ).toEqual([])
  expect(h.events.filter(({ event }) => event === 'runtime_ready')).toHaveLength(2)
  const logs = JSON.stringify(h.events)
  for (const secret of [host.hostKey, pair.offer.ticket, next.offer.ticket])
    expect(logs).not.toContain(secret)
})

test('diagnostics identify the listener blocking admission and the receipt timeout', async () => {
  const h = durableFixture({ stallMs: 100 })
  const host = await h.listen()
  const admitted = h.events.find(({ event }) => event === 'listener_admitted')?.fields
  expect((await h.open({ v: 1, type: 'listen', hostKey: host.hostKey })).reason).toBe('TARGET_BUSY')
  expect(h.events.find(({ event }) => event === 'listener_rejected')?.fields).toMatchObject({
    reason: 'TARGET_BUSY',
    activeConnectionId: admitted?.connectionId,
  })
  const stalled = await h.open({ v: 1, type: 'listen', hostKey: 'cd'.repeat(32) }, false)
  h.hibernate()
  h.advance(101)
  expect(stalled.reason).toBe('STALLED')
  expect(
    h.events.find(({ event, fields }) => event === 'socket_closing' && fields.reason === 'STALLED')?.fields,
  ).toMatchObject({
    state: 'listener',
    receiptDeadline: 1_000_100,
  })
  expect(host.socket.readyState).toBe(1)
})

test('checkpoint errors keep connection context but never include exception text or attachments', async () => {
  const h = durableFixture()
  const host = await h.listen()
  const privateText = `hostKey=${host.hostKey}; verificationCode=123456`
  host.socket.serializeAttachment = () => {
    throw new Error(privateText)
  }
  await expect(h.send(host.socket, 'not JSON')).rejects.toThrow(privateText)
  const failure = h.events.find(({ event }) => event === 'checkpoint_failed')?.fields
  expect(failure).toMatchObject({
    connectionId: h.events.find(({ event }) => event === 'listener_admitted')?.fields.connectionId,
    cause: 'UNCLASSIFIED',
  })
  const logs = JSON.stringify(h.events)
  for (const secret of [host.hostKey, '123456', 'verificationCode']) expect(logs).not.toContain(secret)
})
