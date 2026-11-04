import { resolve } from 'node:path'

// Resolve the protocol from source so the image needs neither published packages nor node_modules.
const result = await Bun.build({
  entrypoints: ['src/bun/main.ts'],
  outdir: 'dist/runtime',
  target: 'bun',
  format: 'esm',
  plugins: [
    {
      name: 'protocol-source',
      setup(build) {
        build.onResolve({ filter: /^@cherrystudio\/relay-protocol$/ }, () => ({
          path: resolve('packages/relay-protocol/src/index.ts'),
        }))
      },
    },
  ],
})
if (!result.success) throw new AggregateError(result.logs, 'Failed to build runtime')
console.log('Built standalone Bun runtime')
