import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export async function createTestTls() {
  const directory = await mkdtemp(join(tmpdir(), 'relay-wss-test-'))
  const certPath = join(directory, 'cert.pem')
  const keyPath = join(directory, 'key.pem')
  const result = Bun.spawnSync(
    [
      'openssl',
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-days',
      '1',
      '-subj',
      '/CN=localhost',
      '-addext',
      'subjectAltName=DNS:localhost,IP:127.0.0.1',
      '-keyout',
      keyPath,
      '-out',
      certPath,
    ],
    { stdout: 'ignore', stderr: 'pipe' },
  )
  if (result.exitCode !== 0) {
    await rm(directory, { recursive: true, force: true })
    throw new Error(`Test certificate generation failed: ${result.stderr.toString()}`)
  }
  return {
    tls: { cert: await Bun.file(certPath).text(), key: await Bun.file(keyPath).text() },
    dispose: () => rm(directory, { recursive: true, force: true }),
  }
}
