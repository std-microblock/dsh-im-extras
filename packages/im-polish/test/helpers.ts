import type { PolishConfig } from '../src/index.ts'

export function baseConfig(patch: Partial<PolishConfig> = {}): PolishConfig {
  return {
    enabled: true,
    style: { main: 'short', subs: ['s1', 's2', 's3'], pickMin: 1, pickMax: 2 },
    rules: [],
    model: { temperature: 1, maxTokens: 400, timeoutMs: 1000 },
    context: { messages: 12, botMessages: 5, maxChars: 200 },
    repeat: {
      threshold: 0.82, minChars: 8, windowMs: 30 * 60_000, retry: true, drop: true, modelDrop: true, modelDropMinSimilarity: 0.45,
    },
    limits: { maxInputChars: 400, maxLines: 6, maxOutputChars: 600, minChars: 1 },
    skipMarker: '<no-send/>',
    maxRecords: 100,
    ...patch,
  }
}
