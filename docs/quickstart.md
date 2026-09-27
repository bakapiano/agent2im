# 本地运行与现有会话接入

验收基线：Windows、Node.js 24、pnpm 10、Codex CLI 0.154.0。依赖由 `pnpm-lock.yaml` 锁定。原生接口含实验方法；升级 Codex 后重新运行验收。

## 1. 构建与启动

在 `D:\agent-to-IM` 打开 PowerShell 7。项目已配有 `.tools/node-v24.21.0-win-x64`，`project.ps1` 仅为当前子进程设置 PATH。

```powershell
pwsh -NoProfile -File ./scripts/project.ps1 install --frozen-lockfile
pwsh -NoProfile -File ./scripts/project.ps1 build
pwsh -NoProfile -File ./scripts/project.ps1 exec node dist/cli.js serve --data-dir D:/agent-to-IM/.local --workspace agent-im=D:/agent-to-IM
```

Portal 默认 `http://127.0.0.1:17643`。初次设置需要启动终端显示的令牌和至少 12 字符的管理员密码。令牌随服务进程更新。Agent RPC 默认 `127.0.0.1:17642`。

可通过 `--portal-port`、`--agent-port` 调整端口。多个工作区可重复传入 `--workspace alias=absolute-path`；当前实现按工作区根目录精确匹配原生 cwd。

数据目录保存 `settings.json`、SQLite 数据库和 DPAPI 加密的安装身份。渠道凭据经 Web 输入，数据库保存密文。数据目录使用当前 Windows 用户 ACL；同一 OS 用户属于同一信任边界。

## 2. 飞书配置与首次身份审批

1. 在飞书开发平台准备自建应用，启用机器人，完成应用发布和可用范围配置。
2. 配置接收单聊消息、机器人发送消息所需权限，以及长连接事件 `im.message.receive_v1`。
3. Portal → 渠道与连接 → 添加飞书渠道，填写 App ID / App Secret，保存后依次“验证”“启用”。页面展示 SDK 的长连接状态。
4. 目标用户私聊机器人，发送 `/sessions`。首次只保留审批身份元数据，并提示本地管理员审阅。
5. 管理员在“访问审批”核对平台 user ID、租户、渠道身份版本、工作区和权限，人工批准。
6. “已发现的私聊连接”出现 `dm-xxxxxxxx`，这是 MCP `register.connection_alias` 使用的别名。用户重新发送操作。

Agent 辅助配置：在“添加飞书渠道”中“仅保存凭据引用”，把 `cred_...` 给 Agent。`configure_im_channel` 产生独立的 Agent 配置权限申请；Web 批准后重试。密钥保留在 Web 输入流程中。

## 3. 登记本地 MCP 客户端

保持 Broker 运行，在另一个 PowerShell 执行：

```powershell
pwsh -NoProfile -File ./scripts/project.ps1 exec node dist/cli.js enroll --data-dir D:/agent-to-IM/.local --name codex-session-a --descriptor D:/agent-to-IM/.local/client-a.dpapi
```

每个同时运行的原生会话使用自己的描述文件。文件经 Windows DPAPI 加密。登记建立客户端身份，访问范围随后由 Web 授权。

根据 [MCP 示例](../examples/codex-mcp.example.toml)，由用户选择性合并条目到该会话所用的 Codex 配置。当前程序保留用户已有的全局配置。

两份 Skill 可由用户复制到自己的 Codex skills 目录，或直接指示 Agent 阅读本项目的 `skills/connect-to-im/SKILL.md` 和 `skills/configure-im-channel/SKILL.md`。

## 4. 附着到同一个已运行的 App Server

准备当前会话所属 App Server 的回环 WebSocket 地址、原生 thread ID、Codex home、cwd。目标 thread 必须在服务器的 `thread/loaded/list` 中，并已完成至少一个持久化 turn。

```powershell
pwsh -NoProfile -File ./scripts/project.ps1 exec node dist/cli.js attach --data-dir D:/agent-to-IM/.local --descriptor D:/agent-to-IM/.local/client-a.dpapi --endpoint ws://127.0.0.1:4500 --thread YOUR_NATIVE_THREAD_ID --home C:/Users/Administrator/.codex --cwd D:/agent-to-IM --workspace-alias agent-im --server-name agent-to-im
```

端口与 thread ID 由用户实际实例提供。带认证的 App Server 可使用 Web 凭据接口保存 Codex token，再传 `--credential-ref cred_...`。该 API 为 `POST /api/credentials`，用途字段为 `codex`，要求管理员 Cookie 与 CSRF；当前 UI 的凭据录入表面专用于飞书。

Broker 核对目标已加载、原生 cwd 与配置一致并订阅事件。接着由**这个原生会话**使用 `$connect-to-im` 调用 `register`，填写 `dm-...`，按用户意图设置 `activate=true`。

首次注册会产生 Agent `session.register` / `message.send` 申请。Web 批准后以相同幂等键重试。Broker 使用 App Server 的实际 `mcpToolCall` 事件证明调用来自对应 thread/turn。

已有 TUI 可经 Codex `--remote` 连接到用户选择的 App Server。当前适配入口为回环 WebSocket；默认 daemon 的其他传输需由用户预先建立相应入口。迁移已有会话宿主、重新启动 TUI 等动作由用户按原生工作流安排。

### 原生审批

Codex 的 MCP 工具审批和本项目 Web 访问审批独立生效。用户应先在原生终端完成消息工具的信任/审批设置。`approval_policy=never` 会使仍需审批的工具调用直接失败。

用户可明确选择已安装版本的 per-tool `approval_mode`。默认示例保留原生审批策略。自动验收仅在隔离实例中配置该 MCP server 的 `default_tools_approval_mode="approve"`。

## 5. 私聊使用

```text
/sessions
/switch s_12345678
/status
帮我检查当前任务的测试结果
/send s_87654321 检查另一个会话的任务
/reply q_12345678 继续处理
/stop
```

普通消息回复当前会话的开放问题，或为当前会话排入任务。引用原问题、`/reply` 固定回到原会话。输出包含来源标签。

`/stop` 立即关闭当前任务世代的派发，取消持久等待、排队消息和任务，清理原生队列、goal、turn 与可枚举后台终端/子会话，并报告残留。`stop_incomplete` 时核对状态后重试停止。投递中的平台消息可能需要人工核对。

历史继续保存在原生 home。停止保留原生 ID 和历史；原生 resume 恢复同一会话后，再附着当前活实例。重新绑定另一 home、客户端或私聊路由需要单独审阅。

## 6. 本地验收

```powershell
pwsh -NoProfile -File ./scripts/project.ps1 exec playwright install chromium
pwsh -NoProfile -File ./scripts/project.ps1 check
pwsh -NoProfile -File ./scripts/check-design.ps1
```

`check` 构建程序、运行契约/核心/API/DPAPI/MCP/真实 Codex 测试和浏览器测试。原生测试使用独立 home、工作目录、仅本机的模型模拟端点和假 IM，临时文件位于忽略提交的 `.test-data`。可通过 `AGENT_IM_CODEX_EXE` 指定本机 Codex 可执行文件。

真实飞书验收按 [验收记录](acceptance.md) 的人工清单执行。
