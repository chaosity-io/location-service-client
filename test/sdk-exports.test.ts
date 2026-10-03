import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

import {
  AWS_FILE,
  expectedSdkExports,
  packageValueExports,
  SDK_PACKAGES,
} from '../scripts/sdk-exports.mjs'
import { typeErrors } from './typecheck'

/**
 * The root forwards the AWS packages' values by name, never by `export *`,
 * and through a module of its own (#42).
 *
 * A consumer importing only `createTransformRequest` paid ~93 KB: the SDK,
 * because no bundler can drop what an `export *` of a package might bind; and
 * the utilities package, because it does not declare `sideEffects: false`, so
 * a re-export of it keeps it in every bundle that reaches the re-export. Named
 * re-exports in src/aws.ts fix both — and can silently fall behind an SDK
 * that grows, which on 0.x is a breaking change waiting for its release. So
 * this compares them with the packages themselves, read by the checker.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const indexFile = join(root, 'src/index.ts')
const indexSource = readFileSync(indexFile, 'utf8')
const awsSource = readFileSync(AWS_FILE, 'utf8')

const files = (function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? walk(join(dir, e.name))
      : /\.[cm]?tsx?$/.test(e.name)
        ? [join(dir, e.name)]
        : [],
  )
})(join(root, 'src'))

/** The names a file re-exports BY NAME, as values, from `pkg`. */
function namedValueReExports(source: string, pkg: string): string[] {
  const sf = ts.createSourceFile('x.ts', source, ts.ScriptTarget.Latest)
  return sf.statements
    .filter(
      (st): st is ts.ExportDeclaration =>
        ts.isExportDeclaration(st) &&
        !st.isTypeOnly &&
        !!st.moduleSpecifier &&
        ts.isStringLiteral(st.moduleSpecifier) &&
        st.moduleSpecifier.text === pkg &&
        !!st.exportClause &&
        ts.isNamedExports(st.exportClause),
    )
    .flatMap((st) =>
      (st.exportClause as ts.NamedExports).elements
        .filter((el) => !el.isTypeOnly)
        .map((el) => el.name.text),
    )
    .sort()
}

describe('no `export *` of a package anywhere in src/', () => {
  // The domain is every star re-export in the source, of any package: a
  // relative one is this package's own module and costs nothing to read.
  it('finds none', () => {
    const stars = files.flatMap((f) => {
      const sf = ts.createSourceFile(
        f,
        readFileSync(f, 'utf8'),
        ts.ScriptTarget.Latest,
        true,
      )
      return sf.statements
        .filter(
          (st) =>
            ts.isExportDeclaration(st) &&
            !st.isTypeOnly &&
            (!st.exportClause || ts.isNamespaceExport(st.exportClause)) &&
            !!st.moduleSpecifier &&
            ts.isStringLiteral(st.moduleSpecifier) &&
            !st.moduleSpecifier.text.startsWith('.'),
        )
        .map(
          (st) =>
            `${relative(root, f).split(sep).join('/')}: ${st.getText(sf)}`,
        )
    })
    expect(files.length).toBeGreaterThan(10)
    expect(stars).toEqual([])
  })
})

describe('the entry points re-export no package’s values themselves', () => {
  // Only a module of this package can be dropped whole, imports and all, and
  // only because this package declares `sideEffects: false`. A value
  // re-export of a package straight from an entry keeps that package in the
  // bundle of everyone who imports the entry, unless the package declares the
  // same — and @aws/amazon-location-utilities-datatypes does not.
  const entries = ['src/index.ts', 'src/server/index.ts']

  it('declares sideEffects: false, which the rest relies on', () => {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
    expect(pkg.sideEffects).toBe(false)
  })

  it.each(entries)('%s', (entry) => {
    const sf = ts.createSourceFile(
      entry,
      readFileSync(join(root, entry), 'utf8'),
      ts.ScriptTarget.Latest,
      true,
    )
    const fromPackages = sf.statements
      .filter(
        (st): st is ts.ExportDeclaration =>
          ts.isExportDeclaration(st) &&
          !st.isTypeOnly &&
          !!st.moduleSpecifier &&
          ts.isStringLiteral(st.moduleSpecifier) &&
          !st.moduleSpecifier.text.startsWith('.') &&
          // A clause of type-only names builds nothing.
          !(
            st.exportClause &&
            ts.isNamedExports(st.exportClause) &&
            st.exportClause.elements.every((el) => el.isTypeOnly)
          ),
      )
      .map((st) => st.getText(sf).split('\n')[0])
    expect(sf.statements.length).toBeGreaterThan(0)
    expect(fromPackages).toEqual([])
  })
})

describe('the root forwards every value of the AWS packages', () => {
  const expected = expectedSdkExports(indexSource)

  it('read both packages, so an empty list cannot pass', () => {
    const values = packageValueExports()
    expect([...values.keys()]).toEqual(SDK_PACKAGES)
    expect(values.get('@aws-sdk/client-geo-places')).toEqual(
      expect.arrayContaining(['ValidationException', 'GeoPlacesClient']),
    )
    expect(
      values.get('@aws/amazon-location-utilities-datatypes')!.length,
    ).toBeGreaterThan(5)
  }, 60_000)

  it.each(SDK_PACKAGES)(
    '%s: src/aws.ts names exactly its values, less the root’s own',
    (pkg) => {
      // Regenerate with `node scripts/sdk-exports.mjs --write`.
      expect(namedValueReExports(awsSource, pkg)).toEqual(expected.get(pkg))
    },
  )

  it('exports, as a value, every value either package exports', () => {
    // Independent of the generator, and compiled rather than read off the
    // checker's symbols: a name that reaches the root only through
    // `export type *` resolves to the package's own VALUE symbol there, and
    // only a use as a value is refused (TS1362). So every value either package
    // exports is used as one, through the root. The root's own GeoPlacesClient,
    // GeoPlaces and seven narrowed commands satisfy their names.
    const names = [...packageValueExports()].flatMap(([, values]) => values)
    const source = [
      `import * as Root from '../src/index.js'`,
      ...names.map((n, i) => `export const v${i}: unknown = Root.${n}`),
    ].join('\n')
    expect(names.length).toBeGreaterThan(100)
    expect(typeErrors('__sdk-values__.ts', source)).toEqual([])
  }, 60_000)

  it('requires at least the package versions src/aws.ts was generated from', () => {
    // A name re-exported from a version that lacks it is a link error in
    // ESM — the whole package fails to import. So each dependency's floor is
    // at least the version the file names.
    const from = /\/\/ from (.+)/.exec(awsSource)?.[1]
    expect(from, 'src/aws.ts records what it was generated from').toBeTruthy()
    const deps = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
      .dependencies as Record<string, string>
    const parse = (v: string): number[] => v.split('.').map(Number)
    const atLeast = (a: number[], b: number[]): boolean => {
      for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i]! > b[i]!
      return true
    }
    for (const pkg of SDK_PACKAGES) {
      const generated = new RegExp(
        `${pkg.replace('/', '\\/')} (\\d+\\.\\d+\\.\\d+)`,
      ).exec(from!)?.[1]
      expect(generated, `${pkg} in the "from" line`).toBeTruthy()
      const floor = /^\^(\d+\.\d+\.\d+)$/.exec(deps[pkg] ?? '')?.[1]
      expect(floor, `${pkg} is a ^x.y.z range`).toBeTruthy()
      expect(
        atLeast(parse(floor!), parse(generated!)),
        `${pkg}: ^${floor} admits versions older than ${generated}`,
      ).toBe(true)
    }
  })
})
