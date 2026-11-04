import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { attachRelayStream, connectRelayStream } from '@cherrystudio/relay-client'
import { decodeFrame, encodeFrame, type RelayOffer } from '@cherrystudio/relay-protocol'
import {
  acceptSecureChannel,
  connectSecureChannel,
  createDeviceIdentity,
  deviceIdentityId,
} from '@cherrystudio/remote-transport'
import { defaultLogger } from '@libp2p/logger'

import { RawPeer } from '../tests/bun/fixture.js'
import { smokeRelay } from './smoke-relay.js'

const temporary = await mkdtemp(join(tmpdir(), 'relay-cloudflare-'))
let hostProcess: ReturnType<typeof Bun.spawn> | undefined
const peers: RawPeer[] = []
const controllers: AbortController[] = []
try {
  const build = await Bun.build({
    entrypoints: [resolve('tests/cloudflare/native.worker.ts')],
    outdir: temporary,
    target: 'browser',
    format: 'esm',
    external: ['cloudflare:workers'],
  })
  if (!build.success) throw new AggregateError(build.logs, 'Worker test build failed')
  const child = Bun.spawn(['node', 'scripts/cloudflare-host.mjs', join(temporary, 'native.worker.js')], {
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'inherit',
  })
  hostProcess = child
  const reader = child.stdout.pipeThrough(new TextDecoderStream()).getReader()
  let pending = ''
  const read = async (): Promise<Record<string, unknown>> => {
    while (!pending.includes('\n')) {
      const chunk = await reader.read()
      if (chunk.done) throw new Error('Cloudflare test host ended unexpectedly')
      pending += chunk.value
    }
    const end = pending.indexOf('\n')
    const result = JSON.parse(pending.slice(0, end))
    pending = pending.slice(end + 1)
    if (result.error) throw new Error(result.error)
    return result
  }
  const receive = async () => {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        read(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('Cloudflare test host timed out')), 30_000)
        }),
      ])
    } finally {
      clearTimeout(timer)
    }
  }
  const command = async (type: string) => {
    child.stdin.write(`${JSON.stringify({ type })}\n`)
    await child.stdin.flush()
    return receive()
  }
  const url = new URL('/v1/relay', String((await receive()).url))
  const origin = url.origin
  url.protocol = 'ws:'
  console.log(await smokeRelay(url.href))
  const owner = { inspect: () => command('inspect') }
  const evict = async () => {
    const before = await owner.inspect()
    const after = await command('evict')
    assert.notEqual(after.bootId, before.bootId, 'DO constructor did not rerun')
    assert.equal(after.ownerEpoch, before.ownerEpoch, 'Hibernation changed the owner epoch')
    assert.equal(after.sessions, before.sessions)
  }
  const open = async (message: Parameters<RawPeer['send']>[0]) => {
    const peer = new RawPeer(url.href)
    peers.push(peer)
    await peer.opened
    peer.send(message)
    return peer
  }
  const host = await open({ v: 1, type: 'listen', hostKey: randomBytes(32).toString('hex') })
  const listening = await host.control('listening')
  await evict()
  const app = await open({ v: 1, type: 'connect', targetId: listening.targetId })
  await app.control('pending')
  const offer = await host.control('offer')
  await evict()
  const attach = (selected: RelayOffer) =>
    open({
      v: 1,
      type: 'attach',
      sessionId: selected.sessionId,
      ownerEpoch: selected.ownerEpoch,
      ticket: selected.ticket,
    })
  const desktop = await attach(offer)
  await desktop.control('pending')
  const start = {
    v: 1 as const,
    type: 'start' as const,
    sessionId: offer.sessionId,
    ownerEpoch: offer.ownerEpoch,
  }
  app.send(start)
  // Let the App's start be handled before forcing eviction in the partial-start state.
  await new Promise((resolve) => setTimeout(resolve, 30))
  await evict()
  const replay = await attach(offer)
  assert.equal((await replay.closed).reason, 'INVALID_TICKET')
  desktop.send(start)
  await Promise.all([app.control('ready'), desktop.control('ready')])
  const data = encodeFrame({ type: 'data', seq: 1n, cumulativeBytes: 65_536n, payload: randomBytes(65_536) })
  app.send(data)
  assert.deepEqual(await desktop.binary(), data)
  await evict()
  desktop.send(encodeFrame({ type: 'ack', seq: 1n, cumulativeBytes: 65_536n }))
  assert.equal(decodeFrame(await app.binary()).type, 'ack')
  app.send(encodeFrame({ type: 'data', seq: 2n, cumulativeBytes: 65_540n, payload: new Uint8Array(4) }))
  assert.equal(decodeFrame(await desktop.binary()).type, 'data')
  desktop.send(encodeFrame({ type: 'ack', seq: 2n, cumulativeBytes: 65_540n }))
  await app.binary()
  await evict()
  desktop.send(encodeFrame({ type: 'ack', seq: 3n, cumulativeBytes: 65_544n }))
  assert.equal((await app.closed).reason, 'PROTOCOL_ERROR')
  await host.control('session_closed')
  console.log(
    'Native hibernation: listener, partial rendezvous, consumed ticket, DATA/ACK counters and forged ACK rejection passed',
  )

  const controller = new AbortController()
  controllers.push(controller)
  const options = {
    origin,
    allowLoopbackHttp: true,
    createSocket: (address: string) => new WebSocket(address),
    signal: controller.signal,
    log: defaultLogger().forComponent('cloudflare-noise'),
  }
  const appStreamPromise = connectRelayStream(listening.targetId, options)
  const nextOffer = await host.control('offer')
  const [appStream, desktopStream] = await Promise.all([
    appStreamPromise,
    attachRelayStream(nextOffer, options),
  ])
  const [desktopKey, appKey] = await Promise.all([createDeviceIdentity(), createDeviceIdentity()])
  const noise = { logger: defaultLogger(), protocolVersions: [1], signal: controller.signal }
  const [server, client] = await Promise.all([
    acceptSecureChannel(desktopStream, { ...noise, identity: desktopKey }),
    connectSecureChannel(appStream, {
      ...noise,
      identity: appKey,
      remoteIdentity: deviceIdentityId(desktopKey),
    }),
  ])
  const request = { jsonrpc: '2.0', id: 'before', method: 'test.echo', params: { data: 'before sleep' } }
  const [received] = await Promise.all([server.read(), client.write(request)])
  assert.deepEqual(received, request)
  await evict()
  const upload = {
    kind: 'upload',
    requestId: 'upload-request',
    uploadId: 'upload-test',
    writerEpoch: '1',
    offset: '0',
    bytes: randomBytes(1024 * 1024),
  }
  const [receivedUpload] = await Promise.all([server.read(), client.write(upload)])
  assert.deepEqual(receivedUpload, { ...upload, bytes: new Uint8Array(upload.bytes) })
  const reply = { jsonrpc: '2.0', id: 'after', result: 'same Noise channel after hibernation' }
  const [receivedReply] = await Promise.all([client.read(), server.write(reply)])
  assert.deepEqual(receivedReply, reply)
  client.abort(new Error('Test finished'))
  server.abort(new Error('Test finished'))
  console.log(
    'Native hibernation: existing Noise channel continued; 1 MiB encrypted upload and reverse reply passed',
  )
  const idle = new RawPeer(url.href)
  peers.push(idle)
  await idle.opened
  await evict()
  let deadline: ReturnType<typeof setTimeout> | undefined
  try {
    const closed = await Promise.race([
      idle.closed,
      new Promise<never>((_resolve, reject) => {
        deadline = setTimeout(() => reject(new Error('Hibernated handshake alarm did not fire')), 8000)
      }),
    ])
    assert.equal(closed.reason, 'CANCELLED')
    assert.equal(host.socket.readyState, WebSocket.OPEN)
  } finally {
    clearTimeout(deadline)
  }
  console.log('Native alarm: hibernated handshake expired while healthy listener stayed connected')
  for (const peer of peers) peer.socket.terminate()
  controller.abort()
  let stats = await owner.inspect()
  for (let attempt = 0; attempt < 50 && stats.connections; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 20))
    stats = await owner.inspect()
  }
  assert.equal(stats.connections, 0)
  assert.equal(stats.bufferBytes, 0)
  assert.equal(stats.sessions, 0)
  console.log('Cloudflare workerd checks passed; all connections and output reservations reclaimed')
} finally {
  for (const controller of controllers) controller.abort()
  for (const peer of peers) peer.socket.terminate()
  if (hostProcess) {
    if (hostProcess.stdin && typeof hostProcess.stdin !== 'number') hostProcess.stdin.end()
    const timeout = setTimeout(() => hostProcess?.kill(), 5000)
    await hostProcess.exited
    clearTimeout(timeout)
  }
  await rm(temporary, { recursive: true, force: true })
}
