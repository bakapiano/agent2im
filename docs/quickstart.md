# 本地运行与队列接入

验收基线：Windows、Node.js 24、Codex CLI 0.154.0。当前数据库 schema 为 4。

## 构建与启动

在 D:/agent-to-IM 中执行：

```powershell
pwsh -NoProfile -File ./scripts/project.ps1 build
pwsh -NoProfile -File ./scripts/project.ps1 exec node dist/cli.js serve --data-dir D:/agent-to-IM/.local
```

Portal 默认 `http://127.0.0.1:17643`，Agent RPC 为 `http://127.0.0.1:17642`。首次设置使用终端显示的 bootstrap 令牌建立管理员密码。

空库直接初始化，已存在的数据库必须采用 schema 4。程序对格式不一致返回明确错误。

## 配置飞书与审核使用者

1. 飞书应用启用机器人、单聊消息权限与长连接事件，发布应用。
2. Portal 添加 App ID/App Secret，保存、验证并启用。
3. IM 使用者私聊机器人，首次生成身份申请。
4. 管理员核对平台 ID、租户和渠道，允许该用户互动。
5. 用户重新发送 /sessions。

已认证本地 MCP 可通过 configure_im_channel 配置渠道，密钥使用 Portal 保存的 credential_ref。使用者审批只在 IM 端生效。

## 安装 MCP 与 Skill

初次登记本地凭据：

```powershell
pwsh -NoProfile -File ./scripts/project.ps1 exec node dist/cli.js enroll --data-dir D:/agent-to-IM/.local --name local-codex --descriptor D:/agent-to-IM/.local/client-a.dpapi
pwsh -NoProfile -File ./scripts/project.ps1 exec node dist/cli.js install-local --data-dir D:/agent-to-IM/.local --codex-home C:/Users/Administrator/.codex
```

install-local 只同步本项目 MCP 与两份 Skill。其他配置、原生命令及 PowerShell profile 保持原样。MCP 固定到构建发布路径；配置备份支持显式 rollback-local。Skill 在后续回合可发现，MCP 进程重载时读取安装版本。

## 当前对话直接接入

在正在运行的 Codex 会话调用 `$connect-to-im`。Agent 调用 register，提供标题、幂等键及 activate=true。身份来自本次宿主元数据，技术参数由服务读取。

Broker 启动独立 App Server 作为队列中继，读取当前 thread 元数据并登记。原 CLI 始终持有执行权，并消费 thread/queue/add 投递的消息。接入成功以 register 返回 session_id 为准。

## 私聊

```text
/sessions
/switch s_12345678
/status
检查当前项目并通过 MCP 回传结果
/send s_87654321 处理另一项任务
/reply q_12345678 继续
/stop
```

IM 任务带 job_id，Agent 通过 send_message_to_user 的 purpose=result、job_id 明确回传。开放问题的回复返回当前 MCP 等待调用。

原 CLI 保持打开以消费队列。状态展示宿主在线性和 Broker 工作记录，实时模型执行状态标为 unobserved。/stop 清理队列、持续目标和 Broker 等待，原宿主的运行中 turn/子任务/终端清理以残留报告明确列出。

## 验收

```powershell
pwsh -NoProfile -File ./scripts/project.ps1 check
pwsh -NoProfile -File ./scripts/check-design.ps1
```

真实 CLI 测试使用隔离 home、模拟模型和假 IM，验证当前会话持续在线、直接注册、收发、问答、任务结果及停止能力边界。详见[验收记录](acceptance.md)。
