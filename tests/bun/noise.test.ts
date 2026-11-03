import { expect, test } from 'bun:test'

import { attachRelayStream, connectRelayStream } from '@cherrystudio/relay-client'
import {
  acceptSecureChannel,
  connectSecureChannel,
  createDeviceIdentity,
  deviceIdentityId,
} from '@cherrystudio/remote-transport'
import { defaultLogger } from '@libp2p/logger'

import { createTestTls } from '../harness/tls.js'
import { runtimeFixture, until } from './fixture.js'

test('production runtime completes real WSS rendezvous, Noise, bidirectional records and a 1 MiB upload', async () => {
  const tls = await createTestTls()
  const h = runtimeFixture({
    tls: tls.tls,
    ca: tls.tls.cert,
    config: { limits: { maxFrameBytes: 1024, windowBytes: 8192, maxInFlightFrames: 64 } },
  })
  const controller = new AbortController()
  try {
    const host = await h.listen()
    const connectionOptions = {
      origin: new URL(h.url).origin.replace(/^ws/, 'http'),
      createSocket: (url: string) =>
        new WebSocket(url, { perMessageDeflate: false, tls: { ca: tls.tls.cert } }),
      log: defaultLogger().forComponent('public-client'),
      signal: controller.signal,
    }
    const mobileConnection = connectRelayStream(host.info.targetId, connectionOptions)
    const offer = await host.peer.control('offer')
    const [desktop, mobile] = await Promise.all([
      attachRelayStream(offer, connectionOptions),
      mobileConnection,
    ])
    const [desktopKey, mobileKey] = await Promise.all([createDeviceIdentity(), createDeviceIdentity()])
    const options = { logger: defaultLogger(), protocolVersions: [1], signal: controller.signal }
    const [server, client] = await Promise.all([
      acceptSecureChannel(desktop, { ...options, identity: desktopKey }),
      connectSecureChannel(mobile, {
        ...options,
        identity: mobileKey,
        remoteIdentity: deviceIdentityId(desktopKey),
      }),
    ])
    expect(client.remoteIdentity).toBe(deviceIdentityId(desktopKey))
    expect(server.remoteIdentity).toBe(deviceIdentityId(mobileKey))
    const request = {
      jsonrpc: '2.0',
      id: 'runtime-test',
      method: 'test.echo',
      params: { text: '字'.repeat(12_000) },
    }
    const reply = { jsonrpc: '2.0', id: 'runtime-test', result: { text: 'reply'.repeat(8000) } }
    const [receivedRequest, receivedReply] = await Promise.all([
      server.read(),
      client.read(),
      client.write(request),
      server.write(reply),
    ])
    expect(receivedRequest).toEqual(request)
    expect(receivedReply).toEqual(reply)
    const upload = {
      kind: 'upload',
      requestId: 'request',
      uploadId: 'upload',
      writerEpoch: '1',
      offset: '0',
      bytes: Uint8Array.from({ length: 1024 * 1024 }, (_, index) => index % 251),
    }
    const [receivedUpload] = await Promise.all([server.read(), client.write(upload)])
    expect(receivedUpload).toEqual(upload)
    expect(BigInt(h.runtime.getStats().sentBinaryBytes)).toBeGreaterThan(1_048_576n)
    expect(h.runtime.getStats()).toMatchObject({ protocolErrors: 0, rateRejections: 0, activeSessions: 1 })
    client.abort(new Error('Test complete'))
    server.abort(new Error('Test complete'))
    await until(() => h.runtime.getStats().connections === 1)
    expect(h.runtime.getStats().bufferBytes).toBe(0)
  } finally {
    controller.abort()
    await h.dispose()
    await tls.dispose()
  }
})

test('runtime admission cannot override the pinned desktop Noise identity', async () => {
  const tls = await createTestTls()
  const h = runtimeFixture({ tls: tls.tls, ca: tls.tls.cert })
  const controller = new AbortController()
  try {
    const host = await h.listen()
    const pair = await h.pair(host)
    const [desktop, mobile] = await pair.streams()
    const [desktopKey, mobileKey, wrongKey] = await Promise.all([
      createDeviceIdentity(),
      createDeviceIdentity(),
      createDeviceIdentity(),
    ])
    const options = { logger: defaultLogger(), protocolVersions: [1], signal: controller.signal }
    const outcomes = await Promise.allSettled([
      acceptSecureChannel(desktop, { ...options, identity: desktopKey }),
      connectSecureChannel(mobile, {
        ...options,
        identity: mobileKey,
        remoteIdentity: deviceIdentityId(wrongKey),
      }),
    ])
    expect(outcomes[1]?.status).toBe('rejected')
    expect(mobile.status).toBe('aborted')
    for (const outcome of outcomes)
      if (outcome.status === 'fulfilled') outcome.value.abort(new Error('Test complete'))
    await until(() => h.runtime.getStats().activeSessions === 0)
  } finally {
    controller.abort()
    await h.dispose()
    await tls.dispose()
  }
})
