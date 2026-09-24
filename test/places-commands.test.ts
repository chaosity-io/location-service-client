import * as Sdk from '@aws-sdk/client-geo-places'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

import * as Root from '../src/index'
import { resolveEndpoint } from '../src/transport/endpoints'
import { typeErrors } from './typecheck'

/**
 * The service never forwards `IntendedUse` or `Key` (#40).
 *
 * `IntendedUse` would let a caller choose the price bucket the service pays,
 * and `Key` would bill an Amazon Location key that is not the service's, so
 * both are stripped from every request. The SDK's command inputs declare both,
 * and this package used to re-export those commands untouched, so a caller
 * could write `IntendedUse: 'Storage'`, see it compile, and get a result that
 * carries no storage rights.
 *
 * Narrowing the re-exported input TYPES alone would not have changed that:
 * a command's constructor references the SDK's own input type. So the root
 * exports each command as a subclass whose constructor takes the narrowed
 * input, and this file checks it the only way a type can be checked — by
 * compiling code against it.
 *
 * The commands are read from the SDK's own exports, not listed here, so a
 * command the SDK adds fails until it is narrowed too.
 */

/**
 * Each stripped field with a value the SDK's own type ACCEPTS. With a value it
 * rejects ('x' as an IntendedUse), the line fails to compile before and after
 * the narrowing alike, so the @ts-expect-error below would pass for the wrong
 * reason — which is what the first version of this test did.
 */
const NEVER_FORWARDED = [
  ['IntendedUse', `'SingleUse'`],
  ['Key', `'k'`],
] as const

const COMMANDS = Object.keys(Sdk)
  .filter((k) => /^[A-Z]\w*Command$/.test(k))
  .map((k) => k.slice(0, -'Command'.length))
  .sort()

describe('every Places command the SDK has', () => {
  it('was found', () => {
    expect(COMMANDS).toContain('SearchText')
    expect(COMMANDS.length).toBeGreaterThanOrEqual(7)
  })

  it.each(COMMANDS)(
    '%sCommand is this package’s own, and still resolves',
    (name) => {
      const Ours = (Root as Record<string, unknown>)[`${name}Command`] as new (
        input: object,
      ) => { input: object }
      const Theirs = (Sdk as Record<string, unknown>)[`${name}Command`] as new (
        input: object,
      ) => object

      expect(Ours, 'exported from the root').toBeTypeOf('function')
      expect(Ours, 'narrowed, not the SDK class re-exported').not.toBe(Theirs)

      // A subclass, so everything keyed on the SDK class still recognises it.
      const cmd = new Ours({})
      expect(cmd).toBeInstanceOf(Theirs)
      expect(() => resolveEndpoint(cmd)).not.toThrow()
      // The body is the caller's input, unchanged: nothing is added or dropped.
      expect(cmd.input).toEqual({})
    },
  )
})

describe('the narrowed inputs refuse what the service strips', () => {
  // One generated file: for every command, every stripped field, and every
  // way a caller spells the input — the command's constructor, its
  // `<Name>CommandInput` and its `<Name>Request` — an assignment that must NOT
  // compile, marked @ts-expect-error. An unused directive is itself an error
  // (TS2578), so a field that compiles fails the check. A positive control per
  // command proves the rest of the input type is still intact.
  const source = [
    `import * as C from '../src/index.js'`,
    ...COMMANDS.flatMap((name) => [
      `declare const base${name}: C.${name}CommandInput`,
      `new C.${name}Command({ ...base${name} })`,
      ...NEVER_FORWARDED.flatMap(([field, value]) => [
        `// @ts-expect-error ${name}Command must not take ${field}`,
        `new C.${name}Command({ ...base${name}, ${field}: ${value} })`,
        `// @ts-expect-error ${name}CommandInput must not declare ${field}`,
        `const input${name}${field}: C.${name}CommandInput = { ...base${name}, ${field}: ${value} }`,
        `// @ts-expect-error ${name}Request must not declare ${field}`,
        `const request${name}${field}: C.${name}Request = { ...base${name}, ${field}: ${value} }`,
      ]),
    ]),
    '',
  ].join('\n')

  it('compiles with exactly the expected errors', () => {
    expect(typeErrors('__narrowed-commands__.ts', source)).toEqual([])
  }, 60_000)
})

describe('nothing in src/ builds or re-exports a Places command from the SDK', () => {
  // The adapter built them until review: its `GeocodeCommandInput` was the
  // SDK's, so an `IntendedUse` added there would have compiled and shipped,
  // which is the thing the narrowing exists to stop. A re-export is the other
  // way out — the identity test above covers the root, and nothing covered the
  // `./server` entry. Every file in src/ is read, and a VALUE import or
  // re-export of a `…Command` from the SDK is allowed only where it is the
  // point.
  const ALLOWED: Record<string, string> = {
    'src/client/commands.ts': 'the narrowing itself',
    'src/index.ts':
      'the root `export *`: its seven Places commands are shadowed by the named exports beside it, which the identity test above proves',
    'src/transport/endpoints.ts':
      'the instanceof base: an SDK class matches its subclasses too',
  }

  const root = join(dirname(fileURLToPath(import.meta.url)), '..')
  const files = (function walk(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory()
        ? walk(join(dir, e.name))
        : /\.[cm]?tsx?$/.test(e.name)
          ? [join(dir, e.name)]
          : [],
    )
  })(join(root, 'src'))

  // Read with TypeScript's own parser, not a pattern. Three regex versions of
  // this were each narrower than the rule: the first missed `X as Y`, the
  // second a re-export, the third a clause holding a comment with `from` in
  // it. A syntax tree has no comments, quote styles or line breaks to get
  // wrong. What counts as getting a VALUE from the SDK (or a subpath of it):
  // a named import or re-export of a `…Command`, aliased or not; a default,
  // namespace or `import x = require(…)` import, and an `export *`, each of
  // which carries every command; a dynamic `import()` or `require()`.
  // Type-only statements and specifiers build nothing.
  const SDK = '@aws-sdk/client-geo-places'
  const isSdk = (node: ts.Node | undefined): boolean =>
    !!node &&
    ts.isStringLiteralLike(node) &&
    (node.text === SDK || node.text.startsWith(`${SDK}/`))
  const isCommand = (el: ts.ImportSpecifier | ts.ExportSpecifier): boolean =>
    !el.isTypeOnly && /Command$/.test((el.propertyName ?? el.name).text)

  const importsACommand = (file: string, text: string): boolean => {
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
    let found = false
    const visit = (node: ts.Node): void => {
      if (found) return
      if (ts.isImportDeclaration(node) && isSdk(node.moduleSpecifier)) {
        const clause = node.importClause
        if (clause && !clause.isTypeOnly) {
          const bindings = clause.namedBindings
          if (clause.name) found = true
          else if (bindings && ts.isNamespaceImport(bindings)) found = true
          else if (bindings?.elements.some(isCommand)) found = true
        }
      } else if (ts.isExportDeclaration(node) && isSdk(node.moduleSpecifier)) {
        const clause = node.exportClause
        if (!node.isTypeOnly) {
          if (!clause || ts.isNamespaceExport(clause)) found = true
          else if (clause.elements.some(isCommand)) found = true
        }
      } else if (
        ts.isImportEqualsDeclaration(node) &&
        !node.isTypeOnly &&
        ts.isExternalModuleReference(node.moduleReference) &&
        isSdk(node.moduleReference.expression)
      ) {
        found = true
      } else if (
        ts.isCallExpression(node) &&
        (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(node.expression) &&
            node.expression.text === 'require')) &&
        isSdk(node.arguments[0])
      ) {
        found = true
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
    return found
  }

  const importers = files
    .filter((f) => importsACommand(f, readFileSync(f, 'utf8')))
    .map((f) => relative(root, f).split(sep).join('/'))
    .sort()

  it('found the files it expects, so a rename cannot empty it', () => {
    expect(files.length).toBeGreaterThan(10)
    expect(importers).toEqual(expect.arrayContaining(Object.keys(ALLOWED)))
  })

  it('finds no other importer', () => {
    expect(importers).toEqual(Object.keys(ALLOWED).sort())
  })
})
