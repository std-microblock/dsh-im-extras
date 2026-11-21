/**
 * Validated configuration of the plugin row.
 *
 * The schemas are zod, which cordis accepts as a Standard Schema: the plugin row's `config` is validated and given
 * its defaults before `apply` runs. `main` and `worker` (the two agent compositions) are required; everything else
 * has a default.
 *
 * @module dsh-im-dispatch/config
 */

import { z } from 'zod'
import { DISPATCHER_TOOLS, WORKER_TOOLS, type DispatchConfig as DispatchConfigShape } from './api.ts'

const composition = z.object({
  agentPreset: z.string(),
  provider: z.string(),
  model: z.string(),
  cwd: z.string(),
})

const natural = z.number().int().min(0)

const chronicleDefaults = {
  enabled: true,
  reasoningEffort: 'off',
  compactMaxTokens: 256,
  queryMaxTokens: 1200,
  chunkSize: 32,
  maxEntries: 8000,
  timeoutMs: 20000,
}

const chronicleConfig = z.object({
  enabled: z.boolean().default(true),
  provider: z.string().optional(),
  model: z.string().optional(),
  reasoningEffort: z.string().default('off'),
  compactMaxTokens: natural.min(32).max(2048).default(256),
  queryMaxTokens: natural.min(64).max(8192).default(1200),
  chunkSize: natural.min(1).max(256).default(32),
  maxEntries: natural.min(100).max(100000).default(8000),
  timeoutMs: natural.min(500).max(120000).default(20000),
}).default(chronicleDefaults)

/** The dispatch configuration: the per-chat routers, task workers, route-rule bounds, and Chronicle settings. */
export const DispatchConfig = z.object({
  main: composition,
  worker: composition,
  workerOutput: z.string().default('none'),
  prompts: z.object({
    main: z.string().optional(),
    worker: z.string().optional(),
  }).default({}),
  tools: z.object({
    main: z.array(z.string()).default([...DISPATCHER_TOOLS]),
    worker: z.array(z.string()).default([...WORKER_TOOLS]),
  }).default({ main: [...DISPATCHER_TOOLS], worker: [...WORKER_TOOLS] }),
  ruleTimeoutMs: natural.min(1).max(10000).default(50),
  ruleMemoryBytes: natural.min(1048576).max(268435456).default(16777216),
  maxRuleChars: natural.min(1).max(100000).default(2000),
  maxRulesPerTask: natural.min(1).max(100).default(10),
  maxTaskMessages: natural.min(1).max(100).default(20),
  contextMessages: natural.max(50).default(5),
  maxSearchPages: natural.min(1).max(100).default(10),
  searchPageSize: natural.min(1).max(200).default(20),
  autoThread: z.boolean().default(true),
  threadlessPlatforms: z.array(z.string()).default(['qq', 'onebot', 'chronocat']),
  maxRouterSteps: z.number().int().min(2).max(20).default(5),
  maxRouterDeltaMessages: natural.min(1).max(1000).default(200),
  freshContextMessages: natural.max(200).default(20),
  chatNames: z.record(z.string(), z.string()).default({}),
  ambientDebounceMs: natural.max(60000).default(3000),
  maxAutoRepliesPerHour: natural.max(120).default(6),
  chronicle: chronicleConfig,
}) satisfies z.ZodType<DispatchConfigShape, unknown>

/** The plugin row's `config`. */
export const Config = DispatchConfig

/** The resolved plugin configuration. */
export type Config = z.output<typeof Config>
