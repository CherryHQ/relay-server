import {
  defaultRelayLimits,
  frameHeaderBytes,
  type RelayLimits,
  validateRelayLimits,
} from '@cherrystudio/relay-protocol'

export interface RuntimeConfig {
  readonly limits: RelayLimits
  readonly maxConnections: number
  readonly maxTargets: number
  readonly maxSessions: number
  readonly maxSessionsPerTarget: number
  readonly maxSocketBufferBytes: number
  readonly maxTotalBufferBytes: number
  readonly maxQueueItems: number
  readonly connectionsPerSecond: number
  readonly framesPerSecond: number
  readonly totalFramesPerSecond: number
  readonly bytesPerSecond: number
  readonly totalBytesPerSecond: number
  readonly handshakeMs: number
  readonly rendezvousMs: number
  readonly stallMs: number
  readonly closeGraceMs: number
  readonly drainMs: number
}

export const defaultRuntimeConfig: Readonly<RuntimeConfig> = Object.freeze({
  limits: defaultRelayLimits,
  maxConnections: 512,
  maxTargets: 128,
  maxSessions: 128,
  maxSessionsPerTarget: 8,
  maxSocketBufferBytes: 1024 * 1024,
  maxTotalBufferBytes: 16 * 1024 * 1024,
  maxQueueItems: 1024,
  connectionsPerSecond: 100,
  framesPerSecond: 4096,
  totalFramesPerSecond: 32_768,
  bytesPerSecond: 8 * 1024 * 1024,
  totalBytesPerSecond: 32 * 1024 * 1024,
  handshakeMs: 5000,
  rendezvousMs: 15_000,
  stallMs: 15_000,
  closeGraceMs: 1000,
  drainMs: 10_000,
})

export function runtimeConfig(overrides: Partial<RuntimeConfig> = {}): Readonly<RuntimeConfig> {
  const result = {
    ...defaultRuntimeConfig,
    ...overrides,
    limits: validateRelayLimits(overrides.limits ?? defaultRelayLimits),
  }
  for (const [key, value] of Object.entries(result)) {
    if (
      key !== 'limits' &&
      (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 2 ** 31 - 1)
    ) {
      throw new Error(`Invalid runtime configuration: ${key}`)
    }
  }
  if (
    result.maxSocketBufferBytes < Math.max(result.limits.maxFrameBytes + frameHeaderBytes + 10, 4096) ||
    result.maxTotalBufferBytes < result.maxSocketBufferBytes
  ) {
    throw new Error('Buffer budgets must accommodate a frame and control messages')
  }
  if (
    result.bytesPerSecond < result.limits.maxFrameBytes + frameHeaderBytes ||
    result.totalBytesPerSecond < result.bytesPerSecond
  ) {
    throw new Error('Byte rate must accommodate a frame')
  }
  return Object.freeze(result)
}

/** Environment parsing stays outside the portable session code. No implicit platform globals. */
export function readEnvironment(env: Record<string, string | undefined>) {
  const number = (name: string, fallback: number, min = 1, max = 2 ** 31 - 1): number => {
    const value = env[name]
    if (value === undefined) return fallback
    if (
      !/^\d+$/.test(value) ||
      !Number.isSafeInteger(Number(value)) ||
      Number(value) < min ||
      Number(value) > max
    )
      throw new Error(`Invalid ${name}`)
    return Number(value)
  }
  const overrides: Record<string, number> = {}
  for (const [key, value] of Object.entries(defaultRuntimeConfig)) {
    if (typeof value !== 'number') continue
    const name = `RELAY_${key.replace(/[A-Z]/g, (char) => `_${char}`).toUpperCase()}`
    overrides[key] = number(name, value)
  }
  const hostname = env.RELAY_HOST ?? '127.0.0.1'
  if (!hostname || /[\s/]/.test(hostname)) throw new Error('Invalid RELAY_HOST')
  const certFile = env.RELAY_TLS_CERT
  const keyFile = env.RELAY_TLS_KEY
  if (Boolean(certFile) !== Boolean(keyFile))
    throw new Error('Configure both RELAY_TLS_CERT and RELAY_TLS_KEY')
  return {
    hostname,
    port: number('RELAY_PORT', 8787, 0, 65535),
    certFile,
    keyFile,
    config: runtimeConfig(overrides),
  }
}
