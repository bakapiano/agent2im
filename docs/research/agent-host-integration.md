# Claude Code 与 Copilot CLI：后续接入调研

调研记录：2026-09-26。两条路线作为后续技术储备，首期交付保持 Codex CLI + 飞书私聊。

## Claude Code

优先研究原生 Channels。它是在 Claude 会话中启用的 MCP 扩展：服务声明 `claude/channel`，通过 `notifications/claude/channel` 推送外部消息。消息进入当前运行会话；忙碌期间的输入按原生队列处理。回复仍通过标准 MCP 工具完成。

接入前提包括 Channel 的会话启用、允许列表/开发模式及 Anthropic 认证。首次接入既有历史可以使用 resume 启动并启用 Channel。工具审批还可采用其 permission relay，版本和组织策略需单独验收。

`op7418/Claude-to-IM-skill` 的 Claude 路径使用 Agent SDK `query()` 和 `resume: sdkSessionId`，属于 SDK 管理的恢复执行。对“当前活会话参与 IM”的目标，Channels 更值得优先验证。

## GitHub Copilot CLI

优先研究原生 Extension。CLI 运行一个伴随交互会话的 JavaScript 扩展，扩展通过 `@github/copilot-sdk/extension` 的 `joinSession()` 获取当前前台 session 的连接。

已从官方源码确认：`session.sessionId`、`session.send({prompt, mode: "enqueue"})`、事件订阅与 `session.abort()`。Extension 为实验功能，并有加载、管理和重载入口。

扩展可担任本工具的 LiveSessionConnector，公共 MCP 工具继续由 Broker 提供。中断请求与完整任务树停止分别设计和验收。

## 对当前设计的启发

- 保留平台无关的 owner、Session、route、wait 和 stop-report 模型。
- Agent 接入区分“消息/会话连接”与“完整执行生命周期管理”。
- 声明真实能力，再安排消息、观察与停止路径。
- 当前代码契约保留扩展点，首期 Runtime Adapter 专注 Codex。

## 调研依据与边界

| 来源 | 核对内容 |
| --- | --- |
| `https://code.claude.com/docs/en/channels` | Channel 启用、认证、会话与研究预览条件 |
| `https://code.claude.com/docs/en/channels-reference` | 通知格式、回复工具、排队与权限转发 |
| `https://docs.github.com/en/copilot/concepts/agents/copilot-cli/about-cli-extensions` | Extension 生命周期与实验开关 |
| `https://docs.github.com/en/copilot/tutorials/create-an-extension` | joinSession、加载与重载 |
| `https://github.com/github/copilot-sdk/blob/main/nodejs/src/extension.ts` | 当前前台 session 的连接方式 |
| `https://github.com/github/copilot-sdk/blob/main/nodejs/src/session.ts` | send、事件与 abort |
| `https://github.com/op7418/Claude-to-IM-skill/blob/main/src/llm-provider.ts` | SDK query/resume 的实际实现 |

调研时本机版本：Claude Code 2.1.226、Copilot CLI 1.0.88-2。已经完成文档、源码与版本核对；实时注入、原生审批和完整停止的端到端测试留待对应 Agent 的实施阶段。
