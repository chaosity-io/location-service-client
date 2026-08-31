// Proves the PUBLISHED package layout actually loads (#35).
//
// 0.5.1 shipped an ESM entry point that threw ERR_MODULE_NOT_FOUND on every
// `import` outside a bundler: tsc emitted extensionless relative specifiers,
// which Node's ESM resolver rejects. Every test passed, the build was green and
// `npm pack` was clean, because vitest and every consumer we tried were
// bundlers — the one thing nothing exercised was Node resolving dist/ itself.
//
// So this loads both entry points through BOTH module systems, the way a
// consumer would, and checks a representative export actually arrived. It runs
// against dist/, so it must come after `npm run build`.
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
/** Everything below is addressed from the package root, not scripts/. */
const root = new URL('../', import.meta.url)
const failures = []

/** Print and exit non-zero if anything has gone wrong; otherwise fall through. */
function report() {
  if (!failures.length) return
  console.error('\npackage smoke FAILED:')
  for (const f of failures) console.error(`  ✗ ${f}`)
  process.exit(1)
}

/** A named export that must survive whatever the module plumbing does. */
const EXPECTED = {
  '.': ['GeoPlacesClient', 'createTransformRequest', 'SearchTextCommand'],
  './server': ['LocationServiceConnector', 'getClientConfig', 'TokenProvider'],
}

const paths = {
  '.': { import: 'dist/index.js', require: 'dist/cjs/index.js' },
  './server': {
    import: 'dist/server/index.js',
    require: 'dist/cjs/server/index.js',
  },
}

for (const [entry, byKind] of Object.entries(paths)) {
  for (const [kind, file] of Object.entries(byKind)) {
    const label = `${entry} (${kind})`
    const url = new URL(file, root)
    if (!existsSync(url)) {
      failures.push(`${label}: ${file} was never emitted`)
      continue
    }
    try {
      const mod =
        kind === 'import' ? await import(url.href) : require(fileURLToPath(url))
      const missing = EXPECTED[entry].filter((name) => !(name in mod))
      if (missing.length) {
        failures.push(`${label}: loaded but missing ${missing.join(', ')}`)
      } else {
        console.log(`  ok  ${label} — ${Object.keys(mod).length} exports`)
      }
    } catch (error) {
      failures.push(
        `${label}: ${error.code ?? error.name} — ${error.message.split('\n')[0]}`,
      )
    }
  }
}

// Everything past this point dereferences the modules, so a load failure has to
// stop here — otherwise a broken build reports an unhandled stack trace instead
// of the diagnosis above.
if (failures.length) report()

// The two halves of a dual package must expose the SAME public surface. An
// export present in one and missing from the other is invisible to every test
// here (both entry points still load) and breaks exactly half the consumers.
// `__esModule` is TypeScript's interop marker, not public API: the root does
// `export *` over a CJS dependency, so Node's lexer surfaces it on the ESM
// namespace only.
for (const [entry, byKind] of Object.entries(paths)) {
  const esm = Object.keys(await import(new URL(byKind.import, root).href))
  const cjs = Object.keys(require(fileURLToPath(new URL(byKind.require, root))))
  const onlyEsm = esm.filter((k) => k !== '__esModule' && !cjs.includes(k))
  const onlyCjs = cjs.filter((k) => k !== '__esModule' && !esm.includes(k))
  if (onlyEsm.length || onlyCjs.length) {
    failures.push(
      `${entry}: ESM/CJS surfaces differ — only-ESM [${onlyEsm.join(', ')}], only-CJS [${onlyCjs.join(', ')}]`,
    )
  }
}

// The boundary AGENTS.md calls "the one that matters": credentials must not be
// reachable from the browser-safe root, whichever module system loaded it.
for (const [kind, file] of Object.entries(paths['.'])) {
  const url = new URL(file, root)
  const mod =
    kind === 'import' ? await import(url.href) : require(fileURLToPath(url))
  const leaked = [
    'LocationServiceConnector',
    'getClientConfig',
    'TokenProvider',
  ].filter((name) => name in mod)
  if (leaked.length) {
    failures.push(
      `. (${kind}): server-only export reachable from the root — ${leaked.join(', ')}`,
    )
  }
}

report()
console.log('\npackage smoke passed — both entry points load as ESM and CJS')
