// The AWS packages' exports, as the root has to forward them (#42).
//
// The root used to `export *` both AWS packages, and a consumer importing only
// a map helper paid ~93 KB for it. Two things kept the code in a bundle:
//
// - No bundler can drop what an `export *` of a package might bind. Values
//   are therefore re-exported BY NAME, and types with `export type *`, which
//   is erased.
// - A re-export of a package that does not declare `sideEffects: false`
//   (@aws/amazon-location-utilities-datatypes does not) keeps that package in
//   every bundle that reaches the re-export, used or not. So the names live in
//   src/aws.ts, a module of THIS package, which does declare it: a bundler
//   drops an unused module of a side-effect-free package together with its
//   imports.
//
// A list of names has to come from the packages themselves, or an SDK upgrade
// silently stops forwarding what it adds. This reads each package's own
// declarations with the TypeScript checker — not `Object.keys()` on the
// runtime module, whose CommonJS keys include a spurious `module.exports`.
//
// `node scripts/sdk-exports.mjs --write` rewrites src/aws.ts and runs Prettier
// on it. test/sdk-exports.test.ts fails when the file and the packages
// disagree.
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(join(root, 'package.json'))

export const SDK_PACKAGES = [
  '@aws-sdk/client-geo-places',
  '@aws/amazon-location-utilities-datatypes',
]

/** The generated module, and the entry whose own exports it leaves out. */
export const AWS_FILE = join(root, 'src/aws.ts')
export const INDEX_FILE = join(root, 'src/index.ts')

const VALUE =
  ts.SymbolFlags.Variable |
  ts.SymbolFlags.Function |
  ts.SymbolFlags.Class |
  ts.SymbolFlags.Enum |
  ts.SymbolFlags.ValueModule

/** The installed version of an SDK package — what the list is generated from. */
export function installedVersion(pkg) {
  return JSON.parse(
    readFileSync(require.resolve(`${pkg}/package.json`), 'utf8'),
  ).version
}

/**
 * The names src/index.ts exports by name itself: the seven narrowed Places
 * commands, GeoPlacesClient, GeoPlaces and the rest. Each must win over the
 * SDK's export of the same name, so none is forwarded.
 */
export function ownExports(indexSource) {
  const sf = ts.createSourceFile(
    'index.ts',
    indexSource,
    ts.ScriptTarget.Latest,
  )
  const names = new Set()
  for (const st of sf.statements) {
    if (
      ts.isExportDeclaration(st) &&
      st.exportClause &&
      ts.isNamedExports(st.exportClause)
    ) {
      for (const el of st.exportClause.elements) names.add(el.name.text)
    }
  }
  return names
}

/** Each SDK package's value exports, by the checker, sorted. */
export function packageValueExports() {
  const file = join(root, '__sdk-exports__.ts')
  const source = SDK_PACKAGES.map(
    (p, i) => `import * as P${i} from '${p}'`,
  ).join('\n')
  const config = ts.getParsedCommandLineOfConfigFile(
    join(root, 'tsconfig.json'),
    {},
    { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => {} },
  )
  const options = { ...config.options, noEmit: true }
  const host = ts.createCompilerHost(options)
  const readFile = host.readFile
  const fileExists = host.fileExists
  const getSourceFile = host.getSourceFile
  host.readFile = (f) => (f === file ? source : readFile(f))
  host.fileExists = (f) => f === file || fileExists(f)
  host.getSourceFile = (f, v, ...rest) =>
    f === file
      ? ts.createSourceFile(f, source, v)
      : getSourceFile(f, v, ...rest)
  const program = ts.createProgram([file], options, host)
  const checker = program.getTypeChecker()

  const result = new Map()
  for (const st of program.getSourceFile(file).statements) {
    const pkg = st.moduleSpecifier.text
    const mod = checker.getSymbolAtLocation(st.moduleSpecifier)
    if (!mod) throw new Error(`${pkg} did not resolve`)
    const values = checker
      .getExportsOfModule(mod)
      .filter((s) => {
        const target =
          s.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(s) : s
        return target.flags & VALUE
      })
      .map((s) => s.name)
      .sort()
    result.set(pkg, values)
  }
  return result
}

/** What src/aws.ts must forward: each package's values, less the root's own. */
export function expectedSdkExports(indexSource) {
  const own = ownExports(indexSource)
  const out = new Map()
  for (const [pkg, values] of packageValueExports()) {
    out.set(
      pkg,
      values.filter((n) => !own.has(n)),
    )
  }
  return out
}

function render(expected) {
  const from = SDK_PACKAGES.map((p) => `${p} ${installedVersion(p)}`).join(', ')
  const values = [...expected].map(
    ([pkg, names]) => `export {\n  ${names.join(',\n  ')},\n} from '${pkg}'`,
  )
  const types = SDK_PACKAGES.map((p) => `export type * from '${p}'`)
  return [
    '// Generated by `node scripts/sdk-exports.mjs --write` — do not edit (#42).',
    '// The AWS packages, forwarded by the root: types by `export type *`, values',
    '// by name. Why it is a module of its own, and why by name: see the script.',
    `// from ${from}`,
    ...types,
    ...values,
    '',
  ].join('\n')
}

if (process.argv.includes('--write')) {
  writeFileSync(
    AWS_FILE,
    render(expectedSdkExports(readFileSync(INDEX_FILE, 'utf8'))),
  )
  execFileSync('npx', ['prettier', '--write', AWS_FILE], {
    cwd: root,
    stdio: 'inherit',
  })
}
