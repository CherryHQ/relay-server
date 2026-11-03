import { deepStrictEqual } from 'node:assert'
import { cpus, release } from 'node:os'

import {
  acceptSecureChannel,
  connectSecureChannel,
  createDeviceIdentity,
  deviceIdentityId,
} from '@cherrystudio/remote-transport'
import { defaultLogger } from '@libp2p/logger'

import { createWssHarness } from '../harness/wss.js'

// Diagnostic loopback baseline, deliberately outside CI assertions. No comparative speedup claim.
const warmup = 3
const samples = 20
const cases = [
  { name: 'small-json', value: { message: 'x'.repeat(32) } },
  { name: '32KiB-json', value: { message: 'x'.repeat(32 * 1024) } },
  {
    name: '1MiB-upload',
    value: {
      kind: 'upload',
      requestId: 'benchmark',
      uploadId: 'benchmark',
      writerEpoch: '1',
      offset: '0',
      bytes: Uint8Array.from({ length: 1024 * 1024 }, (_, index) => index % 251),
    },
  },
]
const results = []
for (let trial = 1; trial <= 3; trial++) {
  const harness = await createWssHarness()
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
    const echo = async (value: unknown) => {
      const start = performance.now()
      const [request] = await Promise.all([server.read(), client.write(value)])
      const [response] = await Promise.all([client.read(), server.write(request)])
      const elapsed = performance.now() - start
      deepStrictEqual(response, value)
      return elapsed
    }
    for (const item of cases) {
      for (let i = 0; i < warmup; i++) await echo(item.value)
      const initialCpu = process.cpuUsage()
      const initialWire = harness.stats.wireBytes
      const durations: number[] = []
      let observedRssBytes = 0
      for (let i = 0; i < samples; i++) {
        durations.push(await echo(item.value))
        observedRssBytes = Math.max(observedRssBytes, process.memoryUsage().rss)
      }
      const cpu = process.cpuUsage(initialCpu)
      durations.sort((a, b) => a - b)
      const percentile = (p: number) => durations[Math.ceil(p * durations.length) - 1]
      results.push({
        trial,
        case: item.name,
        roundTripMs: { p50: percentile(0.5), p95: percentile(0.95), p99: percentile(0.99) },
        cpuMicros: cpu,
        wireBytes: harness.stats.wireBytes - initialWire,
        observedRssBytes,
      })
    }
    client.abort(new Error('Benchmark finished'))
    server.abort(new Error('Benchmark finished'))
  } finally {
    controller.abort()
    await harness.dispose()
  }
}
console.log(
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      bun: Bun.version,
      platform: process.platform,
      arch: process.arch,
      osRelease: release(),
      cpu: cpus()[0]?.model,
      remoteTransport: '0.2.5',
      warmup,
      samples,
      trials: 3,
      conditions:
        'One process, TLS loopback, real Noise, sequential echo, default Relay limits, no compression or delayed batching. RSS samples include both peers and harness, not an isolated runtime peak. CPU includes validation. p99 from only 20 samples is a diagnostic maximum, not a tail-latency claim.',
      results,
    },
    null,
    2,
  ),
)
