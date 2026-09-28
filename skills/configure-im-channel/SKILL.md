---
name: configure-im-channel
description: Configure an IM channel through the agent-to-im MCP server using credential references, connection validation, and activation. Use when the user asks to set up or change a channel.
---

# Configure IM Channel

Use the installed `configure_im_channel` MCP tool from the authenticated local client. The local service and native session identity are handled by the installation.

## Configure

1. Call `operation=inspect`, `provider=feishu` to get channel settings and requirements.
2. Use the user's intended alias, display name and App ID. Read the current revision before updating.
3. Obtain a `credential_ref` from the Portal credential form. Keep raw App Secret values out of tool arguments and conversation output.
4. Call `upsert` with the settings, credential reference, expected revision and a stable idempotency key.
5. Call `validate` with the returned channel ID/revision. Enable with `set_enabled` when requested by the user.

Configuration is available directly to the authenticated local client. Web approval governs the IM people who may interact with the Agent. A changed bot identity invalidates those people's prior identity-bound approvals.

Retry an uncertain operation with the same payload and idempotency key. On a revision conflict, inspect and reconcile the user's intended changes. On credential or client-authentication errors, report the specific setup problem.

Report saved, validated, enabled and connection-health states from the actual results. Preserve unrelated channels and native Codex configuration.
