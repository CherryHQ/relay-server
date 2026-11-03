import { RelayProtocolError } from './errors.js'
import { maxControlBytes, type RelayLimits, relayVersion, validateRelayLimits } from './limits.js'

export interface RelayReady {
  readonly v: 1
  readonly type: 'ready'
  readonly sessionId: string
  readonly ownerEpoch: string
  readonly limits: Readonly<RelayLimits>
}

function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).length !== keys.length ||
    !keys.every((key) => Object.hasOwn(value, key))
  ) {
    throw new RelayProtocolError('Invalid ready message shape')
  }
  return value as Record<string, unknown>
}

/** Shape validation only. The connection owner must also match the authenticated session selection. */
export function parseRelayReady(json: string): RelayReady {
  if (json.length > maxControlBytes || new TextEncoder().encode(json).byteLength > maxControlBytes) {
    throw new RelayProtocolError('Control message is too large')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    throw new RelayProtocolError('Invalid control JSON')
  }
  const value = record(parsed, ['v', 'type', 'sessionId', 'ownerEpoch', 'limits'])
  if (value.v !== relayVersion || value.type !== 'ready')
    throw new RelayProtocolError('Unsupported ready message')
  for (const key of ['sessionId', 'ownerEpoch'] as const) {
    if (typeof value[key] !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(value[key])) {
      throw new RelayProtocolError(`Invalid ${key}`)
    }
  }
  const limits = record(value.limits, ['maxFrameBytes', 'windowBytes', 'maxInFlightFrames'])
  if (Object.values(limits).some((item) => typeof item !== 'number')) {
    throw new RelayProtocolError('Invalid ready limits')
  }
  return {
    v: relayVersion,
    type: 'ready',
    sessionId: value.sessionId as string,
    ownerEpoch: value.ownerEpoch as string,
    limits: validateRelayLimits(limits as unknown as RelayLimits),
  }
}

export function assertReadyMatches(ready: RelayReady, expected: Omit<RelayReady, 'v' | 'type'>): void {
  if (
    ready.sessionId !== expected.sessionId ||
    ready.ownerEpoch !== expected.ownerEpoch ||
    ready.limits.maxFrameBytes !== expected.limits.maxFrameBytes ||
    ready.limits.windowBytes !== expected.limits.windowBytes ||
    ready.limits.maxInFlightFrames !== expected.limits.maxInFlightFrames
  ) {
    throw new RelayProtocolError('Ready does not match the authenticated session')
  }
}
