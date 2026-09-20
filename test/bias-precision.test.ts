import { SearchTextCommand } from '@aws-sdk/client-geo-places'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GeoPlacesClient } from '../src/client/GeoPlacesClient'
import { LocationServiceConnector } from '../src/server/LocationServiceConnector'

/**
 * A coordinate the caller supplied is the coordinate that goes on the wire
 * (#51).
 *
 * This library used to round `BiasPosition` onto a grid before sending, so two
 * callers within the same cell would share one upstream answer. Nothing shares
 * anything any more: the service answers every Places request live and forwards
 * the body verbatim, so the rounding only lowered the precision Amazon Location
 * got to work with.
 *
 * It is not a coarser answer, it is a different one. A 3 dp grid is ~111 m
 * across, so rounding onto it displaces a coordinate by up to ~70 m — and
 * measured against this service, that is already enough to turn the result
 * set over:
 *
 *   a coordinate at a cell centre -> Bar Fino     | Max Brenner   | Atrio
 *   the same point rounded to 3 dp -> Deli Ziosa  | CBD Patisserie | Bar Fino
 *
 * A caller passing an exact coordinate got results chosen for a point up to
 * ~70 m away, with nothing in the response saying so — and only callers using
 * this SDK, since plain HTTP against the same service never had the problem.
 */

const API = 'https://api.test'

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src')

/** Deliberately more precise than any grid this library ever rounded to. */
const EXACT: [number, number] = [151.21536789, -33.85681234]

/** What 3 dp — the old default, and what every caller was getting — produced. */
const OLD_3DP = [151.215, -33.857]

const jwt = (claims: Record<string, unknown> = {}) => {
  const b64 = (o: unknown) =>
    Buffer.from(JSON.stringify(o)).toString('base64url')
  return `${b64({ alg: 'HS256' })}.${b64({
    exp: Math.floor(Date.now() / 1000) + 900,
    ...claims,
  })}.s`
}

const ok = () =>
  new Response(JSON.stringify({ ResultItems: [] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })

let fetchMock: ReturnType<typeof vi.fn>

/** The body of the one data request that was sent. */
const sentBody = () => {
  const calls = fetchMock.mock.calls.filter(
    ([url]: [string]) => !String(url).endsWith('/auth/token'),
  )
  expect(calls).toHaveLength(1)
  return JSON.parse(calls[0]![1].body)
}

beforeEach(() => {
  fetchMock = vi.fn().mockImplementation(async () => ok())
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

/**
 * Both transports, every case — the defect was in a shared helper and each
 * path called it for itself, so a fix applied to one proves nothing about the
 * other.
 */
const transports = [
  [
    'browser',
    async (token: string, input: Record<string, unknown>) => {
      const client = new GeoPlacesClient({ apiUrl: API, token } as never)
      await client.send(new SearchTextCommand(input) as never)
    },
  ],
  [
    'server',
    async (token: string, input: Record<string, unknown>) => {
      const connector = new LocationServiceConnector({
        apiUrl: API,
        origin: 'https://allowed.example',
        token,
      })
      await connector.send(new SearchTextCommand(input) as never)
    },
  ],
] as const

describe.each(transports)(
  'the %s transport sends what it was given',
  (_name, send) => {
    it('sends BiasPosition at the callers precision, not a grid', async () => {
      await send(jwt(), { QueryText: 'cafe', BiasPosition: [...EXACT] })

      expect(sentBody().BiasPosition).toEqual(EXACT)
      expect(sentBody().BiasPosition).not.toEqual(OLD_3DP)
    })

    it('ignores a biasDecimals claim, which no token carries any more', async () => {
      // The entitlement existed to size cache cells. A token still carrying one
      // — an old token mid-flight, a hand-made one — must not resurrect the
      // rounding, or the defect comes back for exactly the callers who had it.
      await send(jwt({ biasDecimals: 3 }), {
        QueryText: 'cafe',
        BiasPosition: [...EXACT],
      })

      expect(sentBody().BiasPosition).toEqual(EXACT)
    })

    it('leaves QueryPosition alone, as it always did', async () => {
      // Reverse geocode resolves an exact point a user clicked or a device
      // reported; rounding it returns a neighbour's address. This was already
      // true and is the half of the old behaviour worth keeping.
      await send(jwt(), { QueryPosition: [...EXACT] })

      expect(sentBody().QueryPosition).toEqual(EXACT)
    })

    it('does not disturb the rest of the input', async () => {
      await send(jwt(), {
        QueryText: 'cafe',
        BiasPosition: [...EXACT],
        MaxResults: 5,
        Filter: { IncludeCountries: ['AU'] },
      })

      expect(sentBody()).toEqual({
        QueryText: 'cafe',
        BiasPosition: EXACT,
        MaxResults: 5,
        Filter: { IncludeCountries: ['AU'] },
      })
    })

    it('does not mutate the caller command input', async () => {
      const input = { QueryText: 'cafe', BiasPosition: [...EXACT] }
      await send(jwt(), input)

      expect(input.BiasPosition).toEqual(EXACT)
    })
  },
)

/**
 * The guard for the rule the fix introduces, rather than for the two sites it
 * was fixed at.
 *
 * `describe.each` above enumerates the transports that exist today, which is a
 * list someone has to remember to extend. This reads `src/` instead, so a
 * third send path — or a shaping step added to one of the two — has to come
 * past this test rather than past whoever is reviewing that day.
 */
describe('no request body is derived from anything but the caller input', () => {
  const sources = () => {
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
        const full = join(dir, e.name)
        return e.isDirectory() ? walk(full) : full.endsWith('.ts') ? [full] : []
      })
    return walk(SRC).map((file) => ({ file, text: readFileSync(file, 'utf8') }))
  }

  const rel = (file: string) => file.slice(file.indexOf('/src/') + 1)

  /**
   * A body written inline (`{ method, headers, body: X },`) ends the line with
   * the enclosing brackets, so the capture carries them. Strip only what the
   * expression does not open itself — balancing rather than trimming a fixed
   * set of characters, or `JSON.stringify({ a: 1 })` would lose its own.
   */
  const normalise = (raw: string) => {
    let expr = raw.trim().replace(/,+$/, '').trim()
    const unbalanced = (open: string, close: string) =>
      expr.split(close).length - expr.split(open).length > 0
    let changed = true
    while (changed) {
      changed = false
      if (/[)}\]]$/.test(expr)) {
        const last = expr.at(-1)!
        const pair: Record<string, string> = { ')': '(', '}': '{', ']': '[' }
        if (unbalanced(pair[last]!, last)) {
          expr = expr.slice(0, -1).trim().replace(/,+$/, '').trim()
          changed = true
        }
      }
    }
    return expr
  }

  /**
   * The `body` sites that are NOT a data request, each with the reason. A
   * guard with a silent escape hatch is worse than none, so every entry is
   * asserted to still exist — delete the site and this list fails rather than
   * quietly shrinking.
   */
  const NOT_A_DATA_BODY: Record<string, string> = {
    'src/auth/TokenProvider.ts':
      'the /auth/token form body — built from credentials, no caller command exists',
    'src/transport/errors.ts': 'a function parameter named body, not a request',
  }

  it('sends cmd.input as the body, in every form a body can be written', () => {
    // Deliberately wider than `body: JSON.stringify(...)`. A shaping step does
    // not have to arrive in that shape: hoisting the value to a const and
    // passing it as shorthand (`{ method, headers, body }`) is the obvious way
    // to write one, and the whole point of this guard is the author who has
    // NOT read the rule above. So: find every `body` in a request-init
    // position, resolve shorthand back to its assignment, and require what it
    // resolves to.
    const seen: { file: string; expr: string }[] = []

    for (const { file, text } of sources()) {
      const lines = text.split('\n')
      const assignments = new Map<number, string>()
      lines.forEach((line, i) => {
        // Every assignment TO `body`, not just its declaration: a shaping
        // step is as easily written as a reassignment two lines later, and
        // nearest-above then resolves the shorthand to the shaped value.
        const assigned =
          /^\s*(?:(?:const|let|var)\s+)?body\s*(?::[^=]+)?=\s*(.+?),?\s*$/.exec(
            line,
          )
        if (assigned) assignments.set(i, assigned[1]!)
      })

      lines.forEach((line, i) => {
        const trimmed = line.trim()
        if (/^\s*(?:(?:const|let|var)\s+)?body\s*(?::[^=]+)?=/.test(line))
          return
        if (trimmed.startsWith('*') || trimmed.startsWith('//')) return

        // `body: <expr>` — a property with a value.
        // Matched per line, so a Prettier-wrapped `body: JSON.stringify(`
        // captures only the opening and fails. That false positive is on the
        // safe side and is left deliberately: it says "come and look", which
        // for this guard is the right direction to be wrong in.
        const property = /\bbody\s*:\s*(.+?),?\s*$/.exec(line)
        // `body,` or `body }` — ES6 shorthand, value comes from a const above.
        const shorthand = /\bbody\s*[,}]/.test(line) && !/\bbody\s*:/.test(line)

        if (property) {
          seen.push({ file, expr: normalise(property[1]!) })
        } else if (shorthand) {
          const from = [...assignments.entries()]
            .filter(([at]) => at < i)
            .sort((a, b) => b[0] - a[0])[0]
          seen.push({
            file,
            expr: from
              ? normalise(from[1]!)
              : '<shorthand with no visible assignment>',
          })
        }
      })
    }

    // Non-vacuity: if this stops finding bodies, the guard has stopped
    // guarding and would pass an empty list forever.
    const dataBodies = seen.filter(({ file }) => !NOT_A_DATA_BODY[rel(file)])
    expect(
      dataBodies.length,
      'found no data-request body at all — the guard is no longer looking ' +
        'where the bodies are',
    ).toBeGreaterThanOrEqual(2)

    for (const { file, expr } of dataBodies) {
      expect(
        expr,
        `${rel(file)} builds a request body from \`${expr}\`. A data request ` +
          `must send the caller's command input unchanged (#51). If this is a ` +
          `new transport, send cmd.input; if it is not a data request, add it ` +
          `to NOT_A_DATA_BODY with the reason.`,
      ).toBe('JSON.stringify(cmd.input)')
    }

    // The exemptions are real sites, not stale text.
    for (const path of Object.keys(NOT_A_DATA_BODY)) {
      expect(
        seen.some(({ file }) => rel(file) === path),
        `${path} is exempted by NOT_A_DATA_BODY but has no body site any ` +
          `more — remove the entry`,
      ).toBe(true)
    }
  })

  it('reads token claims only to show them, never to build a request', () => {
    // `getAppConfig` is the whole legitimate use. The defect was a second kind
    // of caller — a claim read inside the send path and used to shape the body.
    //
    // Checked by the ENCLOSING FUNCTION, not by matching the call's text: the
    // two transports spell the same call differently (`this.currentToken()`
    // against `await this.source().get()`), and a guard pinned to one spelling
    // is narrower than the rule it claims to enforce. Method shorthand, arrow
    // properties and plain functions all count as a scope, or a claim read
    // inside one would be attributed to whatever was declared above it.
    const offenders: string[] = []
    let reads = 0

    for (const { file, text } of sources()) {
      if (file.endsWith('tokenClaims.ts')) continue

      let scope = '<top level>'
      for (const raw of text.split('\n')) {
        const line = raw.trim()
        const declaration =
          /^(?:export\s+)?(?:public\s+|private\s+|protected\s+)?(?:static\s+)?(?:readonly\s+)?(?:async\s+)?(?:function\s+)?(?:get\s+|set\s+)?([A-Za-z_$][\w$]*)\s*(?:\(|=\s*(?:async\s*)?\()/.exec(
            line,
          )
        if (
          declaration &&
          !line.startsWith('return') &&
          !line.startsWith('if') &&
          !line.startsWith('for') &&
          !line.startsWith('while') &&
          !line.startsWith('switch') &&
          !line.startsWith('catch')
        ) {
          scope = declaration[1]!
        }
        if (!line.includes('readAppConfigClaims(')) continue
        if (line.startsWith('import')) continue
        reads += 1
        if (scope !== 'getAppConfig') offenders.push(`${rel(file)}: ${scope}()`)
      }
    }

    // Non-vacuity: a rename would otherwise empty `offenders` and pass.
    expect(
      reads,
      'found no readAppConfigClaims call outside its own module — either the ' +
        'function was renamed, in which case rename it here too, or the ' +
        'guard has stopped looking',
    ).toBeGreaterThanOrEqual(2)

    expect(
      offenders,
      'These claims are for display only. A claim read anywhere but ' +
        'getAppConfig is a claim that can reach a request body, which is how ' +
        '#51 happened.',
    ).toEqual([])
  })
})
