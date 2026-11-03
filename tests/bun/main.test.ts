import { expect, test } from 'bun:test'

test('documented Bun entrypoint starts, reports health and exits on SIGTERM', async () => {
  const child = Bun.spawn([process.execPath, 'src/bun/main.ts'], {
    env: { PATH: process.env.PATH, RELAY_PORT: '0', RELAY_HOST: '127.0.0.1' },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const reader = child.stdout.getReader()
  try {
    const first = await reader.read()
    const text = new TextDecoder().decode(first.value)
    const origin = text.match(/http:\/\/127\.0\.0\.1:\d+\//)?.[0]
    expect(origin).toBeDefined()
    const health = await fetch(`${origin}healthz`)
    expect(await health.json()).toEqual({ status: 'ok' })
    child.kill('SIGTERM')
    expect(await child.exited).toBe(0)
    expect(await new Response(child.stderr).text()).toBe('')
  } finally {
    child.kill('SIGKILL')
    await child.exited
    reader.releaseLock()
  }
})
