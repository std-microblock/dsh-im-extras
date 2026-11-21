// Writes the bundled card VM runtime next to the compiled engine, where `src/engine.ts` reads it from.
import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { buildVmRuntime } from './vm-build.mjs'

const OUT = fileURLToPath(new URL('../dist/vm/runtime.js', import.meta.url))
const source = await buildVmRuntime()
mkdirSync(fileURLToPath(new URL('../dist/vm/', import.meta.url)), { recursive: true })
writeFileSync(OUT, source)
console.log(`  dist/vm/runtime.js ${(source.length / 1024).toFixed(1)} KB`)
