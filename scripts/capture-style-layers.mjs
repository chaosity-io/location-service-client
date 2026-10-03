// Capture the layer list of every map style the service serves, for
// test/map-poi-layers.test.ts (#33).
//
// AWS publishes no list of a style's layer ids, so POI_CATEGORIES can only be
// held to the descriptors themselves. This writes one file per style and
// colour scheme into test/fixtures/style-layers/: the style's name, the date,
// and each layer's id and type — nothing else, so no host, token or URL from
// the descriptor reaches the repository.
//
// Run it when the service's styles change, then run the suite:
//
//   LOCATION_API_URL=https://… LOCATION_TOKEN=… LOCATION_ORIGIN=https://… \
//     node scripts/capture-style-layers.mjs
//
// LOCATION_TOKEN is a bearer token for an application whose plan includes
// satellite imagery (Hybrid and Satellite need it), and LOCATION_ORIGIN one of
// that application's allowed domains.
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const { LOCATION_API_URL, LOCATION_TOKEN, LOCATION_ORIGIN } = process.env
if (!LOCATION_API_URL || !LOCATION_TOKEN || !LOCATION_ORIGIN) {
  console.error('Set LOCATION_API_URL, LOCATION_TOKEN and LOCATION_ORIGIN.')
  process.exit(2)
}

// Colour schemes apply to Standard and Monochrome only.
const CAPTURES = [
  ['Standard', 'Light'],
  ['Standard', 'Dark'],
  ['Monochrome', 'Light'],
  ['Monochrome', 'Dark'],
  ['Hybrid', undefined],
  ['Satellite', undefined],
]

const out = join(
  dirname(fileURLToPath(import.meta.url)),
  '../test/fixtures/style-layers',
)
mkdirSync(out, { recursive: true })

const capturedOn = new Date().toISOString().slice(0, 10)
let failed = false
for (const [style, colorScheme] of CAPTURES) {
  const qs = colorScheme ? `?color-scheme=${colorScheme}` : ''
  const res = await fetch(
    `${LOCATION_API_URL.replace(/\/$/, '')}/maps/${style}/descriptor${qs}`,
    {
      headers: {
        Authorization: `Bearer ${LOCATION_TOKEN}`,
        Origin: LOCATION_ORIGIN,
      },
    },
  )
  if (!res.ok) {
    console.error(`${style} ${colorScheme ?? ''}: HTTP ${res.status}`)
    failed = true
    continue
  }
  const descriptor = await res.json()
  const layers = descriptor.layers.map(({ id, type }) => ({ id, type }))
  const name = colorScheme ? `${style}-${colorScheme}` : style
  writeFileSync(
    join(out, `${name}.json`),
    JSON.stringify({ style, colorScheme, capturedOn, layers }, null, 2) + '\n',
  )
  const poi = layers.filter((l) => l.id.startsWith('poi')).length
  console.log(`${name}: ${layers.length} layers, ${poi} poi*`)
}
process.exit(failed ? 1 : 0)
