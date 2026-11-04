import { type RuntimeConfig, runtimeConfig } from '../config.js'

export function cloudflareConfig(overrides: Partial<RuntimeConfig> = {}): Readonly<RuntimeConfig> {
  const config = runtimeConfig({
    maxConnections: 128,
    maxTargets: 32,
    maxSessions: 32,
    ...overrides,
    limits: overrides.limits ?? { maxFrameBytes: 65_536, windowBytes: 262_144, maxInFlightFrames: 64 },
  })
  // A whole session's metadata must fit the 16 KiB WebSocket attachment, even with tiny DATA frames.
  if (
    config.limits.maxInFlightFrames > 64 ||
    config.maxConnections > 128 ||
    config.maxSessions > 32 ||
    config.maxTotalBufferBytes > 16 * 1024 * 1024 ||
    config.maxSocketBufferBytes < 8192 ||
    config.maxQueueItems < 4
  )
    throw new Error('Cloudflare resource envelope exceeded')
  return config
}
