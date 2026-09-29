import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

import {
  API_ERROR_CODES,
  CLIENT_ERROR_CODES,
  LOCATION_SERVICE_ERROR_CODES,
} from '../src/errors/LocationServiceException'
import { typeErrors } from './typecheck'

/**
 * `LocationServiceException.code` is typed (#38).
 *
 * It was a plain `string` with no list anywhere, so an integrator learned the
 * codes from failures. The API's codes come from its error contract, which is
 * published at https://docs.chaosity.cloud/api/errors; that list cannot be
 * enumerated from this repository, and is checked against the contract when
 * it changes. The codes this package raises ITSELF can be, so they are: every
 * `…Exception` string in `src/` must be a member, and every code the list says
 * only this package raises must still be raised somewhere outside
 * `LocationServiceException.ts`, the file that lists it.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
/** Where the union is declared: naming a code there is not raising it. */
const UNION_FILE = 'src/errors/LocationServiceException.ts'
const files = (function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? walk(join(dir, e.name))
      : /\.[cm]?tsx?$/.test(e.name)
        ? [join(dir, e.name)]
        : [],
  )
})(join(root, 'src'))

/**
 * Every string in `src/` that names an exception, with where it is. Read with
 * TypeScript's parser, so a quote style, a template literal or a line break
 * cannot hide one. `LocationServiceException` is the class's own name, not a
 * code.
 */
const written = files.flatMap((file) => {
  const text = readFileSync(file, 'utf8')
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
  const found: { code: string; at: string }[] = []
  const visit = (node: ts.Node): void => {
    if (
      (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
      /^[A-Z][A-Za-z]*Exception$/.test(node.text) &&
      node.text !== 'LocationServiceException'
    ) {
      const { line } = source.getLineAndCharacterOfPosition(node.getStart())
      found.push({
        code: node.text,
        at: `${relative(root, file).split(sep).join('/')}:${line + 1}`,
      })
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return found
})

describe('every code this package writes is in LocationServiceErrorCode', () => {
  it('found the codes it expects, so a rename cannot empty it', () => {
    expect(files.length).toBeGreaterThan(10)
    expect(written.map((w) => w.code)).toEqual(
      expect.arrayContaining(['NetworkException', 'AbortedException']),
    )
  })

  it.each(written.map((w) => [w.code, w.at]))('%s (%s)', (code) => {
    expect(LOCATION_SERVICE_ERROR_CODES).toContain(code)
  })

  it('lists no client-only code that nothing raises any more', () => {
    // The list's own file is not a raise: its array literals name every code,
    // so counting them would make this case pass whatever the rest of src/
    // does.
    const raised = new Set(
      written.filter((w) => !w.at.startsWith(UNION_FILE)).map((w) => w.code),
    )
    expect(CLIENT_ERROR_CODES.filter((c) => !raised.has(c))).toEqual([])
  })

  it('keeps the two halves apart and each code once', () => {
    const all = [...API_ERROR_CODES, ...CLIENT_ERROR_CODES]
    expect(new Set(all).size).toBe(all.length)
    expect([...LOCATION_SERVICE_ERROR_CODES].sort()).toEqual(all.sort())
  })
})

describe('the union is a type a caller can branch on', () => {
  it('names the codes, refuses a misspelling, and still takes a code it does not know', () => {
    const source = [
      `import { LocationServiceException, type LocationServiceErrorCode } from '../src/index.js'`,
      `declare const e: LocationServiceException`,
      `const known: LocationServiceErrorCode = 'ApplicationNotActiveException'`,
      `// @ts-expect-error a misspelt code is not a LocationServiceErrorCode`,
      `const misspelt: LocationServiceErrorCode = 'ApplicationNotActivException'`,
      `const asString: string = e.code`,
      `const narrowed: boolean = e.code === 'RateLimitExceededException'`,
      // A code the API adds after this release still compiles, and still
      // arrives: the union documents, it does not refuse.
      `const future = new LocationServiceException({ code: 'SomeFutureException', message: 'x' })`,
      `export { known, misspelt, asString, narrowed, future }`,
      '',
    ].join('\n')
    expect(typeErrors('__error-codes__.ts', source)).toEqual([])
  }, 60_000)
})
