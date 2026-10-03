import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

import * as Root from '../src/index'
import { typeErrors } from './typecheck'

/**
 * `send` resolves with the command's own output type (#68).
 *
 * It was `send<TInput, TOutput>(command: TInput): Promise<TOutput>`, and a type
 * parameter that only the return type mentions cannot be inferred from a call,
 * so it came back `unknown`: `(await client.send(new AutocompleteCommand(…)))
 * .ResultItems` did not compile unless the caller named the output type.
 *
 * Every command the root exports is checked, on both clients, by compiling a
 * file against `src/` — vitest strips types without checking them.
 */

const COMMANDS = Object.keys(Root)
  .filter((k) => /^[A-Z]\w*Command$/.test(k))
  .sort()

/** What `send` must resolve with, per command: the SDK's `<Name>CommandOutput`. */
const outputOf = (command: string): string =>
  command === 'VerifyAddressCommand'
    ? 'VerifyAddressResponse'
    : `${command}Output`

describe('send infers each command’s output', () => {
  it('found the commands, so an empty list cannot pass', () => {
    expect(COMMANDS).toEqual(
      expect.arrayContaining([
        'AutocompleteCommand',
        'SearchTextCommand',
        'VerifyAddressCommand',
      ]),
    )
    expect(COMMANDS.length).toBeGreaterThanOrEqual(8)
  })

  it('on GeoPlacesClient and LocationServiceConnector, for every command', () => {
    const lines = [
      `import * as C from '../src/index.js'`,
      `import { LocationServiceConnector } from '../src/server/index.js'`,
      `declare const client: C.GeoPlacesClient`,
      `declare const connector: LocationServiceConnector`,
      // Exact, both ways: an `any` or a supertype would satisfy a one-way check.
      `type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false`,
    ]
    for (const name of COMMANDS) {
      const out = outputOf(name)
      lines.push(
        `declare const cmd${name}: C.${name}`,
        `const sentClient${name} = client.send(cmd${name})`,
        `const okClient${name}: Equal<Awaited<typeof sentClient${name}>, C.${out}> = true`,
        `const sentConnector${name} = connector.send(cmd${name})`,
        `const okConnector${name}: Equal<Awaited<typeof sentConnector${name}>, C.${out}> = true`,
      )
    }
    expect(typeErrors('__send-output__.ts', lines.join('\n'))).toEqual([])
  }, 60_000)

  it('compiles the line the ticket reported, as written', () => {
    const source = [
      `import { AutocompleteCommand, GeoPlacesClient } from '../src/index.js'`,
      `declare const client: GeoPlacesClient`,
      `export async function run() {`,
      `  const result = await client.send(new AutocompleteCommand({ QueryText: '1 Martin Pl' }))`,
      `  return result.ResultItems`,
      `}`,
    ].join('\n')
    expect(typeErrors('__send-ticket__.ts', source)).toEqual([])
  }, 60_000)

  it('still takes both type arguments, and still fits a structural client', () => {
    // Two shapes callers already wrote: the explicit pair of type arguments,
    // and an interface that asks for `send<TInput, TOutput>` — which is what
    // @chaosity/address-form types its client as. Both must keep compiling,
    // so the old signature stays as the second overload.
    const source = [
      `import { AutocompleteCommand, GeoPlacesClient, type AutocompleteCommandOutput, type RequestOptions } from '../src/index.js'`,
      `import { LocationServiceConnector } from '../src/server/index.js'`,
      `declare const client: GeoPlacesClient`,
      `declare const connector: LocationServiceConnector`,
      `declare const cmd: AutocompleteCommand`,
      `const explicit: Promise<AutocompleteCommandOutput> = client.send<AutocompleteCommand, AutocompleteCommandOutput>(cmd)`,
      `interface Structural { send<TInput, TOutput>(command: TInput, options?: RequestOptions): Promise<TOutput> }`,
      `const fromClient: Structural = client`,
      `const fromConnector: Structural = connector`,
    ].join('\n')
    expect(typeErrors('__send-compat__.ts', source)).toEqual([])
  }, 60_000)
})

describe('GeoPlaces takes anything with the client’s send (#65)', () => {
  it('accepts an object that has only send', () => {
    // @chaosity/location-client-react hands out an interface whose `send`
    // matches the core's, not a GeoPlacesClient, and a class with private
    // fields admits no other object: its README example failed TS2345.
    const source = [
      `import type { Map } from 'maplibre-gl'`,
      `import { GeoPlaces, type RequestOptions } from '../src/index.js'`,
      `declare const map: Map`,
      `const onlySend = {`,
      `  send<TInput, TOutput>(command: TInput, options?: RequestOptions): Promise<TOutput> {`,
      `    return Promise.reject(new Error(String(command) + String(options)))`,
      `  },`,
      `}`,
      `export const geocoder = new GeoPlaces(onlySend, map)`,
    ].join('\n')
    expect(typeErrors('__geoplaces-send__.ts', source)).toEqual([])
  }, 60_000)
})

describe('no public generic signature hides its output from inference', () => {
  // The mechanism, enumerated over the package's public surface rather than
  // the two `send`s the ticket named: a function or public method whose type
  // parameter no parameter mentions. Such a parameter defaults to `unknown`
  // at every call that does not spell it out.
  const ALLOWED: Record<string, string> = {
    'GeoPlacesClient.send#2<TOutput>':
      'the second overload, kept so `send<TInput, TOutput>(…)` and structural clients still compile; the first infers',
    'LocationServiceConnector.send#2<TOutput>':
      'the second overload, kept for the same callers as GeoPlacesClient.send',
  }

  const here = dirname(fileURLToPath(import.meta.url))
  const config = ts.getParsedCommandLineOfConfigFile(
    join(here, '../tsconfig.json'),
    {},
    { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => {} },
  )!
  const entries = [
    join(here, '../src/index.ts'),
    join(here, '../src/server/index.ts'),
  ]
  const program = ts.createProgram(entries, {
    ...config.options,
    noEmit: true,
  })
  const checker = program.getTypeChecker()

  const hidden = new Set<string>()
  let signatures = 0
  const check = (owner: string, decl: ts.SignatureDeclaration): void => {
    signatures++
    if (!decl.typeParameters?.length) return
    const used = new Set<string>()
    const walk = (n: ts.Node): void => {
      if (ts.isTypeReferenceNode(n) && ts.isIdentifier(n.typeName))
        used.add(n.typeName.text)
      ts.forEachChild(n, walk)
    }
    for (const p of decl.parameters) if (p.type) walk(p.type)
    for (const tp of decl.typeParameters)
      if (!used.has(tp.name.text)) hidden.add(`${owner}<${tp.name.text}>`)
  }
  // What a caller sees: an overloaded function's or method's overload
  // signatures, numbered in order, and never its implementation; otherwise
  // its one declaration, as #1.
  const checkAll = (owner: string, decls: ts.SignatureDeclaration[]): void => {
    const overloads = decls.filter((d) => !('body' in d) || !d.body)
    const seen = overloads.length ? overloads : decls
    seen.forEach((d, i) => check(`${owner}#${i + 1}`, d))
  }
  for (const entry of entries) {
    const mod = checker.getSymbolAtLocation(program.getSourceFile(entry)!)!
    for (const exported of checker.getExportsOfModule(mod)) {
      const symbol =
        exported.flags & ts.SymbolFlags.Alias
          ? checker.getAliasedSymbol(exported)
          : exported
      const decls = (symbol.declarations ?? []).filter((d) =>
        d.getSourceFile().fileName.includes('/src/'),
      )
      checkAll(exported.name, decls.filter(ts.isFunctionDeclaration))
      for (const cls of decls.filter(ts.isClassDeclaration)) {
        const byName = new Map<string, ts.SignatureDeclaration[]>()
        for (const member of cls.members) {
          if (
            !ts.isMethodDeclaration(member) &&
            !ts.isConstructorDeclaration(member)
          )
            continue
          const flags = ts.getCombinedModifierFlags(member)
          if (flags & (ts.ModifierFlags.Private | ts.ModifierFlags.Protected))
            continue
          if (member.name && ts.isPrivateIdentifier(member.name)) continue
          const name = member.name?.getText() ?? 'constructor'
          byName.set(name, [...(byName.get(name) ?? []), member])
        }
        for (const [name, members] of byName)
          checkAll(`${exported.name}.${name}`, members)
      }
    }
  }

  it('read the public surface, so an empty walk cannot pass', () => {
    expect(signatures).toBeGreaterThan(20)
  })

  it('finds no signature outside the allowed list', () => {
    expect([...hidden].sort()).toEqual(Object.keys(ALLOWED).sort())
  })
})
