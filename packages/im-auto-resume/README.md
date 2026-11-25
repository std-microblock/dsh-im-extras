# `dsh-im-auto-resume`

IM-native automatic resume plugin for `dsh-im` sessions.

## What it does

- Observes `im/activity` and durably records running IM sessions (together with their target chat and original `trigger` message key) in the `im_auto_resume` storage domain.
- Clears the marker on normal turn settlement (`done`, `error`, or user-triggered `cancelled`), while keeping it across crashes and graceful host restarts (`activity.disposed === true`).
- On startup, verifies each marked session's log (`wasInterrupted`) and resumes it via `ctx.im.sessions.deliver` with the original `trigger`, preserving `agentPreset`, `composition.restrict`, quote/thread placement, and in-place streaming card continuation when paired with `dsh-im-output-summary`.
- Guards against crash loops with per-session `maxRetries` within `retryWindowMs`; when exhausted, emits `im/auto-resume-exhausted` so output renderers can close any lingering "restarting" card cleanly.
