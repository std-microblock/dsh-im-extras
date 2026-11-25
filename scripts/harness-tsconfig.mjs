// Writes `tsconfig.harness.json`: the `@deepseek-ai/*` module paths the plugins
// are type-checked against, pointing into this machine's harness checkout.
//
// Why a generated file instead of a committed one: the harness packages are not
// on a registry, so their location is a property of the machine (see
// `harness-root.mjs`), not of the repository. Every package's `tsconfig.json` extends the generated file
// alongside `tsconfig.base.json`:
//
//     "extends": ["../../tsconfig.base.json", "../../tsconfig.harness.json"]
//
// Relative `paths` and `typeRoots` resolve against the file that declares them,
// which is this repository's root — hence `./…` below. Run it with
// `pnpm run harness` (the `build` and `typecheck` scripts do it for you), or
// point it at another checkout with `DSH_HARNESS_ROOT`.
import { existsSync, writeFileSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'

import { harnessRoot, repoRoot } from './harness-root.mjs'

/**
 * The specifiers the plugins import, and where each one's declarations live
 * inside the harness checkout.
 *
 * A specifier missing here fails the type check with "cannot find module", so
 * the table is also the list of harness packages this repository depends on.
 * The `…/src/<file>.ts` entries are subpath imports the harness exposes for a
 * consumer that needs one module rather than the package's barrel.
 */
const HARNESS_PEERS = {
  '@deepseek-ai/cordis': 'vendor/cordis/lib/types/index.d.ts',
  // The Satori-derived IM packages live under `vendor/im/` on the mainline (`vendor/plugin-im-*` and
  // `vendor/satori-*` were the feat/im-automation layout).
  '@deepseek-ai/cordis-plugin-im-core': 'vendor/im/core/lib/types/index.d.ts',
  '@deepseek-ai/schemastery': 'vendor/schemastery/lib/types/index.d.ts',
  '@deepseek-ai/satori-element': 'vendor/im/element/lib/types/index.d.ts',

  '@deepseek-ai/dsh-im': 'packages/experimental/im/lib/types/index.d.ts',
  '@deepseek-ai/dsh-im/src/api.ts': 'packages/experimental/im/lib/types/api.d.ts',
  '@deepseek-ai/dsh-im/src/outputs.ts': 'packages/experimental/im/lib/types/outputs.d.ts',
  '@deepseek-ai/dsh-im/src/send.ts': 'packages/experimental/im/lib/types/send.d.ts',

  '@deepseek-ai/dsh-agent': 'packages/core/agent/lib/types/index.d.ts',
  '@deepseek-ai/dsh-client-connection': 'packages/client/connection/lib/types/index.d.ts',
  '@deepseek-ai/dsh-fs': 'packages/fs/fs/lib/types/index.d.ts',
  '@deepseek-ai/dsh-llm': 'packages/llm/llm/lib/types/index.d.ts',
  '@deepseek-ai/dsh-session': 'packages/core/session/lib/types/index.d.ts',
  '@deepseek-ai/dsh-session/types': 'packages/core/session/lib/types/types.d.ts',
  '@deepseek-ai/dsh-skill': 'packages/skill/skill/lib/types/index.d.ts',
  '@deepseek-ai/dsh-storage-domain': 'packages/storage/storage-domain/lib/types/index.d.ts',
  '@deepseek-ai/dsh-system-prompt': 'packages/core/system-prompt/lib/types/index.d.ts',
  '@deepseek-ai/dsh-timeout': 'packages/util/timeout/lib/types/index.d.ts',
  '@deepseek-ai/dsh-tools': 'packages/core/tools/lib/types/index.d.ts',
  '@deepseek-ai/dsh-working-directory': 'packages/session/working-directory/lib/types/index.d.ts',

  // The browser half of the agent plugin (`src/client`, `tsconfig.client.json`)
  // builds against the GUI's own client packages.
  'react': 'node_modules/@types/react/index.d.ts',
  'react/jsx-runtime': 'node_modules/@types/react/jsx-runtime.d.ts',
  '@deepseek-ai/dsh-client-locale/client': 'packages/client/locale/lib/types/client/index.d.ts',
  '@deepseek-ai/dsh-client-shortcuts/client': 'packages/client/shortcuts/lib/types/client/index.d.ts',
  '@deepseek-ai/dsh-client-store': 'packages/client/store/lib/types/index.d.ts',
  '@deepseek-ai/dsh-client-ui-dockkit': 'packages/client/ui-dockkit/lib/types/index.d.ts',
  '@deepseek-ai/dsh-client-ui-layout/client': 'packages/client/ui-layout/lib/types/client/index.d.ts',
  '@deepseek-ai/dsh-client-ui-primitives': 'packages/client/ui-primitives/lib/types/index.d.ts',
  '@deepseek-ai/dsh-client-ui-session/client': 'packages/client/ui-session/lib/types/client/index.d.ts',
  '@deepseek-ai/dsh-client-ui-sidebar-right/client': 'packages/client/ui-sidebar-right/lib/types/client/index.d.ts',
  '@deepseek-ai/dsh-client-ui-slots': 'packages/client/ui-slots/lib/types/index.d.ts',
}

/**
 * A path as TypeScript writes it: relative to the repository root, forward
 * slashes, `./`-prefixed.
 * @param absolute - absolute path to convert.
 */
function toConfigPath(absolute) {
  const relativePath = relative(repoRoot, absolute).split(sep).join('/')
  return relativePath.startsWith('.') ? relativePath : `./${relativePath}`
}

/**
 * Specifiers pinned to this workspace's own copy, relative to the repository
 * root.
 *
 * `zod` has to be one copy for the whole program, harness declarations
 * included: the plugins pin zod, the harness checkout carries its own (a newer
 * minor), and two copies of a class-based schema library make every schema
 * handed to a harness API a nominal type mismatch ("… is missing validate,
 * validateAsync"). Mapping it to the copy the plugins actually run keeps what is
 * type-checked equal to what is deployed — the profile installs one zod, and it
 * is the plugins' pin.
 */
const WORKSPACE_PEERS = {
  zod: 'node_modules/zod/index.d.ts',
}

const root = harnessRoot()

const paths = {}
const missingInHarness = []
for (const [specifier, entry] of Object.entries(HARNESS_PEERS)) {
  const absolute = resolve(root, entry)
  if (!existsSync(absolute)) missingInHarness.push(`${specifier} → ${entry}`)
  paths[specifier] = [toConfigPath(absolute)]
}

const missingHere = []
for (const [specifier, entry] of Object.entries(WORKSPACE_PEERS)) {
  const absolute = resolve(repoRoot, entry)
  if (!existsSync(absolute)) missingHere.push(`${specifier} → ${entry}`)
  paths[specifier] = [toConfigPath(absolute)]
}

// A checkout that is only half built (or a harness branch that moved a package)
// would otherwise surface as thirty "cannot find module" errors inside tsc.
if (missingInHarness.length > 0) {
  throw new Error(
    `${root} does not hold these declarations; build the harness (\`pnpm build\`) or point DSH_HARNESS_ROOT at another checkout:\n  ` +
      missingInHarness.join('\n  '),
  )
}
if (missingHere.length > 0) {
  throw new Error(
    `the workspace does not hold these packages; run \`pnpm install\` first:\n  ${missingHere.join('\n  ')}`,
  )
}

const config = {
  '//': [
    'generated by scripts/harness-tsconfig.mjs — do not edit, do not commit',
    `harness checkout: ${root}`,
    'set DSH_HARNESS_ROOT to point the plugins at another one',
  ],
  compilerOptions: {
    typeRoots: [toConfigPath(join(repoRoot, 'node_modules', '@types'))],
    paths,
  },
}

writeFileSync(join(repoRoot, 'tsconfig.harness.json'), `${JSON.stringify(config, null, 2)}\n`)
console.log(`tsconfig.harness.json: ${Object.keys(paths).length} harness peers → ${root}`)
