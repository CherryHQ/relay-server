import { RelayProtocolError } from '@cherrystudio/relay-protocol'

export type DiagnosticFields = Readonly<Record<string, string | number | boolean | undefined>>

// Only fixed, locally generated messages may enter logs. Never serialize errors, attachments,
// rendezvous commands or peer-supplied close text: they can contain host keys and attach tickets.
const knownCauses = new Set([
  'Invalid target snapshot',
  'Target limit exceeded',
  'Connection limit exceeded',
  'Invalid socket attachment',
  'Mixed owner epochs',
  'Invalid handshake deadline',
  'Duplicate listener',
  'Duplicate desktop role',
  'Unknown socket state',
  'Invalid session ownership snapshot',
  'Invalid session snapshot',
  'Waiting session contains DATA',
  'Invalid rate snapshot',
  'Invalid forwarding snapshot',
  'Invalid forwarding boundary',
  'Incomplete forwarding snapshot',
  'Invalid transport budget snapshot',
  'Transport budget exhausted',
  'Unsolicited or expired transport receipt',
  'Oversized transport control',
  'Invalid transport receipt',
  'Invalid rendezvous JSON',
  'Unsupported rendezvous message',
  'Invalid rendezvous shape',
  'Unknown rendezvous message',
  'Admission already in progress',
  'Unexpected DATA',
  'Unexpected transport challenge',
  'Wrong target',
  'Wrong session',
  'Unexpected control message',
  'Expected admission',
])

export function failureDetails(error: unknown): DiagnosticFields {
  return {
    errorType:
      error instanceof RelayProtocolError
        ? 'RelayProtocolError'
        : error instanceof TypeError
          ? 'TypeError'
          : error instanceof RangeError
            ? 'RangeError'
            : error instanceof Error
              ? 'Error'
              : 'unknown',
    cause: error instanceof Error && knownCauses.has(error.message) ? error.message : 'UNCLASSIFIED',
  }
}
