---
name: connect-to-im
description: Register the current Codex session with its approved IM user, send messages, and wait for replies through agent-to-im MCP.
---

# Connect to IM

Call the installed `agent-to-im` MCP tools from this current native session. The MCP host supplies the thread identity; the sidecar identifies the native process and home. Broker creates its own queue-relay App Server and registers the session directly. The original CLI remains its execution owner throughout connection.

## Register

1. Discover `register`, `send_message_to_user` and `wait_for_user_message`, including their installed plugin namespace. The plugin initializes its local client and Broker on first tool use.
2. Call `register` with a concise title, stable idempotency key and `activate=true` for an explicit connection request.
3. Omit `connection_alias` when there is one approved IM recipient. If `CONNECTION_SELECTION_REQUIRED` returns choices, ask which private chat the user intends.
4. Keep the returned session ID and control mode. Technical home, process and transport information are managed outside model arguments.

Connection completes in this conversation. Preserve the native command, terminal, history and permissions. On a missing tool, invalid host identity or unavailable relay, report the exact error. On `CONNECTION_NOT_APPROVED`, the intended IM user should message the bot and have their platform identity approved in the Portal.

## Send and answer

Call `send_message_to_user` with the returned session ID, text and a stable idempotency key. Use purpose `progress`, `notice` or `result`.

An IM task includes `[agent-to-im job_id=...]`. Send its completed answer with `purpose=result` and that exact `job_id`. This explicit call records the task result. For CLI-origin messages, omit job_id. Keep task identifiers tied to their original session.

Report delivery according to queued/delivered/unknown. Reconcile uncertain sends with the same key and payload.

## Ask and wait

Call `wait_for_user_message` with mode ask, session_id, request_key and prompt. The correlated user reply returns to this tool call in the current conversation.

- answered: continue using the reply.
- waiting: when continued waiting is needed, use mode resume and the same request key.
- expired: report the deadline.
- cancelled: end that interaction.
- delivery_failed: report the delivery error.

The Broker routes ordinary IM text to the current session, or to its open question. IM task prompts enter the original session's native queue. Keep the original CLI open to consume them.

## Status and stop

Status reports the original owner process's availability and the Broker's queue/wait/result records. Relay metadata is not a measurement of a currently running model turn.

Stop cancels Broker work/waits, native queued prompts and the persistent goal. Its report explicitly identifies running native turns, child tasks or terminals that require native-owner controls. Describe complete=false and residuals accurately.

IM usage requires approval of the person at the IM boundary. Native execution permissions remain governed by Codex. On cancellation, stale epoch, revoked access or stopping state, end the affected messaging flow.
