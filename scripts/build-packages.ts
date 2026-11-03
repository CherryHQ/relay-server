import { rm } from 'node:fs/promises'

for (const name of ['relay-protocol', 'relay-client']) {
  const directory = `packages/${name}`
  await rm(`${directory}/dist`, { recursive: true, force: true })
  const output = await Bun.build({
    entrypoints: [`${directory}/src/index.ts`],
    outdir: `${directory}/dist`,
    target: 'browser',
    format: 'esm',
    packages: 'external',
  })
  if (!output.success) throw new AggregateError(output.logs, `Failed to build ${name}`)
  // bun check handles checking. Bun does not currently emit declaration files.
  const declarations = Bun.spawn(
    [process.execPath, 'node_modules/typescript/bin/tsc6', '-p', directory, '--noCheck'],
    { stdout: 'inherit', stderr: 'inherit' },
  )
  if ((await declarations.exited) !== 0) throw new Error(`Failed to emit declarations for ${name}`)
  console.log(`Built ${name}`)
}
