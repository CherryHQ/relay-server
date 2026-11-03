import { parseRelayReady, type RelayReady } from './control.js'
import { type CloseReason, isCloseReason, RelayProtocolError } from './errors.js'

export const rendezvousPath = '/v1/relay'
export const maxRendezvousBytes = 4096
/** Hash UTF-8(targetKeyDomain + hostKey) with SHA-256 to obtain the public targetId. */
export const targetKeyDomain = 'cherry-relay-target-v1\0'

export type RelaySelection = Omit<RelayReady, 'v' | 'type'>
export type RelayRole = 'desktop' | 'app'

export type ClientControl =
  | { readonly v: 1; readonly type: 'listen'; readonly hostKey: string }
  | { readonly v: 1; readonly type: 'connect'; readonly targetId: string }
  | {
      readonly v: 1
      readonly type: 'attach'
      readonly sessionId: string
      readonly ownerEpoch: string
      readonly ticket: string
    }
  | { readonly v: 1; readonly type: 'start'; readonly sessionId: string; readonly ownerEpoch: string }
  | { readonly v: 1; readonly type: 'cancel'; readonly sessionId: string }

export type RelayPending = RelaySelection & {
  readonly v: 1
  readonly type: 'pending'
  readonly expiresInMs: number
}
export type RelayOffer = Omit<RelayPending, 'type'> & { readonly type: 'offer'; readonly ticket: string }
export type ServerControl =
  | { readonly v: 1; readonly type: 'listening'; readonly targetId: string; readonly ownerEpoch: string }
  | RelayPending
  | RelayOffer
  | RelayReady
  | {
      readonly v: 1
      readonly type: 'session_closed'
      readonly sessionId: string
      readonly reason: CloseReason
    }

function record(json: string): Record<string, unknown> {
  if (json.length > maxRendezvousBytes || new TextEncoder().encode(json).byteLength > maxRendezvousBytes) {
    throw new RelayProtocolError('Rendezvous message is too large')
  }
  let value: unknown
  try {
    value = JSON.parse(json)
  } catch {
    throw new RelayProtocolError('Invalid rendezvous JSON')
  }
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    !('v' in value) ||
    value.v !== 1
  ) {
    throw new RelayProtocolError('Unsupported rendezvous message')
  }
  return value as Record<string, unknown>
}

function keys(value: Record<string, unknown>, names: string[]): void {
  if (Object.keys(value).length !== names.length + 2 || !names.every((key) => Object.hasOwn(value, key))) {
    throw new RelayProtocolError('Invalid rendezvous shape')
  }
}

function id(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(value)) {
    throw new RelayProtocolError('Invalid rendezvous identifier')
  }
  return value
}

function hex(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) {
    throw new RelayProtocolError('Expected 32 bytes of lowercase hex')
  }
  return value
}

export function parseClientControl(json: string): ClientControl {
  const value = record(json)
  switch (value.type) {
    case 'listen':
      keys(value, ['hostKey'])
      return { v: 1, type: 'listen', hostKey: hex(value.hostKey) }
    case 'connect':
      keys(value, ['targetId'])
      return { v: 1, type: 'connect', targetId: hex(value.targetId) }
    case 'attach':
      keys(value, ['sessionId', 'ownerEpoch', 'ticket'])
      return {
        v: 1,
        type: 'attach',
        sessionId: id(value.sessionId),
        ownerEpoch: id(value.ownerEpoch),
        ticket: hex(value.ticket),
      }
    case 'start':
      keys(value, ['sessionId', 'ownerEpoch'])
      return { v: 1, type: 'start', sessionId: id(value.sessionId), ownerEpoch: id(value.ownerEpoch) }
    case 'cancel':
      keys(value, ['sessionId'])
      return { v: 1, type: 'cancel', sessionId: id(value.sessionId) }
    default:
      throw new RelayProtocolError('Unknown rendezvous message')
  }
}

export function parseServerControl(json: string): ServerControl {
  const value = record(json)
  switch (value.type) {
    case 'ready':
      return parseRelayReady(json)
    case 'listening':
      keys(value, ['targetId', 'ownerEpoch'])
      return { v: 1, type: 'listening', targetId: hex(value.targetId), ownerEpoch: id(value.ownerEpoch) }
    case 'pending':
    case 'offer': {
      keys(value, [
        'sessionId',
        'ownerEpoch',
        'limits',
        'expiresInMs',
        ...(value.type === 'offer' ? ['ticket'] : []),
      ])
      if (!Number.isSafeInteger(value.expiresInMs) || (value.expiresInMs as number) < 1) {
        throw new RelayProtocolError('Invalid rendezvous expiry')
      }
      const { sessionId, ownerEpoch, limits } = parseRelayReady(
        JSON.stringify({
          v: 1,
          type: 'ready',
          sessionId: value.sessionId,
          ownerEpoch: value.ownerEpoch,
          limits: value.limits,
        }),
      )
      const pending: RelayPending = {
        v: 1,
        type: 'pending',
        sessionId,
        ownerEpoch,
        limits,
        expiresInMs: value.expiresInMs as number,
      }
      return value.type === 'offer' ? { ...pending, type: 'offer', ticket: hex(value.ticket) } : pending
    }
    case 'session_closed':
      keys(value, ['sessionId', 'reason'])
      if (!isCloseReason(value.reason)) throw new RelayProtocolError('Invalid close reason')
      return { v: 1, type: 'session_closed', sessionId: id(value.sessionId), reason: value.reason }
    default:
      throw new RelayProtocolError('Unknown rendezvous message')
  }
}
