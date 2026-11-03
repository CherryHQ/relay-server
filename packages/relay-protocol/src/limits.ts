import { RelayProtocolError } from './errors.js'

export const relayVersion = 1 as const
export const frameHeaderBytes = 24
export const maxDataBytes = 65_536
export const maxCloseBytes = 256
export const maxControlBytes = 65_536
export const maxUint64 = (1n << 64n) - 1n

export interface RelayLimits {
  readonly maxFrameBytes: number
  readonly windowBytes: number
  readonly maxInFlightFrames: number
}

export const defaultRelayLimits: Readonly<RelayLimits> = Object.freeze({
  maxFrameBytes: maxDataBytes,
  windowBytes: 256 * 1024,
  maxInFlightFrames: 1024,
})

/** R1 peers may tighten these limits, but cannot expand the version's resource envelope. */
export function validateRelayLimits(limits: RelayLimits): Readonly<RelayLimits> {
  for (const key of ['maxFrameBytes', 'windowBytes', 'maxInFlightFrames'] as const) {
    if (!Number.isSafeInteger(limits[key]) || limits[key] < 1 || limits[key] > defaultRelayLimits[key]) {
      throw new RelayProtocolError(`Invalid relay limit: ${key}`)
    }
  }
  if (limits.windowBytes < limits.maxFrameBytes) {
    throw new RelayProtocolError('The receive window must fit one frame')
  }
  return Object.freeze({
    maxFrameBytes: limits.maxFrameBytes,
    windowBytes: limits.windowBytes,
    maxInFlightFrames: limits.maxInFlightFrames,
  })
}
