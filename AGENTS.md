# Working in this repository

- Run `pnpm build` / `pnpm typecheck` / `pnpm test` from the repository root: `tsconfig.harness.json` is generated
  there by `scripts/harness-tsconfig.mjs` and points the `@deepseek-ai/*` peers at a built harness checkout
  (`DSH_HARNESS_ROOT`, a `.harness-root` file, or `../deepseek-harness`, `../dsh`).
- `dist/` and the browser bundles are build output and are not committed.
- Packages couple only through the harness interfaces and each other's public exports. Commit as `scope: message`, the
  scope being the package directory (`im-card:`, `im-dispatch:` …) or `repo:` for root files.
- This repository is public. Never commit chat ids, user ids, app ids, hostnames, internal URLs, tokens or harness
  source; import harness packages by their package name only (never `@deepseek-ai/*/src/...`).
- Several agents may work here at once: stage only the paths you changed.
