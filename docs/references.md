# 依据与接口验证

核对日期：2026-09-26。下面把外部已验证接口与本项目设计选择分开记录。

## 官方资料

| 编号 | 来源 | 本稿使用范围 |
| --- | --- | --- |
| S1 | `https://developers.openai.com/codex/app-server` | 初始化、thread 创建/恢复、turn、状态事件、中断、goal 与后台 terminal |
| S2 | `https://developers.openai.com/codex/mcp` | stdio、配置文件、环境变量、工具超时 |
| S3 | `https://github.com/larksuite/node-sdk/blob/main/README.md` | WSClient、EventDispatcher、私聊消息收发、及时完成回调 |
| S4 | `https://open.feishu.cn/document/server-docs/im-v1/message/create` | 消息发送 API、chat ID 与权限；客户端幂等能力待实际验收 |
| S5 | `https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects` | Windows 受管进程组、后代进程和终止边界 |
| S6 | `https://modelcontextprotocol.io/specification/2025-06-18/server/tools` | 工具 schema、结果与错误语义 |
| S7 | `https://modelcontextprotocol.io/specification/2025-06-18/basic/utilities/cancellation` | MCP 调用取消；业务问题的持久化规则由本项目定义 |
| S8 | `https://developers.openai.com/codex/cli/reference` | 原生 resume、remote 连接和工作目录选择 |
| S9 | `https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html` | 默认拒绝、逐请求权限校验与最小权限 |
| S10 | `https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html` | 管理端 CSRF、SameSite 与 Origin 校验 |

来源页随产品更新。本地精确方法与参数以安装版本生成的 schema 为准。

## 本机只读检查

- Codex CLI：`0.154.0`。
- Node.js：`v22.23.2`。
- Python：`3.13.5`。
- TypeScript：`5.1.6`。
- `codex queue --help` 确认 `--thread`、`--message`、`--remote` 及远程令牌环境变量选项。
- `codex resume --help` 确认按原生 session ID 继续，并提供 `--remote`、`--all`、`--include-non-interactive`。
- 通过 `codex app-server generate-json-schema` 及 `--experimental` 生成 schema，读取 ClientRequest 与参数定义。

### 已在生成的 schema 中确认

| 方法/族 | 结果 |
| --- | --- |
| `thread/start`, `thread/resume`, `thread/read`, `thread/list` | 原生 thread 控制与查询 |
| `turn/start`, `turn/steer`, `turn/interrupt` | turn 控制；interrupt 必填 threadId 和 turnId |
| `thread/goal/clear` | 必填 threadId |
| `thread/queue/add/list/update/delete/reorder/start` | 实验 schema 中存在，需要按版本适配 |
| `thread/backgroundTerminals/clean` | 实验接口，必填 threadId |
| `thread/backgroundTerminals/list` | 实验接口，可分页 |
| `thread/backgroundTerminals/terminate` | 实验接口，必填 threadId 与 processId |
| `process/kill` | 实验接口，使用连接作用域 processHandle |
| `thread/queue/changed`, `thread/closed` | 服务端通知存在 |
| `ThreadStartParams.ephemeral` | 可显式选择持久 thread；具体落盘时机待 P0 验收 |
| `Thread.id` / `Thread.sessionId` | thread 恢复 ID 与 session tree 关联字段分别存在 |
| `ThreadListParams.sourceKinds` | 默认交互来源筛选；来源枚举包含 appServer/cli/exec 等 |
| `ThreadResumeParams` | 后续原生恢复接口；当前接入使用队列投递 |

Schema 存在代表接口形状可检查；真正的执行范围、并发时序、权限和 Windows 进程效果由 P0 实测确认。

## 本项目定义的语义

以下是当前架构决策：稳定 Session UUID、私聊当前选择、Web 首次审批与持久 Grant、四个 MCP 工具、持久化 wait、control_epoch、消息幂等、结果补发规则、StopReport 和 Adapter 契约。

这些业务语义由 Broker 实现，不依赖模型自行记忆，也不假定平台原生提供相同保证。

后续生命周期参考见 [Session 生命周期](session-lifecycle.md)，Claude/Copilot 接入保留在[调研记录](research/agent-host-integration.md)。当前首期范围以 [scope.json](../spec/scope.json) 为准：已有 Codex + 飞书 + Portal + Web 首次审批。

## 本轮交付验证

设计检查脚本负责：MCP 工具输入 schema 的正反例验证、TypeScript 契约编译、首期工具清单与本地文档链接检查。两份 Skill 使用 skill-creator 的 quick_validate 校验。

Portal、授权、运行服务、DPAPI、MCP 和真实 Codex/模拟模型/隔离 IM 接线已完成本地验收；飞书真实平台与实际子任务负载验收等待人工配置。用户已有 Codex 配置、账户凭据和外部聊天状态保持原样。详情见 [验收记录](acceptance.md)。

实施使用项目本地 Node 24.21.0、TypeScript 7.0.2；前文 Node 22/TypeScript 5 为调研时的全局环境记录。SDK 与库精确版本保存在 package.json / pnpm-lock.yaml。

补充核对：`https://developers.openai.com/codex/config-schema.json` 中 `McpServerToolConfig.approval_mode` 与 server 默认原生工具审批模式，使用隔离实例验证。
