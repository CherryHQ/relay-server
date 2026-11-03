import { expect, test } from 'bun:test'

import {
  acceptSecureChannel,
  connectSecureChannel,
  createDeviceIdentity,
  deviceIdentityId,
} from '@cherrystudio/remote-transport'
import { defaultLogger } from '@libp2p/logger'

import { createWssHarness } from './wss.js'

test('published Noise transport exchanges bidirectional records through real WSS and fragmented DATA', async () => {
  const harness = await createWssHarness({ maxFrameBytes: 1024, windowBytes: 8192, maxInFlightFrames: 64 })
  const controller = new AbortController()
  try {
    const [desktop, mobile] = await harness.pair()
    if (!desktop || !mobile) throw new Error('Expected both peers')
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
      id: 'opaque-test',
      method: 'test.echo',
      params: { data: '字'.repeat(12_000) },
    }
    const response = { jsonrpc: '2.0', id: 'opaque-test', result: { data: 'reply'.repeat(8000) } }
    const readServer = server.read()
    const readClient = client.read()
    await Promise.all([client.write(request), server.write(response)])
    expect(await readServer).toEqual(request)
    expect(await readClient).toEqual(response)
    const upload = {
      kind: 'upload',
      requestId: 'upload-request',
      uploadId: 'upload-test',
      writerEpoch: '1',
      offset: '0',
      bytes: Uint8Array.from({ length: 1024 * 1024 }, (_, index) => index % 251),
    }
    const [receivedUpload] = await Promise.all([server.read(), client.write(upload)])
    expect(receivedUpload).toEqual(upload)
    expect(harness.stats.dataFrames).toBeGreaterThan(64)
    expect(harness.stats.ackFrames).toBeGreaterThan(0)
    expect(harness.stats.maxPayloadBytes).toBeLessThanOrEqual(1024)
    client.abort(new Error('Test finished'))
    server.abort(new Error('Test finished'))
  } finally {
    controller.abort()
    await harness.dispose()
  }
})

test('WSS reachability and Relay ready do not override the pinned Noise identity', async () => {
  const harness = await createWssHarness()
  const controller = new AbortController()
  try {
    const [desktop, mobile] = await harness.pair()
    if (!desktop || !mobile) throw new Error('Expected both peers')
    const [desktopKey, mobileKey, unrelatedKey] = await Promise.all([
      createDeviceIdentity(),
      createDeviceIdentity(),
      createDeviceIdentity(),
    ])
    const options = { logger: defaultLogger(), protocolVersions: [1], signal: controller.signal }
    const results = await Promise.allSettled([
      acceptSecureChannel(desktop, { ...options, identity: desktopKey }),
      connectSecureChannel(mobile, {
        ...options,
        identity: mobileKey,
        remoteIdentity: deviceIdentityId(unrelatedKey),
      }),
    ])
    expect(results[1]?.status).toBe('rejected')
    expect(mobile.status).toBe('aborted')
    for (const result of results)
      if (result.status === 'fulfilled') result.value.abort(new Error('Test finished'))
  } finally {
    controller.abort()
    await harness.dispose()
  }
})
