// Where the harness checkout is on this machine.
//
// The plugins import the harness's own packages (`@deepseek-ai/dsh-session`,
// `@deepseek-ai/cordis-plugin-im-core`, …) as peers. Those packages are not on a
// registry: inside the deployment the profile resolves them from the harness's
// node_modules, and here they are resolved from a harness checkout that has
// been built (`pnpm build` in it), by path.
//
// `DSH_HARNESS_ROOT` wins when it is set, then the path in an untracked
// `.harness-root` file at the repository root; otherwise the candidates below are
// tried in order: a sibling harness checkout, and one nested in this repository.
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** The path in `.harness-root`, if the file exists. */
function localRoot() {
  const file = join(repoRoot, '.harness-root')
  return existsSync(file) ? readFileSync(file, 'utf8').trim() : undefined
}

/** Every path that would make a usable harness checkout. */
export function candidates() {
  return [
    process.env.DSH_HARNESS_ROOT,
    localRoot(),
    join(repoRoot, '..', 'deepseek-harness'),
    join(repoRoot, '..', 'dsh'),
    join(repoRoot, 'dsh'),
  ]
    .filter((candidate) => candidate !== undefined && candidate !== '')
    .map((candidate) => resolve(candidate))
}

/**
 * Whether a path holds a harness checkout that has been built: the plugins' type
 * references point at emitted declarations, not at sources.
 * @param root - candidate checkout.
 */
export function isBuiltHarness(root) {
  return existsSync(join(root, 'vendor', 'cordis', 'lib', 'types', 'index.d.ts'))
}

/**
 * The harness checkout to resolve the harness peers from.
 * @returns its absolute path.
 */
export function harnessRoot() {
  const tried = candidates()
  for (const candidate of tried) {
    if (isBuiltHarness(candidate)) return candidate
  }
  throw new Error(
    `no built harness checkout found; set DSH_HARNESS_ROOT to one (tried ${tried.join(', ')}). ` +
      'It has to be built first: `pnpm build` in the checkout.',
  )
}
