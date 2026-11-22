// Bundles the card VM runtime (`src/vm/`) into the one plain script the engine evaluates inside QuickJS, and writes it
// next to the compiled engine (`dist/vm/runtime.js`), where `src/engine.ts` reads it from.
//
// The runtime is written as ES modules in TypeScript, but the VM has no module system: it must arrive as a single
// script whose top-level code installs the globals a card uses. esbuild's `iife` format is exactly that — every module
// is inlined into one immediately-invoked function, so nothing but `globalThis.__card*` and the hook/preset globals
// leaks out, and the entry has no exports for esbuild to wrap in an exports object.
//
// The build is deterministic (same sources, same bytes), which matters beyond reproducibility: the engine fingerprints
// the runtime source and refuses to restore a snapshot taken against another build.
import { build } from 'esbuild'
import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const ENTRY = fileURLToPath(new URL('../src/vm/index.ts', import.meta.url))
const OUT = fileURLToPath(new URL('../dist/vm/runtime.js', import.meta.url))

/**
 * Build the runtime.
 * @returns the bundled script, as it goes into `dist/vm/runtime.js`.
 */
export async function buildVmRuntime() {
  const result = await build({
    entryPoints: [ENTRY],
    outfile: 'runtime.js',
    bundle: true,
    write: false,
    // A bare script for the VM, not a module: no `import`, no `export`, no `require`.
    format: 'iife',
    platform: 'neutral',
    target: 'es2022',
    // The presets are TSX; they compile to `h(tag, props, ...children)` — the factory `jsx.ts` exports, which is also
    // what a card bundle calls as `__h__`.
    jsx: 'transform',
    jsxFactory: 'h',
    jsxFragment: 'Fragment',
    // Card text is Chinese; escaping it would only make the source unreadable in a stack trace.
    charset: 'utf8',
    legalComments: 'none',
    logLevel: 'silent',
  })
  if (result.errors.length > 0) throw new Error(result.errors.map((e) => e.text).join('\n'))
  return result.outputFiles[0].text
}

// Run as a script (`node scripts/build-vm.mjs`), not when a test imports `buildVmRuntime`.
if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  const source = await buildVmRuntime()
  mkdirSync(fileURLToPath(new URL('../dist/vm/', import.meta.url)), { recursive: true })
  writeFileSync(OUT, source)
  console.log(`  dist/vm/runtime.js ${(source.length / 1024).toFixed(1)} KB`)
}
