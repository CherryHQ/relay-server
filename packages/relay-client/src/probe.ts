import { parseRelayProbe, RelayProtocolError } from '@cherrystudio/relay-protocol'

import type { RelaySocket } from './ports.js'

/** Call before rendezvous parsing on a desktop listener. RelayStream handles its own receipts. */
export function respondToRelayProbe(
  socket: Pick<RelaySocket, 'send' | 'readyState' | 'bufferedAmount'>,
  message: string,
): boolean {
  const probe = parseRelayProbe(message)
  if (!probe) return false
  if (
    probe.type !== 'probe' ||
    socket.readyState !== 1 ||
    !Number.isSafeInteger(socket.bufferedAmount) ||
    socket.bufferedAmount < 0 ||
    socket.bufferedAmount > 1024 * 1024 - 128
  ) {
    throw new RelayProtocolError('Cannot acknowledge transport receipt')
  }
  if (socket.send(JSON.stringify({ ...probe, type: 'probe_ack' })) === 0) {
    throw new RelayProtocolError('Transport receipt was not accepted')
  }
  return true
}
