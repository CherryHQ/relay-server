import assert from 'node:assert/strict'

import { smokeRelay } from './smoke-relay.js'

const image = process.argv[2] ?? 'cherry-relay:check'
const name = `cherry-relay-check-${process.pid}`
async function docker(...args: string[]) {
  const child = Bun.spawn(['docker', ...args], { stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  assert.equal(code, 0, `docker ${args[0]} failed: ${stderr}`)
  return stdout.trim()
}
async function ready() {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const status = await docker('inspect', '--format', '{{.State.Health.Status}}', name)
    if (status === 'healthy') return
    await Bun.sleep(250)
  }
  throw new Error('Container did not become healthy')
}

let created = false
try {
  await docker(
    'run',
    '--detach',
    '--name',
    name,
    '--read-only',
    '--cap-drop=ALL',
    '--security-opt=no-new-privileges',
    '--memory=512m',
    '--pids-limit=128',
    '--publish',
    '127.0.0.1::8787',
    '--health-interval=1s',
    image,
  )
  created = true
  await ready()
  assert.notEqual(await docker('exec', name, 'id', '-u'), '0', 'Runtime must not run as root')
  const endpoint = async () => `ws://${await docker('port', name, '8787/tcp')}/v1/relay`
  console.log('Container:', await smokeRelay(await endpoint()))
  // Leave a listener open: SIGTERM must release it and finish without Docker's SIGKILL.
  const socket = new WebSocket(await endpoint())
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Listener timed out')), 5000)
      socket.addEventListener('open', () =>
        socket.send(JSON.stringify({ v: 1, type: 'listen', hostKey: 'ab'.repeat(32) })),
      )
      socket.addEventListener(
        'message',
        () => {
          clearTimeout(timer)
          resolve()
        },
        { once: true },
      )
      socket.addEventListener(
        'error',
        () => {
          clearTimeout(timer)
          reject(new Error('Listener failed'))
        },
        { once: true },
      )
    })
    const closed = new Promise<void>((resolve) =>
      socket.addEventListener('close', () => resolve(), { once: true }),
    )
    await docker('stop', '--time', '20', name)
    await closed
  } finally {
    socket.terminate()
  }
  assert.equal(await docker('inspect', '--format', '{{.State.ExitCode}}', name), '0')
  assert.match(await docker('logs', name), /Cherry Relay stopped/)
  await docker('start', name)
  await ready()
  console.log('After restart:', await smokeRelay(await endpoint()))
  console.log('Container health, non-root/read-only operation, binary forwarding, SIGTERM and restart passed')
} catch (error) {
  if (created) {
    console.error(await docker('logs', name))
    console.error(await docker('inspect', '--format', '{{json .State}}', name))
  }
  throw error
} finally {
  if (created) await docker('rm', '--force', name)
}
