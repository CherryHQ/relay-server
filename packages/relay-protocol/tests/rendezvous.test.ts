import { expect, test } from 'bun:test'

import {
  type ClientControl,
  defaultRelayLimits,
  parseClientControl,
  parseServerControl,
  type ServerControl,
} from '../src/index.js'

const hex = '01'.repeat(32)
const selection = { sessionId: 'session', ownerEpoch: 'epoch', limits: defaultRelayLimits }

test('rendezvous distinguishes listener credentials, requester sockets and single-role tickets', () => {
  const messages: ClientControl[] = [
    { v: 1, type: 'listen', hostKey: hex },
    { v: 1, type: 'connect', targetId: hex },
    { v: 1, type: 'attach', sessionId: 'session', ownerEpoch: 'epoch', ticket: hex },
    { v: 1, type: 'start', sessionId: 'session', ownerEpoch: 'epoch' },
    { v: 1, type: 'cancel', sessionId: 'session' },
  ]
  for (const message of messages) expect(parseClientControl(JSON.stringify(message))).toEqual(message)
  const replies: ServerControl[] = [
    { v: 1, type: 'listening', targetId: hex, ownerEpoch: 'epoch' },
    { v: 1, type: 'pending', ...selection, expiresInMs: 5000 },
    { v: 1, type: 'offer', ...selection, ticket: hex, expiresInMs: 5000 },
    { v: 1, type: 'ready', ...selection },
    { v: 1, type: 'session_closed', sessionId: 'session', reason: 'CANCELLED' },
  ]
  for (const reply of replies) expect(parseServerControl(JSON.stringify(reply))).toEqual(reply)
})

test('rendezvous rejects oversized, ambiguous or invalid controls and expanded limits', () => {
  for (const input of [
    '{',
    '[]',
    JSON.stringify({ v: 2, type: 'listen', hostKey: hex }),
    JSON.stringify({ v: 1, type: 'listen', hostKey: hex, role: 'app' }),
    JSON.stringify({ v: 1, type: 'listen', hostKey: 'guessable' }),
    JSON.stringify({ v: 1, type: 'connect', targetId: hex.toUpperCase().replace('01', 'AF') }),
    JSON.stringify({ v: 1, type: 'attach', ...selection, ticket: hex }),
    JSON.stringify({ v: 1, type: 'start', sessionId: '../path', ownerEpoch: 'epoch' }),
    ' '.repeat(4097),
  ])
    expect(() => parseClientControl(input)).toThrow()
  expect(() =>
    parseServerControl(JSON.stringify({ v: 1, type: 'pending', ...selection, expiresInMs: 0 })),
  ).toThrow()
  expect(() =>
    parseServerControl(
      JSON.stringify({
        v: 1,
        type: 'pending',
        ...selection,
        limits: { ...defaultRelayLimits, windowBytes: 2 ** 30 },
        expiresInMs: 100,
      }),
    ),
  ).toThrow()
  expect(() =>
    parseServerControl(
      JSON.stringify({ v: 1, type: 'session_closed', sessionId: 'session', reason: 'arbitrary' }),
    ),
  ).toThrow()
})
