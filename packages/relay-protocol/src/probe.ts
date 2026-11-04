import { RelayProtocolError } from './errors.js'

/** Optional transport receipts. These grant no DATA credit and carry no business payload. */
export interface RelayProbe {
  readonly v: 1
  readonly type: 'probe' | 'probe_ack'
  readonly nonce: string
}

export function parseRelayProbe(json: string): RelayProbe | undefined {
  if (json.length > 4096) throw new RelayProtocolError('Oversized transport control')
  let value: unknown
  try {
    value = JSON.parse(json)
  } catch {
    return undefined
  }
  if (
    typeof value !== 'object' ||
    value === null ||
    !('type' in value) ||
    (value.type !== 'probe' && value.type !== 'probe_ack')
  )
    return undefined
  if (
    !('v' in value) ||
    value.v !== 1 ||
    !('nonce' in value) ||
    typeof value.nonce !== 'string' ||
    !/^[a-f0-9]{32}$/.test(value.nonce) ||
    Object.keys(value).length !== 3
  ) {
    throw new RelayProtocolError('Invalid transport receipt')
  }
  return { v: 1, type: value.type, nonce: value.nonce }
}
