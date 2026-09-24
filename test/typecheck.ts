import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

/**
 * Compile a snippet against `src/` and return its diagnostics (#40).
 *
 * vitest strips types without checking them, and the build checks only
 * `src/`, so a test that asserts what a TYPE accepts or refuses has to compile
 * something itself. The snippet is placed in `test/` under `name`, imports
 * from `'../src/index.js'`, and is checked with the package's own
 * `tsconfig.json`. `// @ts-expect-error` lines assert a refusal: an unused one
 * is itself a diagnostic (TS2578), so a type that accepts what it should not
 * shows up here.
 *
 * Each problem is `<line>: <message> — <that line of the snippet>`.
 */
export function typeErrors(name: string, source: string): string[] {
  const here = dirname(fileURLToPath(import.meta.url))
  const file = join(here, name)
  const config = ts.getParsedCommandLineOfConfigFile(
    join(here, '../tsconfig.json'),
    {},
    { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => {} },
  )
  if (!config) throw new Error('tsconfig.json did not parse')
  // rootDir is the emit layout for src/; this file is checked, never emitted.
  const options = {
    ...config.options,
    noEmit: true,
    noUnusedLocals: false,
    rootDir: join(here, '..'),
  }

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
  return ts
    .getPreEmitDiagnostics(program)
    .filter((d) => d.file?.fileName === file || !d.file)
    .map((d) => {
      const line = d.file
        ? d.file.getLineAndCharacterOfPosition(d.start ?? 0).line + 1
        : 0
      return `${line}: ${ts.flattenDiagnosticMessageText(d.messageText, ' ')} — ${
        source.split('\n')[line - 1] ?? ''
      }`
    })
}
