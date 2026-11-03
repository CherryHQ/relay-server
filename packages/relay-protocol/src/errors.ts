export class RelayProtocolError extends Error {
  override readonly name = 'RelayProtocolError'
}

export const closeReasons = [
  'NORMAL',
  'CANCELLED',
  'PROTOCOL_ERROR',
  'RESOURCE_EXHAUSTED',
  'STALLED',
  'RELAY_UNAVAILABLE',
] as const

export type CloseReason = (typeof closeReasons)[number]

export function isCloseReason(value: unknown): value is CloseReason {
  return typeof value === 'string' && closeReasons.some((reason) => reason === value)
}
