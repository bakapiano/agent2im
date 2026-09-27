---
name: configure-im-channel
description: Help configure an IM channel through the agent-to-im MCP server, including sanitized settings, credential references, connection validation, and activation. Use when the user asks to set up or change a channel; first-use access decisions are made by the user in the local Web Portal.
---

# Configure IM Channel

Use the installed `configure_im_channel` MCP tool to help configure a Feishu channel. The service is implemented; `docs/quickstart.md` in the user's agent-to-IM project contains startup and MCP setup commands (initial installation: `D:/agent-to-IM`). Configuration needs an enrolled local client. Runtime attachment is required when the agent subsequently registers a session.

## Establish the requested change

1. Discover the actual prefixed tool name and call `operation=inspect`, `provider=feishu` to get supported fields and visible configuration.
2. Confirm the channel alias, desired display name, App ID, and whether the requested setup should be enabled. Use the service's returned revision for an update; a new configuration uses revision 0.
3. Obtain an existing `credential_ref`. In the Portal's Add Channel dialog, the user enters App Secret and chooses “仅保存凭据引用”, then supplies the returned `cred_...` reference. Keep credential values outside prompts, logs, and tool arguments.
4. Preserve unrelated channels and settings. The native Codex session continues to belong to its current host.

## Submit and handle first-use approval

Call `operation=upsert` with the intended settings, `expected_revision`, and a stable `idempotency_key`.

If the service returns `APPROVAL_REQUIRED`, show the request ID, requested change/scope, and the returned local Portal address. Pause this configuration action for the user's Web decision.

The service authenticates the local client and derives requested permissions. Keep authorization flags, role claims, owner IDs, raw credentials, and admin tokens outside configuration parameters.

Approval is a user action in the Web Portal. Let the user make that decision; preserve the administrator endpoint, browser session, and authorization database as the separate approval authority.

## Continue after approval

When the user says approval is complete:

1. Query `operation=approval_status` with the returned request ID.
2. On `approved`, retry the original operation with the same idempotency key and payload.
3. On `pending`, explain that the decision is still pending and yield. On `denied`, `expired`, or `revoked`, report the state and stop this action.
4. If the current config revision changed, inspect it and resolve the change with the user before submitting a revised request.

## Validate and enable

After saving, call `operation=validate` for the returned channel ID/revision. Use a distinct stable key for validation.

If enabling is part of the user's requested setup and validation succeeds, call `operation=set_enabled` with `enabled=true`, the current revision, and a distinct key. Disabling an existing channel uses the same operation with `enabled=false` when requested.

The service checks platform identity continuity and current grants. If a new approval is required, follow the same Web decision flow.

Summarize saved/validated/enabled status exactly as returned. A connection test validates the configured channel; message sending follows the separate authorized messaging route.

## Scope boundaries

- This skill manages channel configuration. Use the separate connect-to-im workflow for registering a live Agent session and communicating with its user.
- Each IM user completes their own first-use Web approval. A configuration grant has its own scope.
- On `ACCESS_DENIED`, `ACCESS_REVOKED`, or a credential-reference error, report the exact setup or authorization requirement and pause the affected action.
- Query only the current client's approval requests. Use idempotency keys to reconcile uncertain outcomes.
