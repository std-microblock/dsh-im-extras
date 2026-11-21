/**
 * Card sources: type-checked with TypeScript against `types/dsh-card.d.ts`, then bundled by esbuild into one plain
 * script the VM evaluates. The entry and every relative import are read when the card is published (or reloaded) and
 * the bundle is stored with the card, so a card never changes when its files do, and a restart restores exactly the
 * code that is running.
 *
 * - `dsh:card` is the hook API (`globalThis.__cardApi` inside the VM); every other bare specifier is refused, there is
 *   no package resolution inside a card.
 * - JSX compiles to `__h__(type, props, ...children)` and `<>…</>` to `__fragment__`, both provided by the runtime.
 * - The bundle assigns the entry module's default export to `globalThis.__cardDefault`.
 *
 * @module dsh-im-card/bundle
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { build, type Plugin } from 'esbuild'

const require = createRequire(import.meta.url)

/** The module name the hook API is served under. */
export const API_MODULE = 'dsh:card'

/** The type definitions every card is checked against (`dsh:card` and the JSX namespace). */
export const CARD_TYPES = readFileSync(new URL('../types/dsh-card.d.ts', import.meta.url), 'utf8')

/** One compiled card: a single script plus the sources it was built from. */
export interface CardBundle {
  /** Name of the entry file (absolute path, or `inline:card.tsx`). */
  entry: string
  /** The bundled script the VM evaluates. */
  script: string
  /** Files the bundle was built from, for reloads and diagnostics. */
  files: string[]
}

/** A refused bundle: the file, type or syntax errors a model can fix. */
export class CardSourceError extends Error {
  override readonly name = 'CardSourceError'
}

/** Files the bundler reads through; the caller binds them to the session's filesystem and working directory. */
export interface CardFiles {
  /**
   * Read one file.
   * @param path - absolute POSIX-style path.
   * @returns the text, or `undefined` when no file exists there.
   */
  read(path: string): Promise<string | undefined>
}

/** Bounds of one bundle. */
export interface BundleLimits {
  /** Maximum modules, entry included. */
  maxModules: number
  /** Maximum source bytes over every module. */
  maxBytes: number
  /** Run the type checker (default true). */
  typecheck?: boolean
}

const INLINE = 'inline:card.tsx'
const PROBES = ['', '.tsx', '.ts', '.jsx', '.js', '/index.tsx', '/index.ts', '/index.js']

/**
 * Normalize a path: backslashes to slashes, `.` and `..` segments folded.
 * @param path - absolute path in either separator style.
 * @returns the normalized path with `/` separators.
 */
export function normalizePath(path: string): string {
  const unified = path.replace(/\\/g, '/')
  const drive = /^[A-Za-z]:/.exec(unified)?.[0] ?? ''
  const rest = unified.slice(drive.length)
  const parts: string[] = []
  for (const segment of rest.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') parts.pop()
    else parts.push(segment)
  }
  return `${drive}/${parts.join('/')}`
}

function dirnameOf(path: string): string {
  const at = path.lastIndexOf('/')
  return at <= 0 ? '/' : path.slice(0, at)
}

type TsModule = typeof import('typescript')

/**
 * Promote a trailing top-level JSX element/fragment expression in a card entry module to `export default`
 * when the module has no explicit default export, so bare JSX blocks in ` ```satori-tsx ` render as cards.
 */
function promoteTrailingJsxDefault(source: string, ts: TsModule): string {
  const sf = ts.createSourceFile('entry.tsx', source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX)
  const parseDiagnostics = (sf as unknown as { parseDiagnostics?: readonly unknown[] }).parseDiagnostics
  if (parseDiagnostics !== undefined && parseDiagnostics.length > 0) return source

  for (const s of sf.statements) {
    if (ts.isExportAssignment(s)) return source
    if (ts.canHaveModifiers(s) && ts.getModifiers(s)?.some(m => m.kind === ts.SyntaxKind.DefaultKeyword)) {
      return source
    }
    if (
      ts.isExportDeclaration(s)
      && s.exportClause !== undefined
      && ts.isNamedExports(s.exportClause)
      && s.exportClause.elements.some(e => e.name.text === 'default')
    ) {
      return source
    }
  }

  let last: import('typescript').Statement | undefined
  for (let i = sf.statements.length - 1; i >= 0; i--) {
    const stmt = sf.statements[i]!
    if (!ts.isEmptyStatement(stmt)) {
      last = stmt
      break
    }
  }
  if (last === undefined || !ts.isExpressionStatement(last)) return source

  let expr: import('typescript').Expression = last.expression
  while (ts.isParenthesizedExpression(expr)) expr = expr.expression
  if (!ts.isJsxElement(expr) && !ts.isJsxSelfClosingElement(expr) && !ts.isJsxFragment(expr)) {
    return source
  }

  const pos = last.getStart(sf)
  return `${source.slice(0, pos)}export default ${source.slice(pos)}`
}

/** Read every module the entry reaches (relative imports only), so type checking and bundling see the same files. */
async function collect(
  entry: { path: string } | { inline: string; cwd: string },
  files: CardFiles,
  limits: BundleLimits,
): Promise<{ entry: string; cwd: string; sources: Map<string, string> }> {
  const sources = new Map<string, string>()
  let entryName: string
  let cwd: string
  if ('path' in entry) {
    const found = await probe(normalizePath(entry.path), files)
    if (found === undefined) throw new CardSourceError(`card file not found: ${entry.path}`)
    entryName = found.name
    cwd = dirnameOf(found.name)
    sources.set(found.name, found.source)
  } else {
    entryName = INLINE
    cwd = normalizePath(entry.cwd)
    sources.set(INLINE, entry.inline)
  }
  const queue = [entryName]
  let bytes = 0
  while (queue.length > 0) {
    const name = queue.shift()!
    const source = sources.get(name)!
    bytes += Buffer.byteLength(source)
    if (bytes > limits.maxBytes) throw new CardSourceError(`card sources exceed ${limits.maxBytes} bytes`)
    for (const specifier of importsOf(source)) {
      if (specifier === API_MODULE) continue
      if (!specifier.startsWith('./') && !specifier.startsWith('../') && !specifier.startsWith('/')) {
        throw new CardSourceError(`${name}: cannot import "${specifier}" — a card imports only "${API_MODULE}" and relative files`)
      }
      const base = name === INLINE ? cwd : dirnameOf(name)
      const target = normalizePath(specifier.startsWith('/') ? specifier : `${base}/${specifier}`)
      if ([...sources.keys()].some(key => key === target || PROBES.some(p => key === target + p))) continue
      const found = await probe(target, files)
      if (found === undefined) throw new CardSourceError(`${name}: cannot find module "${specifier}" (${target})`)
      if (sources.size >= limits.maxModules) throw new CardSourceError(`a card may import at most ${limits.maxModules} modules`)
      sources.set(found.name, found.source)
      queue.push(found.name)
    }
  }
  return { entry: entryName, cwd, sources }
}

const IMPORT_RE = /\b(?:import|export)\s*(?:type\s+)?(?:[^'"`;]*?\s*from\s*)?(['"])([^'"\n]+)\1|\bimport\s*\(\s*(['"])([^'"\n]+)\3\s*\)/g

/**
 * The module specifiers a source imports (static, re-exports, dynamic; string literals only).
 * @param code - TSX source.
 * @returns the specifiers in source order.
 */
export function importsOf(code: string): string[] {
  const out: string[] = []
  // Comments may mention imports; strip them first so they cannot pull in files.
  const stripped = code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
  for (const match of stripped.matchAll(IMPORT_RE)) {
    const spec = match[2] ?? match[4]
    if (spec !== undefined) out.push(spec)
  }
  return out
}

async function probe(path: string, files: CardFiles): Promise<{ name: string; source: string } | undefined> {
  for (const suffix of PROBES) {
    const name = path + suffix
    const source = await files.read(name)
    if (source !== undefined) return { name, source }
  }
  return undefined
}

/**
 * Type-check the collected sources against the card types.
 * @param sources - module name → source.
 * @returns readable diagnostics (`file:line:col: message`), empty when the card type-checks.
 */
async function typecheck(sources: Map<string, string>, ts: TsModule): Promise<string[]> {
  const TYPES = '/__dsh__/dsh-card.d.ts'
  const libDir = normalizePath(require.resolve('typescript/lib/lib.d.ts')).replace(/\/lib\.d\.ts$/, '')
  const key = (name: string): string => (name === INLINE ? '/__inline__/card.tsx' : name)
  const files = new Map<string, string>()
  for (const [name, source] of sources) files.set(key(name), source)
  // `dsh:card` resolves to the shipped declarations; everything else resolves among the collected files.
  files.set(TYPES, CARD_TYPES)
  const options: import('typescript').CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    jsx: ts.JsxEmit.Preserve,
    strict: true,
    noEmit: true,
    allowImportingTsExtensions: true,
    skipLibCheck: true,
    lib: ['lib.es2022.d.ts'],
    types: [],
  }
  const host: import('typescript').CompilerHost = {
    getSourceFile: (fileName, languageVersion) => {
      const name = normalizePath(fileName)
      const text = files.get(name) ?? (name.startsWith(libDir) ? readFileSync(fileName, 'utf8') : undefined)
      return text === undefined ? undefined : ts.createSourceFile(fileName, text, languageVersion, true)
    },
    getDefaultLibFileName: () => `${libDir}/lib.es2022.d.ts`,
    writeFile: () => {},
    getCurrentDirectory: () => '/',
    getDirectories: () => [],
    fileExists: (fileName) => {
      const name = normalizePath(fileName)
      return files.has(name) || (name.startsWith(libDir) && ts.sys.fileExists(fileName))
    },
    readFile: (fileName) => files.get(normalizePath(fileName)) ?? (ts.sys.readFile(fileName)),
    getCanonicalFileName: name => name,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => '\n',
    resolveModuleNames: (names, containing) => names.map((name) => {
      if (name === API_MODULE) return { resolvedFileName: TYPES, extension: ts.Extension.Dts }
      const base = dirnameOf(normalizePath(containing))
      const target = normalizePath(name.startsWith('/') ? name : `${base}/${name}`)
      for (const suffix of PROBES) {
        const candidate = target + suffix
        if (files.has(candidate)) {
          const extension = candidate.endsWith('.tsx') ? ts.Extension.Tsx : candidate.endsWith('.ts') ? ts.Extension.Ts
            : candidate.endsWith('.jsx') ? ts.Extension.Jsx : ts.Extension.Js
          return { resolvedFileName: candidate, extension }
        }
      }
      return undefined
    }),
  }
  const program = ts.createProgram([...files.keys()].filter(name => name !== TYPES).concat(TYPES), options, host)
  const diagnostics = ts.getPreEmitDiagnostics(program)
  return diagnostics.slice(0, 20).map((d) => {
    const text = ts.flattenDiagnosticMessageText(d.messageText, '\n')
    if (d.file === undefined || d.start === undefined) return text
    const { line, character } = d.file.getLineAndCharacterOfPosition(d.start)
    const file = d.file.fileName === '/__inline__/card.tsx' ? INLINE : d.file.fileName
    return `${file}:${line + 1}:${character + 1}: ${text}`
  })
}

/**
 * Type-check and bundle a card.
 * @param entry - entry module: a file path, or inline source with the directory its imports resolve against.
 * @param files - file reader of the publishing session.
 * @param limits - module count and byte bounds; `typecheck: false` skips the checker.
 * @returns the bundle.
 * @throws CardSourceError for a missing file, a refused specifier, a type or syntax error, or an exceeded bound.
 */
export async function bundleCard(
  entry: { path: string } | { inline: string; cwd: string },
  files: CardFiles,
  limits: BundleLimits,
): Promise<CardBundle> {
  const collected = await collect(entry, files, limits)
  const ts = (await import('typescript')).default
  const entrySource = collected.sources.get(collected.entry)!
  collected.sources.set(collected.entry, promoteTrailingJsxDefault(entrySource, ts))
  if (limits.typecheck !== false) {
    const errors = await typecheck(collected.sources, ts)
    if (errors.length > 0) throw new CardSourceError(`card does not type-check:\n${errors.join('\n')}`)
  }
  const loader: Plugin = {
    name: 'dsh-card-sources',
    setup(b) {
      b.onResolve({ filter: /.*/ }, (args) => {
        if (args.path === API_MODULE) return { path: API_MODULE, namespace: 'dsh-api' }
        if (args.kind === 'entry-point') return { path: collected.entry, namespace: 'card' }
        const base = args.importer === INLINE ? collected.cwd : dirnameOf(args.importer)
        const target = normalizePath(args.path.startsWith('/') ? args.path : `${base}/${args.path}`)
        for (const suffix of PROBES) {
          if (collected.sources.has(target + suffix)) return { path: target + suffix, namespace: 'card' }
        }
        return { errors: [{ text: `cannot find module "${args.path}"` }] }
      })
      b.onLoad({ filter: /.*/, namespace: 'dsh-api' }, () => ({
        contents: 'module.exports = globalThis.__cardApi', loader: 'js',
      }))
      b.onLoad({ filter: /.*/, namespace: 'card' }, (args) => {
        const loaderOf = args.path.endsWith('.ts') ? 'ts' : args.path.endsWith('.js') ? 'jsx' : 'tsx'
        return { contents: collected.sources.get(args.path)!, loader: loaderOf }
      })
    },
  }
  let result
  try {
    result = await build({
      entryPoints: [collected.entry],
      bundle: true,
      write: false,
      format: 'iife',
      globalName: '__cardModule',
      platform: 'neutral',
      target: 'es2022',
      jsx: 'transform',
      jsxFactory: '__h__',
      jsxFragment: '__fragment__',
      plugins: [loader],
      logLevel: 'silent',
      charset: 'utf8',
      footer: { js: 'globalThis.__cardDefault = typeof __cardModule === "object" && __cardModule !== null ? __cardModule.default : undefined;' },
    })
  } catch (error) {
    const failure = error as { errors?: { text: string; location?: { file: string; line: number; column: number } | null }[] }
    const lines = (failure.errors ?? []).map(e => (e.location ? `${e.location.file}:${e.location.line}:${e.location.column + 1}: ${e.text}` : e.text))
    throw new CardSourceError(lines.length > 0 ? lines.join('\n') : String(error))
  }
  const script = result.outputFiles[0]!.text
  return { entry: collected.entry, script, files: [...collected.sources.keys()] }
}
