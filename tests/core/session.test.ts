import { expect, test } from 'bun:test'

import { type CloseReason, encodeFrame } from '@cherrystudio/relay-protocol'

import type { RelayPeer } from '../../src/core/ports.js'
import { RelaySession } from '../../src/core/session.js'

class Peer implements RelayPeer {
  sent: (string | Uint8Array)[] = []
  closed: CloseReason[] = []
  reject = false
  send(data: string | Uint8Array, onSent?: () => void): boolean {
    if (this.reject) return false
    this.sent.push(data)
    onSent?.()
    return true
  }
  close(reason: CloseReason): void {
    this.closed.push(reason)
  }
}

function fixture() {
  const app = new Peer()
  const desktop = new Peer()
  const closed: CloseReason[] = []
  const selection = {
    sessionId: 'session',
    ownerEpoch: 'epoch',
    limits: { maxFrameBytes: 4, windowBytes: 8, maxInFlightFrames: 2 },
  }
  const session = new RelaySession(selection, 100, app, 50, (reason) => closed.push(reason))
  return { app, desktop, closed, session }
}

test('both receivers must start before ready and closing is idempotent despite late callbacks', () => {
  const { app, desktop, closed, session } = fixture()
  const bytes = encodeFrame({ type: 'data', seq: 1n, cumulativeBytes: 1n, payload: new Uint8Array([1]) })
  expect(() => session.receive('app', bytes, 0)).toThrow()
  session.attach(desktop, 0)
  session.start('app', 0)
  expect(app.sent).toHaveLength(0)
  session.start('desktop', 0)
  expect(app.sent).toHaveLength(1)
  expect(desktop.sent).toHaveLength(1)
  session.receive('app', bytes, 1)
  expect(desktop.sent[1]).toEqual(bytes)
  session.close('CANCELLED')
  session.close('RELAY_UNAVAILABLE')
  session.tick(200)
  session.receive('app', bytes, 201)
  expect(closed).toEqual(['CANCELLED'])
  expect(app.closed).toEqual(['CANCELLED'])
  expect(desktop.closed).toEqual(['CANCELLED'])
})

test('waiting expiry and stalled DATA close both roles, while duplicate attachment cannot replace a peer', () => {
  const { app, desktop, session } = fixture()
  session.attach(desktop, 0)
  expect(() => session.attach(new Peer(), 1)).toThrow()
  session.tick(100)
  expect(app.closed).toEqual(['CANCELLED'])
  expect(desktop.closed).toEqual(['CANCELLED'])
  const active = fixture()
  active.session.attach(active.desktop, 0)
  active.session.start('app', 0)
  active.session.start('desktop', 0)
  active.session.receive(
    'desktop',
    encodeFrame({ type: 'data', seq: 1n, cumulativeBytes: 4n, payload: new Uint8Array(4) }),
    1,
  )
  active.session.tick(51)
  expect(active.closed).toEqual(['STALLED'])
})

test('failed ready delivery ends the session exactly once', () => {
  const { app, desktop, closed, session } = fixture()
  session.attach(desktop, 0)
  desktop.reject = true
  session.start('app', 0)
  session.start('desktop', 0)
  expect(session.state).toBe('closed')
  expect(closed).toEqual(['RESOURCE_EXHAUSTED'])
  expect(app.closed).toEqual(['RESOURCE_EXHAUSTED'])
})
