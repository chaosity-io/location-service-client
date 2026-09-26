import * as Sdk from '@aws-sdk/client-geo-places'
import { readFileSync } from 'node:fs'
import { dirname, join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { afterEach, describe, expect, it, vi } from 'vitest'

import * as Root from '../src/index'
import { LocationServiceException, fetchMapStyle } from '../src/index'
import { parseErrorResponse } from '../src/transport/errors'
import { codeBlocks } from './readme-blocks'

/**
 * Plan features (#55).
 *
 * The service gates some options by plan: the map features `satellite`,
 * `traffic`, `terrain`, `buildings`, `contours`, `travel-modes` and
 * `political-view`, and rich place data (the `AdditionalFeatures` in
 * RICH_FEATURES). An
 * application whose plan lacks one is answered 403
 * `FeatureNotEntitledException`, and the token carries no feature list, so the
 * 403 is the first a caller hears of it. An option documented like every other
 * one is found out there.
 *
 * So every gated option and every gated value carries a `@planFeature` tag
 * naming the feature the refusal names:
 *
 *   @planFeature <feature>           the option, or every value of the list
 *   @planFeature <feature> — A, B    only those values
 *
 * This file holds the classification, and reads the domain from the source
 * rather than from a list: every object type and every `as const` value the
 * root exports from `src/`, and every `…AdditionalFeature` enum of the SDK.
 * Anything unclassified fails, and so does a tag that disagrees with the
 * table — so a new option cannot land unnoted, and a moved one cannot keep its
 * old note. The service's gate tables are the authority this mirrors.
 */

const OPEN = null
/** The `@planFeature` text an option must carry, or OPEN for none. */
type Classification = string | null

const RICH = 'rich place data'

/** Every key of every option type that reaches a gated route. */
const OPTION_TYPES: Record<string, Record<string, Classification>> = {
  MapStyleOptions: {
    colorScheme: OPEN,
    politicalView: 'political-view',
    terrain: 'terrain',
    buildings: 'buildings',
    contourDensity: 'contours',
    traffic: 'traffic',
    travelModes: 'travel-modes',
    poiDensity: OPEN,
    poiCategories: OPEN,
  },
  StaticMapOptions: {
    width: OPEN,
    height: OPEN,
    center: OPEN,
    boundingBox: OPEN,
    boundedPositions: OPEN,
    zoom: OPEN,
    radius: OPEN,
    padding: OPEN,
    cropLabels: OPEN,
    // Also when omitted: the service renders Satellite by default.
    style: 'satellite — Satellite',
    colorScheme: OPEN,
    labelSize: OPEN,
    pointsOfInterests: OPEN,
    scaleBarUnit: OPEN,
    fileName: OPEN,
    politicalView: 'political-view',
    language: OPEN,
    compactOverlay: OPEN,
    geoJsonOverlay: OPEN,
  },
  GeoPlacesDetailOptions: {
    access: RICH,
    secondaryAddresses: OPEN,
    contact: RICH,
    timeZone: RICH,
  },
  // Its own command, not an SDK input, so it is classified here (#54).
  VerifyAddressCommandInput: { PlaceId: OPEN },
}

/** Exported object types that carry no request parameter, and why. */
const NOT_REQUEST_OPTIONS: Record<string, string> = {
  GeoPlacesOptions:
    'its one key, `details`, is GeoPlacesDetailOptions, classified above',
  RequestOptions:
    'transport: cancellation, timeouts and retry; nothing in it is sent',
  SendOptions: 'RequestOptions, under the name GeoPlacesClient.send takes',
  LocationServiceExceptionOptions: 'constructs an error; sends nothing',
  ClientConfig: 'the API URL and token a client is built with',
  GeoPlacesCommand:
    "the shape of a sendable command; its input is the command's own, classified under the Places commands below",
  MapLike: 'the slice of a MapLibre map applyMapLanguage touches; client-side',
  AppConfigClaims: 'read from the token for display; sends nothing',
  VerifyAddressResponse: "the service's answer to a verify; sends nothing",
}

/** Every value of every exported `as const` list: its feature, or OPEN. */
const VALUE_LISTS: Record<string, Record<string, Classification>> = {
  MAP_STYLES: {
    Hybrid: 'satellite',
    Monochrome: OPEN,
    Satellite: 'satellite',
    Standard: OPEN,
  },
  STATIC_MAP_STYLES: { Satellite: 'satellite', Standard: OPEN },
  COLOR_SCHEMES: { Dark: OPEN, Light: OPEN },
  TERRAINS: { Hillshade: 'terrain', Terrain3D: 'terrain' },
  BUILDINGS: { Buildings3D: 'buildings' },
  CONTOUR_DENSITIES: { High: 'contours', Low: 'contours', Medium: 'contours' },
  TRAFFIC_MODES: { All: 'traffic', Congestion: 'traffic' },
  TRAVEL_MODES: { Transit: 'travel-modes', Truck: 'travel-modes' },
  SPRITE_VARIANTS: { Default: OPEN },
  LABEL_SIZES: { Large: OPEN, Small: OPEN },
  SCALE_BAR_UNITS: {
    Kilometers: OPEN,
    KilometersMiles: OPEN,
    Miles: OPEN,
    MilesKilometers: OPEN,
  },
  MAP_FEATURE_MODES: { Disabled: OPEN, Enabled: OPEN },
  POI_DENSITIES: {
    Default: OPEN,
    Dense: OPEN,
    Off: OPEN,
    Sparse: OPEN,
    VeryDense: OPEN,
    VerySparse: OPEN,
  },
  STYLE_POI_CATEGORIES: {
    Accommodations: OPEN,
    BusinessAndServices: OPEN,
    Entertainment: OPEN,
    FacilitiesAndBuildings: OPEN,
    FoodAndDrink: OPEN,
    LeisureAndOutdoor: OPEN,
    Shopping: OPEN,
    SightsAndMuseums: OPEN,
    Transportation: OPEN,
  },
}

/** Exported `as const` values that are never sent, and why. */
const NOT_REQUEST_VALUES: Record<string, string> = {
  POI_CATEGORIES:
    'MapLibre layer ids, toggled on a map already loaded; never sent',
}

/** Every SDK `AdditionalFeatures` value: rich place data, or open. */
const RICH_FEATURES = ['Access', 'Contact', 'Phonemes', 'TimeZone']
const OPEN_FEATURES = [
  'Core',
  'CrossReferences',
  'Intersections',
  'SecondaryAddresses',
]

// ---------------------------------------------------------------------------
// The domain, read from the source.

const here = dirname(fileURLToPath(import.meta.url))
const SRC = join(here, '../src') + sep
const ROOT_FILE = join(here, '../src/index.ts')

const config = ts.getParsedCommandLineOfConfigFile(
  join(here, '../tsconfig.json'),
  {},
  { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => {} },
)
if (!config) throw new Error('tsconfig.json did not parse')
const program = ts.createProgram([ROOT_FILE], {
  ...config.options,
  noEmit: true,
})
const checker = program.getTypeChecker()

interface Exported {
  name: string
  decl: ts.Declaration
}

const exported: Exported[] = checker
  .getExportsOfModule(
    checker.getSymbolAtLocation(program.getSourceFile(ROOT_FILE)!)!,
  )
  .flatMap((symbol) => {
    const target =
      symbol.flags & ts.SymbolFlags.Alias
        ? checker.getAliasedSymbol(symbol)
        : symbol
    return (target.declarations ?? [])
      .filter((d) => d.getSourceFile().fileName.startsWith(SRC))
      .map((decl) => ({ name: symbol.name, decl }))
  })

const isObjectType = (d: ts.Declaration): boolean => {
  if (ts.isInterfaceDeclaration(d)) return true
  if (!ts.isTypeAliasDeclaration(d)) return false
  const type = checker.getTypeAtLocation(d.name)
  return (type.flags & ts.TypeFlags.Object) !== 0 || type.isIntersection()
}

const isConstValue = (d: ts.Declaration): d is ts.VariableDeclaration =>
  ts.isVariableDeclaration(d) &&
  !!d.initializer &&
  ts.isAsExpression(d.initializer) &&
  ts.isTypeReferenceNode(d.initializer.type) &&
  d.initializer.type.typeName.getText() === 'const'

/** The Places commands, read from the SDK as places-commands.test.ts does. */
const COMMANDS = Object.keys(Sdk)
  .filter((k) => /^[A-Z]\w*Command$/.test(k))
  .map((k) => k.slice(0, -'Command'.length))
  .sort()

/** `<Name>CommandInput` / `<Name>Request`: the SDK's inputs, narrowed (#40). */
const COMMAND_INPUTS = new Set(
  COMMANDS.flatMap((c) => [`${c}CommandInput`, `${c}Request`]),
)

const objectTypes = exported.filter(
  (e) => isObjectType(e.decl) && !COMMAND_INPUTS.has(e.name),
)
const constValues = exported.filter((e) => isConstValue(e.decl))

const planTags = (node: ts.Node): string[] =>
  ts
    .getJSDocTags(node)
    .filter((t) => t.tagName.text === 'planFeature')
    .map((t) => (ts.getTextOfJSDocComment(t.comment) ?? '').trim())

const declOf = (name: string): ts.Declaration => {
  const found = exported.find((e) => e.name === name)
  if (!found) throw new Error(`${name} is not exported from the root`)
  return found.decl
}

/** What a value list's tags must say, derived from its classification. */
const expectedListTags = (values: Record<string, Classification>) => {
  const byFeature = new Map<string, string[]>()
  for (const [value, feature] of Object.entries(values)) {
    if (feature === OPEN) continue
    byFeature.set(feature, [...(byFeature.get(feature) ?? []), value])
  }
  const all = Object.keys(values).length
  return [...byFeature]
    .map(([feature, gated]) =>
      gated.length === all ? feature : `${feature} — ${gated.join(', ')}`,
    )
    .sort()
}

describe('the domain, enumerated from src/', () => {
  it('found what it enumerates', () => {
    // A rename that empties the enumeration must not pass as "nothing to check".
    expect(objectTypes.map((e) => e.name)).toContain('MapStyleOptions')
    expect(constValues.map((e) => e.name)).toContain('MAP_STYLES')
    expect(COMMANDS).toContain('GetPlace')
  })

  it('classifies every exported object type', () => {
    const names = [...new Set(objectTypes.map((e) => e.name))].sort()
    const classified = [
      ...Object.keys(OPTION_TYPES),
      ...Object.keys(NOT_REQUEST_OPTIONS),
    ].sort()
    expect(names).toEqual(classified)
  })

  it('classifies every exported `as const` value', () => {
    const names = constValues.map((e) => e.name).sort()
    const classified = [
      ...Object.keys(VALUE_LISTS),
      ...Object.keys(NOT_REQUEST_VALUES),
    ].sort()
    expect(names).toEqual(classified)
  })
})

describe.each(Object.entries(OPTION_TYPES))('%s', (typeName, keys) => {
  const decl = declOf(typeName)
  const properties = checker
    .getPropertiesOfType(checker.getTypeAtLocation(decl))
    .filter((p) => p.valueDeclaration)

  it('has every key classified, and no stale one', () => {
    expect(properties.map((p) => p.name).sort()).toEqual(
      Object.keys(keys).sort(),
    )
  })

  it.each(Object.entries(keys))(
    '%s is documented as %s',
    (key, classification) => {
      const property = properties.find((p) => p.name === key)
      expect(property, `${typeName}.${key}`).toBeDefined()
      expect(planTags(property!.valueDeclaration!)).toEqual(
        classification === OPEN ? [] : [classification],
      )
    },
  )
})

/** The JSDoc text a declaration shows on hover, tags included. */
const docText = (node: ts.Node): string =>
  ts
    .getJSDocCommentsAndTags(node)
    .map((d) => d.getText())
    .join('\n')

/**
 * A tag says WHICH feature; the refusal it earns has to be explained where an
 * editor shows it, or a caller hovering `SearchTextCommand` sees a bare tag
 * (#55, review round 1). So every declaration a caller hovers that carries a
 * tag — an option type, a value list, a command, and each tagged property,
 * which is what a hover inside an object literal shows (review round 2) —
 * names the refusal itself.
 */
const REFUSAL = /FeatureNotEntitledException|FEATURE_NOT_ENTITLED/

describe('every tagged declaration explains the refusal where it is hovered', () => {
  // An option type with no gated key carries no tag, and nothing to explain.
  it.each(
    Object.entries(OPTION_TYPES)
      .filter(([, keys]) => Object.values(keys).some((c) => c !== OPEN))
      .map(([name]) => name),
  )('%s', (typeName) => {
    expect(docText(declOf(typeName))).toMatch(REFUSAL)
  })

  it.each(
    Object.entries(VALUE_LISTS)
      .filter(([, values]) => Object.values(values).some((f) => f !== OPEN))
      .map(([name]) => name),
  )('%s', (listName) => {
    expect(docText(declOf(listName))).toMatch(REFUSAL)
  })

  it.each(
    Object.entries(OPTION_TYPES).flatMap(([typeName, keys]) =>
      Object.entries(keys)
        .filter(([, c]) => c !== OPEN)
        .map(([key]) => [typeName, key]),
    ),
  )('%s.%s', (typeName, key) => {
    const property = checker
      .getPropertiesOfType(checker.getTypeAtLocation(declOf(typeName)))
      .find((p) => p.name === key)
    expect(docText(property!.valueDeclaration!)).toMatch(REFUSAL)
  })

  it.each(COMMANDS)('%sCommand, when it accepts rich place data', (c) => {
    const decl = declOf(`${c}Command`)
    if (!planTags(decl).length) return
    expect(docText(decl)).toMatch(REFUSAL)
  })
})

describe.each(Object.entries(VALUE_LISTS))('%s', (listName, values) => {
  const decl = declOf(listName) as ts.VariableDeclaration

  it('has every value classified, and no stale one', () => {
    const list = (Root as Record<string, unknown>)[listName] as string[]
    expect([...list].sort()).toEqual(Object.keys(values).sort())
  })

  it('names the feature of each gated value', () => {
    expect(planTags(decl).sort()).toEqual(expectedListTags(values))
  })
})

describe('the Places commands', () => {
  const enums = Object.entries(Sdk).filter(([k]) =>
    /AdditionalFeature$/.test(k),
  ) as [string, Record<string, string>][]

  it('found the SDK’s AdditionalFeature enums', () => {
    expect(enums.map(([k]) => k)).toContain('GetPlaceAdditionalFeature')
  })

  it.each(enums)('%s: every value is classified', (_, values) => {
    for (const value of Object.values(values)) {
      expect(
        [...RICH_FEATURES, ...OPEN_FEATURES],
        `${value} is neither rich place data nor open`,
      ).toContain(value)
    }
  })

  it.each(COMMANDS)('%sCommand names the rich place data it accepts', (c) => {
    const values = Object.values(
      ((Sdk as Record<string, unknown>)[`${c}AdditionalFeature`] ??
        {}) as Record<string, string>,
    )
    const rich = RICH_FEATURES.filter((f) => values.includes(f))
    expect(planTags(declOf(`${c}Command`))).toEqual(
      rich.length ? [`${RICH} — ${rich.join(', ')}`] : [],
    )
  })
})

// ---------------------------------------------------------------------------
// The refusal, typed.

const refusal = (code: string) =>
  parseErrorResponse(
    403,
    'Forbidden',
    JSON.stringify({ message: 'refused', code, requestId: 'r' }),
  )

describe('FeatureNotEntitledException is typed', () => {
  it('is exported as a constant', () => {
    expect((Root as Record<string, unknown>).FEATURE_NOT_ENTITLED).toBe(
      'FeatureNotEntitledException',
    )
  })

  it('is told apart from the other 403s', () => {
    expect(refusal('FeatureNotEntitledException').isFeatureNotEntitled).toBe(
      true,
    )
    expect(refusal('ForbiddenException').isFeatureNotEntitled).toBe(false)
    expect(refusal('OriginNotAllowedException').isFeatureNotEntitled).toBe(
      false,
    )
  })

  it('leaves isAuth as it was: every 401 and 403', () => {
    for (const code of [
      'FeatureNotEntitledException',
      'ForbiddenException',
      'OriginNotAllowedException',
    ]) {
      expect(refusal(code).isAuth, code).toBe(true)
    }
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('reaches a fetchMapStyle caller', async () => {
    const message =
      "This application's plan does not include the map feature terrain (terrain=Terrain3D)."
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(
        async () =>
          new Response(
            JSON.stringify({
              message,
              code: 'FeatureNotEntitledException',
              requestId: 'r',
            }),
            { status: 403, headers: { 'content-type': 'application/json' } },
          ),
      ),
    )

    const error = await fetchMapStyle(
      'https://api.example.com',
      'Standard',
      () => 'tok',
      { terrain: 'Terrain3D' },
    ).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(LocationServiceException)
    expect((error as LocationServiceException).isFeatureNotEntitled).toBe(true)
    expect((error as LocationServiceException).message).toBe(message)
    // A 403 is never retried: a new attempt cannot change the plan.
    expect(fetch).toHaveBeenCalledTimes(1)
  })
})

// ---------------------------------------------------------------------------
// The README: a gated option appears only in an example marked as needing it.

const README = readFileSync(join(here, '../README.md'), 'utf8')

/**
 * Every fenced code block, and whether the prose right before it marks it as
 * needing a plan feature. The marker is the last non-empty line above the
 * fence naming "plan feature".
 */
const markedBlocks = (markdown: string) =>
  codeBlocks(markdown).map((b) => ({
    ...b,
    marked: /plan feature/i.test(b.preceding),
  }))

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** What in a code block asks for a plan feature. Derived, never listed. */
const GATED_TOKENS: RegExp[] = [
  // An option gated whatever its value, set or declared: `terrain:`,
  // `terrain?:`, `access:` …
  ...Object.values(OPTION_TYPES).flatMap((keys) =>
    Object.entries(keys)
      .filter(([, c]) => c !== OPEN && !c.includes(' — '))
      .map(([key]) => new RegExp(`\\b${escape(key)}\\??\\s*:`)),
  ),
  // A gated value: 'Satellite', 'Terrain3D' …
  ...[
    ...new Set(
      Object.values(VALUE_LISTS).flatMap((values) =>
        Object.entries(values)
          .filter(([, f]) => f !== OPEN)
          .map(([v]) => v),
      ),
    ),
  ].map((v) => new RegExp(`['"]${escape(v)}['"]`)),
  // Rich place data, by value or by the SDK's constant name.
  ...RICH_FEATURES.map((f) => new RegExp(`['"]${f}['"]`)),
  ...RICH_FEATURES.map(
    (f) =>
      new RegExp(
        `\\.${f.replace(/([a-z])([A-Z])/g, '$1_$2').toUpperCase()}\\b`,
      ),
  ),
]

describe('the README', () => {
  const blocks = markedBlocks(README)

  it('has code blocks to check', () => {
    expect(blocks.length).toBeGreaterThan(10)
  })

  it('asks for a plan feature only in an example marked as needing it', () => {
    const offending = blocks
      .filter((b) => !b.marked)
      .flatMap((b) =>
        GATED_TOKENS.filter((re) => re.test(b.code)).map(
          (re) => `README.md:${b.line} ${re}`,
        ),
      )
    expect(offending).toEqual([])
  })

  it('never lets a static map default to Satellite unmarked', () => {
    const offending = blocks
      .filter((b) => !b.marked)
      .filter((b) => /\b(fetchStaticMap|buildStaticMapUrl)\(/.test(b.code))
      .filter((b) => !/\bstyle\s*:/.test(b.code))
      .map((b) => `README.md:${b.line}`)
    expect(offending).toEqual([])
  })

  it('names every feature, the code and the getter under Plan features', () => {
    const start = README.search(/^#+ Plan features\s*$/m)
    expect(start, 'a "Plan features" section').toBeGreaterThan(-1)
    const level = README.slice(start).match(/^#+/)![0].length
    const rest = README.slice(start + level)
    const next = rest.search(new RegExp(`^#{1,${level}} `, 'm'))
    const section = next === -1 ? rest : rest.slice(0, next)

    const features = new Set([
      ...Object.values(OPTION_TYPES).flatMap((keys) =>
        Object.values(keys)
          .filter((c): c is string => c !== OPEN)
          .map((c) => c.split(' — ')[0]),
      ),
      ...Object.values(VALUE_LISTS).flatMap((values) =>
        Object.values(values).filter((f): f is string => f !== OPEN),
      ),
    ])
    for (const feature of features) {
      expect(section, feature).toContain(`\`${feature}\``)
    }
    expect(section).toContain('FeatureNotEntitledException')
    expect(section).toContain('isFeatureNotEntitled')
  })
})
