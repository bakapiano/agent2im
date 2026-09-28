---
name: configure-im-channel
description: Configure an IM channel through the agent-to-im MCP server using credential references, connection validation, and activation. Use when the user asks to set up or change a channel.
---

# Configure IM Channel

Discover the installed `configure_im_channel` MCP tool, including any plugin namespace. The plugin handles local service startup and client enrollment on the first tool call.

## Select the IM provider

Use the provider named by the user, then call `inspect` for that provider. IDs are `feishu`, `wechat`, and `qq`. When the request leaves the provider open, inspect `feishu` to discover the current catalog and existing channels.

Read only the corresponding guide:

- Feishu: [references/im/feishu.md](references/im/feishu.md).
- WeChat: [references/im/wechat.md](references/im/wechat.md).
- QQ: [references/im/qq.md](references/im/qq.md).

Use the returned `status` to determine the next action. For `planned`, explain the stage and retain the user's chosen platform as an extension request. Request credentials only for a `ready` provider.

## Configure

1. Use the selected provider's settings, requirements and guide from `inspect`.
2. Use the user's intended alias, display name and App ID. Read the current revision before updating.
3. Open the local Portal when credentials or first-use administration are needed. Run `powershell -NoProfile -File <plugin-root>/scripts/portal.ps1` yourself; resolve plugin-root from this skill's location (`../../`). This opens the browser and supplies the first-use setup token locally. Obtain a `credential_ref` from the Portal credential form. Keep raw App Secret values out of tool arguments and conversation output.
4. Call `upsert` with the settings, credential reference, expected revision and a stable idempotency key.
5. Call `validate` with the returned channel ID/revision. Enable with `set_enabled` when requested by the user.

Configuration is available directly to the authenticated local client. Web approval governs the IM people who may interact with the Agent. A changed bot identity invalidates those people's prior identity-bound approvals.

Retry an uncertain operation with the same payload and idempotency key. On a revision conflict, inspect and reconcile the user's intended changes. On credential or client-authentication errors, report the specific setup problem.

Report saved, validated, enabled and connection-health states from the actual results. Preserve unrelated channels and native Codex configuration.
