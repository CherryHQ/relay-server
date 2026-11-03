import { expect, test } from 'bun:test'

import { readEnvironment, runtimeConfig } from '../../src/config.js'

test('runtime config fails closed on invalid limits and incomplete TLS configuration', () => {
  for (const config of [
    { maxSessions: 0 },
    { maxConnections: Infinity },
    { maxSocketBufferBytes: 10 },
    { maxTotalBufferBytes: 100 },
    { bytesPerSecond: 1 },
  ])
    expect(() => runtimeConfig(config)).toThrow()
  for (const env of [
    { RELAY_PORT: 'NaN' },
    { RELAY_PORT: '65536' },
    { RELAY_MAX_CONNECTIONS: '-1' },
    { RELAY_TLS_CERT: 'cert.pem' },
  ])
    expect(() => readEnvironment(env)).toThrow()
  const settings = readEnvironment({
    RELAY_HOST: '0.0.0.0',
    RELAY_PORT: '0',
    RELAY_MAX_SESSIONS: '4',
    RELAY_TLS_CERT: 'cert.pem',
    RELAY_TLS_KEY: 'key.pem',
  })
  expect(settings.config.maxSessions).toBe(4)
  expect(settings.port).toBe(0)
})
