import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const consumer = await mkdtemp(join(tmpdir(), 'relay-package-check-'))
async function run(cmd: string[], cwd = consumer): Promise<string> {
  const child = Bun.spawn(cmd, { cwd, stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (code !== 0) throw new Error(`${cmd[1]} failed (${code})\n${stdout}\n${stderr}`)
  return stdout
}
try {
  const dependencies: Record<string, string> = {}
  for (const name of ['relay-protocol', 'relay-client']) {
    const tarball = join(consumer, `${name}.tgz`)
    await run(
      [process.execPath, 'pm', 'pack', '--filename', tarball, '--ignore-scripts', '--quiet'],
      resolve('packages', name),
    )
    const files = (await run(['tar', '-tzf', tarball])).trim().split('\n')
    if (!files.includes('package/dist/index.js') || !files.includes('package/dist/index.d.ts')) {
      throw new Error(`${name} is missing its entrypoints`)
    }
    for (const file of files) {
      if (
        !/^package\/(package\.json|README\.md|dist\/[\w.-]+\.(js|d\.ts)|vectors\/[\w.-]+\.json)$/.test(file)
      ) {
        throw new Error(`Unexpected packed file: ${file}`)
      }
    }
    const manifest = JSON.parse(await run(['tar', '-xOf', tarball, 'package/package.json']))
    if (JSON.stringify(manifest).includes('workspace:'))
      throw new Error('Unresolved workspace dependency in tarball')
    dependencies[`@cherrystudio/${name}`] = `file:${tarball}`
  }
  await Bun.write(
    join(consumer, 'package.json'),
    JSON.stringify({
      private: true,
      type: 'module',
      dependencies,
      // The first unreleased version exists only in these tarballs, not in the public registry.
      overrides: { '@cherrystudio/relay-protocol': dependencies['@cherrystudio/relay-protocol'] },
    }),
  )
  // Frozen workspace installs can cache archives without the manifests a new consumer needs.
  // Resolve once, then verify a fresh offline install of the locked dependency graph.
  await run([process.execPath, 'install', '--ignore-scripts', '--no-progress'])
  await rm(join(consumer, 'node_modules'), { recursive: true, force: true })
  await run([
    process.execPath,
    'install',
    '--offline',
    '--frozen-lockfile',
    '--ignore-scripts',
    '--no-progress',
  ])
  await Bun.write(
    join(consumer, 'index.ts'),
    `
import { RelayStream, connectRelayStream, attachRelayStream, type RelayWebSocket } from '@cherrystudio/relay-client'
import { encodeFrame } from '@cherrystudio/relay-protocol'
export { RelayStream, encodeFrame, connectRelayStream, attachRelayStream }
export const browserSocket = (socket: WebSocket): RelayWebSocket => socket
if (encodeFrame({ type: 'ack', seq: 1n, cumulativeBytes: 1n }).byteLength !== 24) throw new Error('Bad artifact')
`,
  )
  await Bun.write(
    join(consumer, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        target: 'ES2022',
        module: 'ESNext',
        moduleResolution: 'Bundler',
        lib: ['ES2022', 'DOM'],
        types: [],
        strict: true,
        skipLibCheck: true,
        noEmit: true,
      },
      include: ['index.ts'],
    }),
  )
  await run([process.execPath, 'check', '--no-script', '-p', 'tsconfig.json'])
  await run([process.execPath, 'index.ts'])
  await run([process.execPath, 'build', 'index.ts', '--target=browser', '--outfile=browser.js'])
  console.log(
    'Packed packages: offline isolated install, DOM-only consumer types, import and browser bundle passed',
  )
} finally {
  await rm(consumer, { recursive: true, force: true })
}
