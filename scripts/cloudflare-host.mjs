import { dirname } from 'node:path'
// Miniflare's Node runtime owns workerd; the Bun test driver owns all actual WebSocket clients.
import { createInterface } from 'node:readline'

import { convertV4MiniflareOptions, Miniflare } from 'miniflare'

const mf = new Miniflare(
  convertV4MiniflareOptions({
    name: 'relay-check',
    modules: true,
    scriptPath: process.argv[2],
    modulesRoot: dirname(process.argv[2]),
    compatibilityDate: '2026-11-04',
    host: '127.0.0.1',
    port: 0,
    cf: false,
    // stdout is the test driver's JSON command channel; Worker diagnostics belong on stderr.
    handleStructuredLogs: ({ message }) => process.stderr.write(`${message}\n`),
    durableObjects: { RELAY: { className: 'RelayObject', useSQLite: true } },
  }),
)
const output = (value) => process.stdout.write(`${JSON.stringify(value)}\n`)
try {
  const url = await mf.ready
  output({ url: url.href })
  for await (const line of createInterface({ input: process.stdin })) {
    const command = JSON.parse(line)
    if (command.type === 'dispose') break
    try {
      if (command.type === 'evict') {
        await mf.unsafeEvictDurableObject('relay-check', 'RelayObject', {
          name: 'relay-v1',
          webSockets: 'hibernate',
        })
      } else if (command.type !== 'inspect') throw new Error('Unknown test command')
      output(await (await fetch(new URL('/__test/stats', url))).json())
    } catch (error) {
      output({ error: String(error) })
    }
  }
} finally {
  await mf.dispose()
}
