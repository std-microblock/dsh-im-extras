# dsh-im-session-auth

Session exclusivity, collaborator delegation, and extensible capability grants (`ctx.imAuth`) for DeepSeek Harness IM task sessions.

## Concepts

- **Session Exclusivity (`SessionAuthRecord`)**: Once claimed (by granting a capability, claiming exclusivity via `<AuthRequest />`, or adding a collaborator), a session only accepts IM interactions from its owner and explicitly added collaborators.
- **Capability Providers (`CapabilityProvider`)**: Domain plugins (such as `dsh-feishu-project-auth`, or future action-gate / resource-lease plugins) register capabilities into `ctx.imAuth`. The core auth layer stays agnostic to credentials or OAuth.
- **Tools**: `grant_session_access`, `revoke_session_access`, and `get_session_access` are activated on task worker sessions.
