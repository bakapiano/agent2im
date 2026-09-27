---
name: connect-to-im
description: Connect the current Codex session to an authorized IM private chat through the agent-to-im MCP server. Use when the user asks to register this session, send its user a message, or ask and wait for a reply through the existing connection.
---

# Connect to IM

Use the installed `agent-to-im` MCP tools to register the current existing session and communicate with its Web-approved user. The Windows service and MCP sidecar are implemented. If setup is needed, read `docs/quickstart.md` in the user's agent-to-IM project (the initial installation is `D:/agent-to-IM`).

The session-specific sidecar reads a DPAPI-protected descriptor created by `enroll` and bound by `attach`. The Broker must already observe that same live App Server thread before registration. Registration proves the actual MCP call's native thread and turn. Keep each live session's descriptor separate.

## Register the current session

1. Discover the server's actual tool names: `register`, `send_message_to_user`, and `wait_for_user_message`. Host-added prefixes may vary.
2. Obtain the user's intended approved private-chat connection alias (`dm-...`) from the launch context or ask for it. The Portal shows it after the user's first-contact approval. The channel alias (`feishu-main`) identifies a different object.
3. Call `register` with `connection_alias`, a concise `title`, and a stable `idempotency_key`. Set `activate=true` only when the user wants this session selected in IM.
4. The service verifies native identity. If the current launch context exposes a thread ID, it may be passed as `native_thread_id` for consistency checking. Let the service report missing or conflicting identity information.
5. Keep the returned `session_id`, short ID, connection, and stop scope in task context. Subsequent tools use exactly this returned ID. Re-registration of the same verified session retrieves the same record.

If tools, approved access, or runtime identity are missing, state the specific setup requirement and pause connection work. On `APPROVAL_REQUIRED`, show the returned request ID and Portal address, and let the user make the Web decision. Continue after the service confirms current authorization. Keep existing Codex configuration and other sessions unchanged.

This phase registers an already running session. Channel setup can use the configure-im-channel skill when available; the service exposes `configure_im_channel` as its configuration tool.

Codex's native tool approvals remain a separate authority. If Codex asks for messaging-tool approval, ask the user to handle the native prompt or deliberately configure that tool's policy. Preserve native sandbox and approval settings. A Web grant authorizes the IM route, while native policy governs whether the tool call can execute.

## Send a message

Use `send_message_to_user` with `session_id`, `text`, and a distinct stable `idempotency_key` for each logical message.

- `purpose=progress`: meaningful task progress.
- `purpose=notice`: a standalone update.
- `purpose=result`: the answer for an IM-origin task, enabling result deduplication.

The service resolves the authorized recipient. Report `queued`, `delivered`, or `unknown` according to the tool result. An uncertain delivery should be reconciled through the same idempotency key.

For an IM-origin task, send its user-visible final answer with `purpose=result`. For a CLI-origin task, send updates within the user's requested messaging scope.

## Ask and wait

Use `wait_for_user_message` with `mode=ask`, `session_id`, a stable `request_key`, and `prompt`. The call sends the question and returns its correlated reply or a bounded-wait status.

- `answered`: use the returned user's text and identity evidence to continue the original task.
- `waiting`: when the task still calls for waiting, call again with `mode=resume` and the same request key. Preserve the original question and deadline.
- `expired`: explain that the waiting period ended and yield.
- `cancelled`: stop this task's messaging/waiting flow.
- `delivery_failed`: report the delivery problem and seek scoped direction.

Maintain one open question per session. New task information from another session remains associated with that session; the tool result identifies the original session and question.

## Scope and stopping

The tool's user reply is ordinary conversation evidence. Permission changes and native execution approvals follow their dedicated authorization flow.

On `SESSION_STOPPING`, `STALE_CONTROL_EPOCH`, `ACCESS_REVOKED`, or a cancellation result, end the affected messaging/control flow. Fresh user direction and current authorization govern subsequent work. Keep sensitive material and new recipients within the user's explicit authorization.
