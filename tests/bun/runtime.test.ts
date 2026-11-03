import { afterEach, expect, test } from 'bun:test'

import { decodeFrame, encodeFrame, type RelayOffer } from '@cherrystudio/relay-protocol'

import type { RuntimeConfig } from '../../src/config.js'
import { runtimeFixture, until } from './fixture.js'

const fixtures: ReturnType<typeof runtimeFixture>[] = []
function fixture(config: Partial<RuntimeConfig> = {}) {
  const result = runtimeFixture({ config })
  fixtures.push(result)
  return result
}
afterEach(async () => {
  for (const item of fixtures.splice(0)) await item.dispose()
})

const data = (seq = 1n, size = 4) =>
  encodeFrame({
    type: 'data',
    seq,
    cumulativeBytes: seq * BigInt(size),
    payload: new Uint8Array(size).fill(7),
  })
const ack = (seq = 1n, bytes = seq * 4n) => encodeFrame({ type: 'ack', seq, cumulativeBytes: bytes })
const attachment = (offer: RelayOffer) => ({
  v: 1 as const,
  type: 'attach' as const,
  sessionId: offer.sessionId,
  ownerEpoch: offer.ownerEpoch,
  ticket: offer.ticket,
})

test('real sockets rendezvous, forward original DATA/ACK, and keep the listener after session close', async () => {
  const h = fixture()
  const host = await h.listen()
  const pair = await h.pair(host)
  await pair.ready()
  expect(h.runtime.getStats().activeSessions).toBe(1)
  pair.app.send(data())
  expect(await pair.desktop.binary()).toEqual(data())
  pair.desktop.send(ack())
  expect(await pair.app.binary()).toEqual(ack())
  pair.desktop.send(data())
  expect(await pair.app.binary()).toEqual(data())
  pair.app.send(ack())
  expect(await pair.desktop.binary()).toEqual(ack())
  pair.app.send(encodeFrame({ type: 'close', reason: 'NORMAL' }))
  expect(decodeFrame(await pair.desktop.binary())).toEqual({ type: 'close', reason: 'NORMAL' })
  expect((await host.peer.control('session_closed')).reason).toBe('NORMAL')
  await until(() => h.runtime.getStats().connections === 1)
  expect(h.runtime.getStats()).toMatchObject({
    activeSessions: 0,
    pendingSessions: 0,
    targets: 1,
    bufferBytes: 0,
  })
  expect(host.peer.socket.readyState).toBe(WebSocket.OPEN)
  expect(pair.app.socket.extensions).toBe('')
})

test('wrong-session, wrong-epoch, invalid and replayed tickets cannot replace an admitted peer', async () => {
  const h = fixture()
  const host = await h.listen()
  const request = await h.pending(host)
  for (const invalid of [
    { ...attachment(request.offer), ticket: 'ff'.repeat(32) },
    { ...attachment(request.offer), sessionId: 'another' },
    { ...attachment(request.offer), ownerEpoch: 'another' },
  ]) {
    const peer = await h.open(invalid)
    expect((await peer.closed).reason).toBe('INVALID_TICKET')
    expect(h.runtime.getStats().pendingSessions).toBe(1)
  }
  const desktop = await h.attach(request.offer)
  const replay = await h.open(attachment(request.offer))
  expect((await replay.closed).reason).toBe('INVALID_TICKET')
  const start = {
    v: 1 as const,
    type: 'start' as const,
    sessionId: request.offer.sessionId,
    ownerEpoch: request.offer.ownerEpoch,
  }
  request.app.send(start)
  desktop.send(start)
  await Promise.all([request.app.control('ready'), desktop.control('ready')])
  request.app.send(data())
  expect(await desktop.binary()).toEqual(data())
})

test('pending cancellation invalidates the offer, and late closes cannot erase a new session', async () => {
  const h = fixture()
  const host = await h.listen()
  const cancelled = await h.pending(host)
  cancelled.app.socket.terminate()
  await host.peer.control('session_closed')
  const late = await h.open(attachment(cancelled.offer))
  expect((await late.closed).reason).toBe('INVALID_TICKET')
  const next = await h.pair(host)
  await next.ready()
  cancelled.app.socket.close()
  late.socket.close()
  host.peer.send({ v: 1, type: 'cancel', sessionId: cancelled.offer.sessionId })
  next.app.send(data())
  expect(await next.desktop.binary()).toEqual(data())
  expect(h.runtime.getStats().activeSessions).toBe(1)
  expect(host.peer.socket.readyState).toBe(WebSocket.OPEN)
})

test('listener ownership is derived from its secret, survives reconnect and cannot be displaced', async () => {
  const h = fixture()
  const host = await h.listen()
  const duplicate = await h.open({ v: 1, type: 'listen', hostKey: host.hostKey })
  expect((await duplicate.closed).reason).toBe('TARGET_BUSY')
  const unrelated = await h.listen(host.info.targetId) // The public digest is not the preimage.
  expect(unrelated.info.targetId).not.toBe(host.info.targetId)
  const pair = await h.pair(host)
  await pair.ready()
  host.peer.socket.terminate()
  await host.peer.closed
  await until(() => h.runtime.getStats().connections === 3)
  const restored = await h.listen(host.hostKey)
  expect(restored.info.targetId).toBe(host.info.targetId)
  pair.app.send(data())
  expect(await pair.desktop.binary()).toEqual(data())
  const next = await h.pair(restored)
  await next.ready()
  expect(h.runtime.getStats().activeSessions).toBe(2)
})

test('waiting expiry and handshake deadlines reclaim sockets without expiring a healthy listener', async () => {
  const h = fixture({ handshakeMs: 80, rendezvousMs: 150 })
  const empty = await h.open()
  expect((await empty.closed).reason).toBe('CANCELLED')
  const host = await h.listen()
  const request = await h.pending(host)
  expect((await request.app.closed).reason).toBe('CANCELLED')
  expect((await host.peer.control('session_closed')).reason).toBe('CANCELLED')
  const expired = await h.open(attachment(request.offer))
  expect((await expired.closed).reason).toBe('INVALID_TICKET')
  await until(() => h.runtime.getStats().connections === 1)
  expect(h.runtime.getStats().targets).toBe(1)
  const pair = await h.pair(host)
  await pair.ready()
})

test('unexpected roles, early DATA, invalid frames and forged ACKs end only their own session', async () => {
  const h = fixture()
  const host = await h.listen()
  const early = await h.pair(host)
  early.app.send(data())
  expect((await early.desktop.closed).reason).toBe('PROTOCOL_ERROR')
  await host.peer.control('session_closed')
  for (const frame of [ack(), data(2n), new Uint8Array([1, 2]), new Uint8Array(70_000)]) {
    const pair = await h.pair(host)
    await pair.ready()
    pair.app.send(frame)
    await pair.app.closed
    await pair.desktop.closed
    await host.peer.control('session_closed')
    expect(h.runtime.getStats().activeSessions).toBe(0)
    expect(host.peer.socket.readyState).toBe(WebSocket.OPEN)
  }
  const wrongRole = await h.open({ v: 1, type: 'start', sessionId: 'absent', ownerEpoch: 'epoch' })
  expect((await wrongRole.closed).reason).toBe('PROTOCOL_ERROR')
})

test('a slow consumer gets no unlimited credit: excess DATA and missing ACKs are closed', async () => {
  const h = fixture({ limits: { maxFrameBytes: 4, windowBytes: 8, maxInFlightFrames: 2 }, stallMs: 100 })
  const host = await h.listen()
  const overflow = await h.pair(host)
  await overflow.ready()
  overflow.app.send(data(1n))
  overflow.app.send(data(2n))
  overflow.app.send(data(3n))
  expect((await overflow.app.closed).reason).toBe('PROTOCOL_ERROR')
  await host.peer.control('session_closed')
  const stalled = await h.pair(host)
  await stalled.ready()
  stalled.app.send(data())
  expect((await stalled.desktop.closed).reason).toBe('STALLED')
  await until(() => h.runtime.getStats().connections === 1)
  expect(h.runtime.getStats().bufferBytes).toBe(0)
})

test('instance/session capacity and frame rates reject work and recover after teardown', async () => {
  const h = fixture({ maxConnections: 4, maxSessions: 1, maxSessionsPerTarget: 1 })
  const host = await h.listen()
  const pair = await h.pair(host)
  await pair.ready()
  const excess = await h.open({ v: 1, type: 'connect', targetId: host.info.targetId })
  expect((await excess.closed).reason).toBe('RESOURCE_EXHAUSTED')
  await until(() => h.runtime.getStats().connections === 3)
  const idle = await h.open()
  await expect(h.open()).rejects.toThrow()
  expect(h.runtime.getStats().rejectedConnections).toBe(1)
  idle.socket.terminate()
  pair.app.socket.terminate()
  await host.peer.control('session_closed')
  await until(() => h.runtime.getStats().connections === 1)
  await (await h.pair(host)).ready()

  const limited = fixture({ framesPerSecond: 3 })
  const listener = await limited.listen()
  const active = await limited.pair(listener)
  await active.ready()
  active.app.send(data(1n))
  active.app.send(data(2n))
  expect((await active.app.closed).reason).toBe('RESOURCE_EXHAUSTED')
  expect(limited.runtime.getStats().rateRejections).toBe(1)
})

test('restart discards old tickets/epoch while retained host information restores the same target', async () => {
  const old = fixture()
  const host = await old.listen()
  const request = await old.pending(host)
  await old.runtime.stop(0)
  const fresh = fixture()
  const restored = await fresh.listen(host.hostKey)
  expect(restored.info.targetId).toBe(host.info.targetId)
  expect(restored.info.ownerEpoch).not.toBe(host.info.ownerEpoch)
  const stale = await fresh.open(attachment(request.offer))
  expect((await stale.closed).reason).toBe('INVALID_TICKET')
  const pair = await fresh.pair(restored)
  await pair.ready()
  pair.app.send(data())
  expect(await pair.desktop.binary()).toEqual(data())
})

test('draining rejects new work, preserves ready streams and forcibly ends them at the deadline', async () => {
  const h = fixture()
  const host = await h.listen()
  const pair = await h.pair(host)
  await pair.ready()
  h.runtime.beginDrain()
  const http = `http://127.0.0.1:${h.runtime.server.port}`
  expect((await fetch(`${http}/healthz`)).status).toBe(200)
  expect((await fetch(`${http}/readyz`)).status).toBe(503)
  expect((await fetch(`${http}/v1/relay?ticket=not-accepted`)).status).toBe(400)
  await expect(h.open()).rejects.toThrow()
  pair.app.send(data())
  expect(await pair.desktop.binary()).toEqual(data())
  await h.runtime.stop(50)
  expect(h.runtime.getStats()).toMatchObject({
    connections: 0,
    targets: 0,
    pendingSessions: 0,
    activeSessions: 0,
    bufferBytes: 0,
  })
  expect(h.runtime.server.pendingWebSockets).toBe(0)
})

test('repeated real connection cycles reclaim maps, timers and all buffer accounting', async () => {
  const h = fixture({ connectionsPerSecond: 1000 })
  const host = await h.listen()
  for (let i = 0; i < 12; i++) {
    const pair = await h.pair(host)
    await pair.ready()
    pair.app.send(data())
    await pair.desktop.binary()
    pair.desktop.socket.terminate()
    await host.peer.control('session_closed')
    await until(() => h.runtime.getStats().connections === 1)
    expect(h.runtime.getStats()).toMatchObject({ activeSessions: 0, pendingSessions: 0, bufferBytes: 0 })
  }
  host.peer.socket.terminate()
  await until(() => h.runtime.getStats().connections === 0)
  expect(h.runtime.getStats()).toMatchObject({ targets: 0, sessionsCreated: 12, sessionsClosed: 12 })
})

test('a paused real TCP reader cannot grow the native and JS output buffers without bound', async () => {
  const h = fixture({
    maxSocketBufferBytes: 70_000,
    bytesPerSecond: 128 * 1024 * 1024,
    totalBytesPerSecond: 256 * 1024 * 1024,
  })
  const host = await h.listen()
  const pair = await h.pair(host)
  await pair.ready()
  pair.desktop.socket.pause()
  let sawBackpressure = false
  for (let seq = 1n; seq <= 2048n && h.runtime.getStats().activeSessions; seq++) {
    const frame = data(seq, 65_536)
    const sentBefore = BigInt(h.runtime.getStats().sentBinaryBytes)
    pair.app.send(frame)
    await until(() => {
      const stats = h.runtime.getStats()
      return (
        !stats.activeSessions ||
        stats.queuedBytes > 0 ||
        BigInt(stats.sentBinaryBytes) >= sentBefore + BigInt(frame.byteLength)
      )
    })
    const stats = h.runtime.getStats()
    sawBackpressure ||= stats.nativeBytes > 0 || stats.queuedBytes > 0
    expect(stats.bufferBytes).toBeLessThanOrEqual(h.runtime.config.maxTotalBufferBytes)
    expect(stats.nativeBytes + stats.queuedBytes).toBeLessThanOrEqual(
      2 * h.runtime.config.maxSocketBufferBytes,
    )
    if (!stats.activeSessions) break
    if (stats.queuedBytes) {
      pair.app.send(data(seq + 1n, 65_536))
      pair.app.send(data(seq + 2n, 65_536))
      break
    }
    // Malicious receiver returns credit without reading; this must not bypass native buffer limits.
    pair.desktop.send(ack(seq, seq * 65_536n))
    expect(decodeFrame(await pair.app.binary()).type).toBe('ack')
  }
  expect(sawBackpressure).toBe(true)
  expect((await pair.app.closed).reason).toBe('RESOURCE_EXHAUSTED')
  pair.desktop.socket.terminate()
  await until(() => h.runtime.getStats().connections === 1)
  expect(h.runtime.getStats()).toMatchObject({ bufferBytes: 0, activeSessions: 0, rateRejections: 0 })
})
