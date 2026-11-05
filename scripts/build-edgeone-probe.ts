import { mkdir, rm } from 'node:fs/promises'

const root = 'dist/edgeone-probe'
await rm(root, { recursive: true, force: true })
for (const [kind, directory] of [
  ['cloud', 'cloud-functions'],
  ['agent', 'agents'],
] as const) {
  const result = await Bun.build({
    entrypoints: [`deploy/edgeone/probe/${kind}.ts`],
    outdir: `${root}/${directory}/probe`,
    target: 'node',
    format: 'esm',
  })
  if (!result.success) throw new AggregateError(result.logs, `Failed to build EdgeOne ${kind} probe`)
}
await mkdir(`${root}/public`, { recursive: true })
await Bun.write(`${root}/edgeone.json`, Bun.file('deploy/edgeone/probe/edgeone.json'))
// CLI 1.6.47's generated Cloud Functions wrapper calls require('ws') at upgrade time.
// Keep this dependency in the standalone probe, not in the portable Relay packages.
await Bun.write(
  `${root}/package.json`,
  JSON.stringify({ private: true, type: 'module', dependencies: { ws: '8.22.1' } }),
)
await Bun.write(
  `${root}/public/index.html`,
  '<!doctype html><title>Relay platform probe</title><p>Temporary EdgeOne capability probe. This is not a Relay deployment.</p>',
)
console.log(`Built native EdgeOne probe project at ${root}; no deployment performed`)
