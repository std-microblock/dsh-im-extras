/**
 * The harness's built vendor packages the tests drive for real (the IM core, the Lark and QQ adapters), loaded from the
 * harness checkout `scripts/harness-root.mjs` resolves (`DSH_HARNESS_ROOT`, or a sibling checkout).
 */
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
// @ts-expect-error -- a plain ESM script of the repository root, without declarations.
import { harnessRoot } from '../../../scripts/harness-root.mjs'

/**
 * Import one vendor package's built entry.
 * @param name - the package directory under `vendor/`, e.g. `plugin-im-core`.
 * @returns the module namespace.
 */
export async function vendor(name: string): Promise<any> {
  return await import(pathToFileURL(join((harnessRoot as () => string)(), 'vendor', name, 'lib', 'index.js')).href)
}
