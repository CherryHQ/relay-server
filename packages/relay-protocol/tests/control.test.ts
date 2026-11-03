import { expect, test } from 'bun:test'

import { assertReadyMatches, defaultRelayLimits, parseRelayReady } from '../src/index.js'

test('ready selection is strict and cannot replace the authenticated session or limits', () => {
  const expected = { sessionId: 'session_1', ownerEpoch: 'epoch_1', limits: defaultRelayLimits }
  const raw = { v: 1, type: 'ready', ...expected }
  const parsed = parseRelayReady(JSON.stringify(raw))
  expect(() => assertReadyMatches(parsed, expected)).not.toThrow()
  for (const changed of [
    { ...raw, sessionId: 'other' },
    { ...raw, ownerEpoch: 'other' },
    { ...raw, limits: { ...raw.limits, windowBytes: 65_536 } },
  ]) {
    expect(() => assertReadyMatches(parseRelayReady(JSON.stringify(changed)), expected)).toThrow()
  }
  for (const changed of [
    { ...raw, v: 2 },
    { ...raw, extra: true },
    { ...raw, limits: { ...raw.limits, maxInFlightFrames: 0 } },
  ]) {
    expect(() => parseRelayReady(JSON.stringify(changed))).toThrow()
  }
})
