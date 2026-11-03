import { dirname, relative, resolve } from 'node:path'

import ts from 'typescript'

let failures = 0
for (const directory of ['packages/relay-protocol', 'packages/relay-client', 'src/core']) {
  const root = resolve(directory)
  const core = directory === 'src/core'
  const allowed = new Set(
    core
      ? ['@cherrystudio/relay-protocol']
      : Object.keys((await Bun.file(`${root}/package.json`).json()).dependencies ?? {}),
  )
  for await (const file of new Bun.Glob(core ? '**/*.ts' : '{src,dist}/**/*.{ts,js}').scan({
    cwd: root,
    absolute: true,
  })) {
    const source = ts.createSourceFile(file, await Bun.file(file).text(), ts.ScriptTarget.Latest, true)
    const reject = (message: string) => {
      console.error(`${relative(process.cwd(), file)}: ${message}`)
      failures++
    }
    const inspectImport = (specifier: string) => {
      if (specifier.startsWith('.')) {
        const target = resolve(dirname(file), specifier)
        if (relative(root, target).startsWith('..')) reject(`Import escapes the package: ${specifier}`)
      } else {
        const dependency = specifier.startsWith('@')
          ? specifier.split('/').slice(0, 2).join('/')
          : specifier.split('/')[0]
        if (!dependency || !allowed.has(dependency)) reject(`Undeclared or nonportable import: ${specifier}`)
      }
    }
    const visit = (node: ts.Node) => {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
        if (ts.isStringLiteral(node.moduleSpecifier)) inspectImport(node.moduleSpecifier.text)
      }
      if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
        if (ts.isStringLiteral(node.argument.literal)) inspectImport(node.argument.literal.text)
      }
      if (
        ts.isCallExpression(node) &&
        (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          node.expression.getText(source) === 'require')
      ) {
        reject('Runtime package loading is not allowed in portable packages')
      }
      if (ts.isIdentifier(node) && ['Bun', 'process', 'Buffer'].includes(node.text)) {
        reject(`Platform global is not allowed: ${node.text}`)
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
  }
}
if (failures) process.exit(1)
console.log('Portable package and core import boundaries passed')
