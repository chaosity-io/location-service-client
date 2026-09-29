import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

import { codeBlocks } from './readme-blocks'
import { typeErrors } from './typecheck'

/**
 * The Markdown in this repository names only what the package has (#8).
 *
 * `ARCHITECTURE.md` documented `AuthHelper` and `AuthClient` classes that never
 * existed, and the README offered GeoJSON converters for the routes and
 * tracking APIs, and for the legacy Location API, none of which this service
 * serves. Two rules, over every `.md` file at the root rather than a list of
 * them:
 *
 * - every name a code block imports from this package is one it exports,
 *   checked by compiling the import, so a type counts as well as a value;
 * - every `…ToFeatureCollection` converter named anywhere, prose included,
 *   takes the response of one of this package's Places commands.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const docs = readdirSync(root)
  .filter((f) => f.endsWith('.md'))
  .map((f) => ({ file: f, text: readFileSync(join(root, f), 'utf8') }))

const ENTRY: Record<string, string> = {
  '@chaosity/location-client': '../src/index.js',
  '@chaosity/location-client/server': '../src/server/index.js',
}

/**
 * Each import from this package in a code block, rewritten as an import from
 * `src/` with every binding given a name of its own, so the blocks can share
 * one file without their names colliding.
 */
let n = 0
const imports = docs.flatMap(({ file, text }) =>
  codeBlocks(text).flatMap((block) => {
    const source = ts.createSourceFile(
      'block.ts',
      block.code,
      ts.ScriptTarget.Latest,
      true,
    )
    return source.statements
      .filter(ts.isImportDeclaration)
      .filter((s) => ts.isStringLiteral(s.moduleSpecifier))
      .flatMap((s) => {
        const target = ENTRY[(s.moduleSpecifier as ts.StringLiteral).text]
        const clause = s.importClause
        if (!target || !clause) return []
        const kind = clause.isTypeOnly ? 'import type' : 'import'
        const parts: string[] = []
        if (clause.name) parts.push(`${kind} _${n++} from '${target}'`)
        const bindings = clause.namedBindings
        if (bindings && ts.isNamespaceImport(bindings))
          parts.push(`${kind} * as _${n++} from '${target}'`)
        if (bindings && ts.isNamedImports(bindings)) {
          const names = bindings.elements.map(
            (el) =>
              `${el.isTypeOnly ? 'type ' : ''}${(el.propertyName ?? el.name).text} as _${n++}`,
          )
          parts.push(`${kind} { ${names.join(', ')} } from '${target}'`)
        }
        return parts.map((statement) => ({
          at: `${file}:${block.line}`,
          statement,
        }))
      })
  }),
)

describe('every name the docs import from this package exists', () => {
  it('found the imports it expects, so a rename cannot empty it', () => {
    expect(docs.map((d) => d.file)).toEqual(
      expect.arrayContaining(['README.md', 'ARCHITECTURE.md']),
    )
    expect(imports.length).toBeGreaterThan(20)
  })

  it('compiles every one of them against src/', () => {
    const source = imports.map((i) => `${i.statement} // ${i.at}`).join('\n')
    expect(typeErrors('__docs-imports__.ts', `${source}\n`)).toEqual([])
  }, 60_000)
})

describe('the only converters the docs name are for Places responses', () => {
  // `<operation>ResponseToFeatureCollection`, for an operation this package
  // has a Places command for. Autocomplete has none: its results carry no
  // position.
  const FITS = [
    'geocode',
    'reverseGeocode',
    'getPlace',
    'suggest',
    'searchText',
    'searchNearby',
  ].map((op) => `${op}ResponseToFeatureCollection`)

  const named = docs.flatMap(({ file, text }) =>
    [...text.matchAll(/\b\w+ToFeatureCollections?\b/g)].map((m) => ({
      name: m[0],
      at: `${file}:${text.slice(0, m.index).split('\n').length}`,
    })),
  )

  it('found some, so a rename cannot empty it', () => {
    expect(named.length).toBeGreaterThan(0)
  })

  it('names none that takes another API’s response', () => {
    expect(
      named
        .filter((n) => !FITS.includes(n.name))
        .map((n) => `${n.at} ${n.name}`),
    ).toEqual([])
  })
})
