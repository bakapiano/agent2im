# 私聊与 MCP 协议

版本：v0.2。运行接口已实现；当前实测范围见 [验收记录](acceptance.md)。

## 1. IM 命令

| 输入 | 行为 |
| --- | --- |
| `/sessions` | 列出当前 owner 的 session：短 ID、标题、工作区、状态、当前选择标记 |
| `/switch <session_short_id>` | 原子切换当前私聊指向，返回该 session 的状态摘要 |
| `/status [session_short_id]` | 查询指定或当前 session 的原生状态、排队数、等待、健康与停止范围 |
| 普通文本 | 回复当前 session 的开放问题，或作为当前 session 的新任务 |
| `/send <session_short_id> <text>` | 明确向指定 session 提交一个新任务，当前选择保持原样 |
| `/reply <question_short_id> <text>` | 回答特定问题，按该问题的原始 session 路由 |
| `/stop [session_short_id]` | 停止指定或当前 session 的当前工作树，保留历史 |
| `/help` | 显示当前已实现的命令与简要示例 |

会话标识由 Broker 解析，并校验 owner。所有命令和普通输入都保留原平台消息 ID。重复投递返回同一控制操作或任务回执。

首次未授权身份只产生 Web 待审批申请和中性提示。批准持久 Grant 后，用户重新发送命令。Chat new 与托管 release 属于后续阶段。

### 1.1 Session 生命周期

会话来源为用户本地已运行并注册的 Codex。切换后普通消息使用新的选择，已接受消息按固化目标执行。新任务校验当前 Grant 与活 runtime；宿主已退出时返回原生恢复/重新注册指引。

`/status` 展示原生状态、授权范围、连接健康和停止能力。后续托管生命周期见 [生命周期设计](session-lifecycle.md)。

### 1.2 展示建议

```text
[s_a7af · 登录问题 · running]
已开始检查登录回调。

[s_a7af · 问题 q_4f8c]
是否按你刚才确认的范围继续修改？
可引用本条回复，或发送 /reply q_4f8c 你的回答
```

不同 session 的后台输出都带来源标签。`/status` 展示：`state`、`current_task`、`queued_jobs`、`waiting_questions`、`runtime_health`、`last_seen_at`、`stop_scope`、`control_epoch`、必要的残留任务。

## 2. MCP 公共契约

四个工具的输入以 [mcp-tools.json](../spec/mcp-tools.json) 为准，返回类型以 [contracts.ts](../spec/contracts.ts) 为准。

MCP 接口接收公开 ID 和内容。本地 sidecar 在模型参数之外附加可信的运行上下文：runtime ID、原生 thread、caller turn、owner 及控制 epoch。模型传入的 Session ID 与可信上下文必须一致。

配置工具验证 local client 身份后直接执行；会话工具核验原生 thread。与 IM 互动时，AccessPolicy 读取 Web 批准的 IM 使用者决定，并在实际派发时重新检查。

返回统一使用：

```json
{
  "ok": true,
  "data": {}
}
```

业务失败返回 `ok=false` 和 `error.code/message/retryable`。MCP 层同时设置 `isError=true`；JSON-RPC 层错误留给传输、解析和方法级错误。普通超时状态 `waiting` 是成功的业务结果。

### 2.1 `register`

用途：注册当前真实 Codex 会话，并关联一个已授权私聊入口。

`connection_alias` 为可选：唯一获批私聊自动选择，多项候选返回 `CONNECTION_SELECTION_REQUIRED`。MCP 从本次宿主元数据识别 thread 和原进程，Broker 启动队列中继读取元数据后直接登记。原 CLI 保持执行权。

```json
{
  "connection_alias": "personal-feishu",
  "title": "登录问题",
  "idempotency_key": "register-login-investigation-01",
  "activate": false
}
```

`native_thread_id` 为可选一致性校验值。最终身份来自本次 MCP 宿主元数据及原生会话元数据。

返回示例：

```json
{
  "ok": true,
  "data": {
    "session_id": "a7af2b6e-c63b-4e53-9e55-727ef62c9b16",
    "short_id": "s_a7af",
    "title": "登录问题",
    "connection_id": "conversation-personal-feishu",
    "runtime_id": "runtime-login-01",
    "native_thread_id": "01982fd1-f789-73b2-994a-538bf2c7ad12",
    "control_mode": "queue_relay",
    "stop_scope": "tracked_resources",
    "active": false,
    "control_epoch": 1
  }
}
```

幂等与权限：

- 相同 verified native identity 在同一 Agent home 中返回同一个 Session；多个进程重复声明所有权时执行冲突核对。
- 幂等键按 owner 和 runtime 限定，同键不同内容返回 `IDEMPOTENCY_CONFLICT`。
- 同键重试读取首次操作结果；新的激活意图使用新的幂等键，避免重试覆盖用户后来的选择。
- 注册自动核验当前原生会话并绑定已批准的 IM 收件人。原始收件人和 App Server 地址由受信控制面维护。
- `activate=true` 明确请求切换选择；后台续租或重连默认保留用户选择。
- 重复注册更新标题与连接健康，现有停止 fence 继续有效。

### 2.2 `send_message_to_user`

用途：当前 Agent 主动发送消息到绑定的私聊。IM 任务完成时使用 purpose=result 并附带原任务 job_id，服务据此记录明确结果。

```json
{
  "session_id": "a7af2b6e-c63b-4e53-9e55-727ef62c9b16",
  "text": "已经定位到回调参数处理问题，正在准备修改。",
  "purpose": "progress",
  "idempotency_key": "login-turn-01-progress-01"
}
```

`purpose`：`notice`、`progress`、`result`，默认 `notice`。`result` 与 Broker 的最终结果补发共享 native turn 投递键。

返回字段：`message_id`、`session_id`、`conversation_id`、`delivery_status`、可选 `platform_message_id`。状态区分：

| 状态 | 含义 |
| --- | --- |
| `queued` | 已可靠入 Outbox，等待平台投递 |
| `delivered` | 已获得平台成功回执 |
| `unknown` | 发送发生后回执不确定，需要核对 |

相同幂等键和相同内容读取原结果。发送内容变化时使用新键。Agent 复述发送结果时应保留上述状态区别。

### 2.3 `wait_for_user_message`

用途：先发送一个问题，然后阻塞当前 MCP 调用，直到取得回复或达到本次阻塞时限。

首次询问：

```json
{
  "session_id": "a7af2b6e-c63b-4e53-9e55-727ef62c9b16",
  "mode": "ask",
  "request_key": "login-turn-01-question-01",
  "prompt": "这次修改应覆盖生产配置还是测试配置？",
  "timeout_seconds": 240,
  "reply_ttl_seconds": 1800
}
```

同一个问题继续等待：

```json
{
  "session_id": "a7af2b6e-c63b-4e53-9e55-727ef62c9b16",
  "mode": "resume",
  "request_key": "login-turn-01-question-01",
  "timeout_seconds": 240
}
```

规则：

- `ask` 的 prompt 必填；相同 request key 的重试读取原请求。
- 同一 request key 的 ask 保持原 prompt 与 TTL；载荷变化返回 `IDEMPOTENCY_CONFLICT`。resume 可调整本次阻塞时限，问题期限保持原值。
- `resume` 读取同一个问题，维持原文与原始截止时间。
- 单次等待为 1–300 秒，默认 240 秒；问题有效期 60–3600 秒，默认 1800 秒。
- 超时预算：Broker 业务阻塞上限 300 秒；MCP 客户端示例使用 360 秒。
- 同一 session 同时有一个开放问题；第二个问题返回 `WAIT_ALREADY_OPEN`。
- 结果同时包含原始 Session ID 和 request ID，当前私聊选择的变化保持这些 ID 不变。

返回 `data.status`：

| 状态 | Agent 的处理 |
| --- | --- |
| `answered` | 读取 `reply.text`、发送者和消息证据，继续原任务 |
| `waiting` | 问题仍有效；需要继续等时用同一 request key 调用 resume |
| `expired` | 问题期限结束，向用户说明等待结束 |
| `cancelled` | 当前任务已取消或停止，结束这条等待流程 |
| `delivery_failed` | 问题发送失败，报告投递问题 |

收到答案示例：

```json
{
  "ok": true,
  "data": {
    "status": "answered",
    "session_id": "a7af2b6e-c63b-4e53-9e55-727ef62c9b16",
    "request_id": "question-4f8c-01",
    "question_short_id": "q_4f8c",
    "reply": {
      "message_id": "inbound-007",
      "platform_message_id": "om_example007",
      "principal_id": "owner-01",
      "text": "先覆盖测试配置。",
      "received_at": "2026-09-26T09:00:00Z"
    }
  }
}
```

答案直接返回原工具调用。任务队列记录它已被 WaitRequest 消费，后续只允许审计查询。

### 2.4 `configure_im_channel`

用途：已认证本地 Agent 直接配置渠道，复用 Portal 的配置服务。操作为 `inspect`、`upsert`、`validate`、`set_enabled`。

配置示例：

```json
{
  "operation": "upsert",
  "provider": "feishu",
  "channel_alias": "feishu-main",
  "display_name": "我的飞书",
  "app_id": "cli_example123",
  "credential_ref": "cred_feishumain01",
  "expected_revision": 0,
  "idempotency_key": "feishu-main-config-01"
}
```

凭据引用通过 Portal 安全录入产生。配置操作直接执行，并校验 revision 和幂等键。配置成功后验证并按用户意图启用；IM 使用者是否可以互动由 Web 单独审核。详情见 [Portal 与审批](portal-and-access.md)。

## 3. 错误码

| 错误码 | 含义/下一步 |
| --- | --- |
| `ACCESS_DENIED` | 目标 IM 使用者尚未获准互动或资格已结束 |
| `ACCESS_REVOKED` | 授权已撤销，停止对应通道操作 |
| `CONNECTION_NOT_APPROVED` | 目标私聊用户或路由需要 Web 批准 |
| `CONFIG_REVISION_CONFLICT` | 读取当前渠道 revision，再提出修改 |
| `CREDENTIAL_REF_INVALID` | 凭据引用的 owner、用途或平台校验失败 |
| `BROKER_UNAVAILABLE` | 原生会话继续使用；恢复 Broker 连接后重试 IM 操作 |
| `RUNTIME_UNREACHABLE` | 检查已登记 App Server 的状态 |
| `THREAD_CONTEXT_UNVERIFIED` | 提供或修复当前会话的受信运行描述 |
| `THREAD_OWNERSHIP_CONFLICT` | 核对现有 native thread 的运行所有权 |
| `SESSION_OFFLINE` | 由用户原生恢复会话，再注册当前活实例 |
| `SESSION_NOT_REGISTERED` | 当前会话先调用 register |
| `SESSION_FORBIDDEN` | owner、route 或 caller thread 与该 Session 不一致 |
| `SESSION_STOPPING` | 等待当前停止操作完成 |
| `STALE_CONTROL_EPOCH` | 当前调用属于已被停止的旧任务世代 |
| `WAIT_ALREADY_OPEN` | 恢复已有问题，或由用户先结束原问题 |
| `WAIT_NOT_FOUND` | 该 session 下没有这个 request key |
| `IDEMPOTENCY_CONFLICT` | 同一幂等键出现了不同业务载荷 |
| `DELIVERY_UNKNOWN` | 核对平台发送回执后再决定后续动作 |
| `STOP_INCOMPLETE` | 停止报告包含残留资源，派发闸门继续关闭 |

## 4. 取消与特殊竞态

- `wait` 正在阻塞时 `/status`、`/switch`、`/stop` 仍可响应。
- `/stop` 与用户答案竞争时，数据库以 Session epoch 和 WaitRequest 状态做比较更新。被停止的旧 epoch 答案保留审计。
- 用户发送 `/switch B` 后再普通回复，按 B 处理；对 A 问题的引用或 `/reply` 仍指向 A。
- 切换选择与后台输出竞争时，旧任务结果保持原 Session 标签和原授权目的地。
- Web 撤销授权、渠道身份变更与派发竞争时，按最新 Grant/identity version 再校验。
- 重启后读取已保存答案，恢复同一等待请求；相同结果的再次读取保持幂等。
- 出站重试复用业务幂等键，平台实际发送状态优先于本地超时推测。

## 5. 版本化

公共工具名在 v1 保持稳定。接口统一按当前格式执行，新增 IM 使用同一规范化对象。调整消息归属、等待消费或停止语义时升级 contract version，并增加行为验收用例。
