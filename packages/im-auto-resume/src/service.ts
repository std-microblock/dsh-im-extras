/**
 * IM-native automatic resume service for `dsh-im` sessions.
 *
 * Unlike a generic Host-level auto-resume plugin that bypasses `dsh-im` via `sessionController.resolveAgent`, this
 * service observes `im/activity` (preserving the original trigger message key and target chat) and resumes interrupted
 * sessions through `ctx.im.sessions.deliver`. That preserves:
 * - the session's `agentPreset` and `composition.restrict`,
 * - the original trigger (quote, thread placement, working reactions, page link attribution), and
 * - in-place streaming on the original Feishu/IM card when paired with `dsh-im-output-summary`.
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type { ImActivity, ImActivityChange, ImChatKey } from '@deepseek-ai/dsh-im'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-query'
import type {} from '@deepseek-ai/dsh-storage-domain'
import type { Config } from './config.ts'
import { imAutoResumeDomain, type ImAutoResumeDomain, type RunningMarker } from './domain.ts'

/** Event emitted when an interrupted session exceeds `maxRetries` within `retryWindowMs` and auto-resume gives up. */
export interface AutoResumeExhaustedEvent {
  sessionId: SessionId
  chat?: ImChatKey
  attempts: number
}

/**
 * Decide whether the previous Host process interrupted a Session's latest Turn.
 * @param events - complete stored session event log.
 * @returns true when the latest turn never ended, ended `interrupted`, or was aborted by host disposal.
 */
export function wasInterrupted(events: readonly { type: string; data?: any }[]): boolean {
  const last = events.findLast(event => event.type === 'turn/start' || event.type === 'turn/end')
  if (last?.type === 'turn/start') return true
  if (last?.type !== 'turn/end') return false
  const reason = last.data?.reason
  return reason?.kind === 'interrupted' || (reason?.kind === 'aborted' && reason?.reason?.kind === 'disposed')
}

export class ImAutoResumeService {
  private domain: ImAutoResumeDomain | undefined
  private writes: Promise<void> = Promise.resolve()
  private startupTimer: ReturnType<typeof setTimeout> | undefined
  private startupTask: Promise<void> | undefined
  private readonly continued = new Set<SessionId>()
  private stopping = false

  constructor(
    private readonly ctx: Context,
    private readonly config: Config,
    private readonly now = () => Date.now(),
  ) {}

  async start(): Promise<void> {
    const domain = await this.ctx.storageDomain.open(imAutoResumeDomain)
    if (this.stopping) {
      await domain.close()
      return
    }
    this.domain = domain
    this.ctx.on('im/activity', (activity, change) => { this.observe(activity, change) })

    if (!this.config.enabled) return
    const candidates = [...domain.table('running').entries()]
    if (candidates.length === 0) return

    const runScan = () => {
      if (this.stopping) return
      this.startupTask = this.scan(candidates).catch((error: unknown) => {
        this.ctx.logger.warn('im-auto-resume: startup scan failed: %s', String(error))
      })
    }
    if (this.config.startupDelayMs <= 0) {
      runScan()
    } else {
      this.startupTimer = setTimeout(() => {
        this.startupTimer = undefined
        runScan()
      }, this.config.startupDelayMs)
    }
  }

  async dispose(): Promise<void> {
    this.stopping = true
    if (this.startupTimer !== undefined) {
      clearTimeout(this.startupTimer)
      this.startupTimer = undefined
    }
    await this.startupTask
    await this.writes
    const domain = this.domain
    this.domain = undefined
    await domain?.close()
  }

  private observe(activity: ImActivity, change: ImActivityChange): void {
    const sessionId = activity.session.sessionId
    if (change === 'start') {
      this.continued.add(sessionId)
      const chat = activity.trigger?.chat.key
        ?? activity.session.bindings.find(binding => binding.home === true && binding.writable)?.chat
      const marker: RunningMarker = {
        sessionId,
        ...chat === undefined ? {} : { chat },
        ...activity.trigger?.key === undefined ? {} : { triggerKey: activity.trigger.key },
        turn: activity.turn,
        startedAt: activity.startedAt,
      }
      this.write(domain => domain.table('running').put(sessionId, marker))
      return
    }
    if (change === 'end' && !activity.disposed) {
      this.write(domain => domain.table('running').delete(sessionId))
    }
  }

  private async scan(candidates: [string, RunningMarker][]): Promise<void> {
    const queue = candidates.filter(([sessionId]) =>
      !this.continued.has(sessionId as SessionId)
      && this.ctx.agents.get(sessionId as SessionId)?.status !== 'running',
    )
    if (queue.length === 0) return

    const workers: Promise<void>[] = []
    const workerCount = Math.min(this.config.concurrency, queue.length)
    for (let i = 0; i < workerCount; i += 1) {
      workers.push((async () => {
        while (!this.stopping) {
          const next = queue.shift()
          if (next === undefined) return
          const [, marker] = next
          await this.processOne(marker)
        }
      })())
    }
    await Promise.allSettled(workers)
  }

  private async processOne(marker: RunningMarker): Promise<void> {
    const { sessionId } = marker
    if (this.stopping || this.continued.has(sessionId)) return

    const record = this.ctx.im.sessions.get(sessionId)
    if (record === undefined) {
      this.forget(sessionId)
      return
    }
    if (this.ctx.agents.get(sessionId)?.status === 'running') return

    const now = this.now()
    if (this.config.maxAgeMs > 0 && now - marker.startedAt > this.config.maxAgeMs) {
      this.ctx.logger.info('im-auto-resume: skipping stale interrupted session %s (age %dms)', sessionId, now - marker.startedAt)
      this.forget(sessionId)
      return
    }

    let log
    try {
      log = await this.ctx.sessionQuery.readSession(sessionId)
    } catch (error: unknown) {
      this.ctx.logger.warn('im-auto-resume: reading session %s failed: %s', sessionId, String(error))
      this.forget(sessionId)
      return
    }
    if (this.stopping || this.continued.has(sessionId)) return
    if (log.session.origin === 'subagent' || !wasInterrupted(log.events)) {
      this.forget(sessionId)
      return
    }

    const domain = this.domain
    if (domain === undefined || this.stopping) return
    const windowCutoff = now - this.config.retryWindowMs
    const previous = domain.table('attempts').get(sessionId)?.timestamps ?? []
    const recent = previous.filter(ts => ts >= windowCutoff)
    if (recent.length >= this.config.maxRetries) {
      this.ctx.logger.warn(
        'im-auto-resume: session %s reached maxRetries (%d in %dms); giving up',
        sessionId, this.config.maxRetries, this.config.retryWindowMs,
      )
      this.forget(sessionId)
      const event: AutoResumeExhaustedEvent = {
        sessionId,
        ...marker.chat === undefined ? {} : { chat: marker.chat },
        attempts: recent.length,
      }
      this.ctx.emit('im/auto-resume-exhausted' as never, event as never)
      return
    }

    const updatedAttempts = [...recent, now]
    await this.writeNow(d => d.table('attempts').put(sessionId, { timestamps: updatedAttempts }))
    if (this.stopping || this.continued.has(sessionId)) return

    const trigger = marker.triggerKey === undefined ? undefined : this.ctx.im.history.get(marker.triggerKey)
    try {
      this.ctx.logger.info('im-auto-resume: resuming session %s (turn %d, attempt %d/%d)',
        sessionId, marker.turn, updatedAttempts.length, this.config.maxRetries)
      await this.ctx.im.sessions.deliver(sessionId, {
        id: `auto-resume:${sessionId}:${marker.turn}:${now}`,
        mode: 'followup',
        content: [{ type: 'text', text: this.config.continuationText }],
        ...trigger === undefined ? {} : { trigger },
      })
    } catch (error: unknown) {
      this.ctx.logger.warn('im-auto-resume: delivering resume for session %s failed: %s', sessionId, String(error))
      if (!this.stopping) this.forget(sessionId)
    }
  }

  private forget(sessionId: SessionId): void {
    this.write(domain => domain.table('running').delete(sessionId))
  }

  private write(op: (domain: ImAutoResumeDomain) => Promise<unknown>): void {
    if (this.stopping) return
    this.writes = this.writes.then(async () => {
      if (this.domain === undefined) return
      await op(this.domain)
    }).catch((error: unknown) => {
      this.ctx.logger.warn('im-auto-resume: storage write failed: %s', String(error))
    })
  }

  private async writeNow(op: (domain: ImAutoResumeDomain) => Promise<unknown>): Promise<void> {
    this.write(op)
    await this.writes
  }
}
