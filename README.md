# agent-to-IM

让已有的 Codex 会话拥有一个 IM 联系入口：用户从私聊管理多个 session，Agent 在原会话里通过 MCP 注册、主动发消息，并等待用户回复。

状态：v0.2 已实现并完成本地自动化、浏览器与真实 Codex 协议接线验收，2026-09-26。真实飞书联调等待用户凭据、平台配置与人工审批。

开始使用：[运行与接入](docs/quickstart.md)。验证范围：[验收记录](docs/acceptance.md)。

## 首期范围

- Agent：Codex CLI。
- IM：飞书应用机器人，私聊、文本消息。
- 会话来源：用户已有并通过 MCP 注册的 Codex CLI 会话。
- 用户操作：切换 session、列出 session、查询状态、给指定或当前 session 发消息、停止当前 session 的工作。
- 本地 Web Portal：简易配置渠道、测试连接、启停、首次使用审批和持久授权管理。
- Agent 工具：`register`、`send_message_to_user`、`wait_for_user_message`、`configure_im_channel`。
- Skills：`connect-to-im`、`configure-im-channel`。
- 扩展点：IM Adapter 和 Agent Runtime Adapter。后续 IM 通过同一套私聊、身份、收发、回复关联契约接入。

Chat `/new`、受管新实例和相关生命周期作为后续阶段。Claude Code Channels 与 Copilot CLI Extension 继续保留为后续调研。

## 实现架构

一个本地常驻 Broker 统一管理身份、session、消息路由、等待请求、任务取消和持久化。Web Portal 与 MCP 共用渠道配置及授权服务；Web 管理员完成审批，持久 Grant 在每次操作时重新校验。

飞书连接归 Broker 所有；已有 Codex CLI 会话通过可验证的 App Server 接入。MCP sidecar 的客户端身份与真实原生 thread 分别核对。

原生历史和运行宿主继续由用户的 Codex 管理。本阶段专注已有会话的连接与控制，保持原生 resume 工作流。

## 文档导航

| 文件 | 内容 |
| --- | --- |
| [架构](docs/architecture.md) | 组件关系、身份模型、注册、路由、等待、停止、恢复与扩展 |
| [协议](docs/protocol.md) | 私聊命令、四个 MCP 工具、错误与示例 |
| [Portal 与审批](docs/portal-and-access.md) | 渠道配置、身份验证、首次审批、持久授权和安全边界 |
| [后续 Session 生命周期](docs/session-lifecycle.md) | 后置的 new、托管实例、释放和 resume 设计 |
| [后续 Agent 调研](docs/research/agent-host-integration.md) | Claude Channels、Copilot Extension，后续接入储备 |
| [实施计划](docs/implementation-plan.md) | 技术验证、交付阶段、验收场景和待确认决策 |
| [依据与兼容性](docs/references.md) | 官方依据、本机 Codex 0.154.0 的 schema 检查及验证边界 |
| [类型契约](spec/contracts.ts) | 平台无关的领域对象和 Adapter 接口 |
| [首期范围](spec/scope.json) | 当前 Agent、IM、工具、Skills 与后置功能清单 |
| [MCP 工具定义](spec/mcp-tools.json) | 四个工具的机器可读输入 schema |
| [connect-to-im Skill](skills/connect-to-im/SKILL.md) | 引导 Agent 注册当前会话、发送和等待回复 |
| [configure-im-channel Skill](skills/configure-im-channel/SKILL.md) | Agent 辅助配置渠道，并引导 Web 首次审批 |
| [应用配置示例](examples/agent-to-im.example.toml) | 飞书账户、工作目录、等待和运行策略 |
| [Codex MCP 示例](examples/codex-mcp.example.toml) | MCP stdio 接入及等待超时预算 |

## 首期交互

私聊窗口可以依次发送：

```text
/sessions
/switch s_7af2
/status
请检查当前项目的登录流程
/send s_91bd 帮我核对测试结果
/stop
```

第一次使用先产生访问申请，管理员在本地 Web 批准后用户重新发送操作。会话目录包含授权范围内已经注册的会话；切换只改变私聊当前指向。

Agent 使用 `$connect-to-im`，调用本项目 MCP 的 `register`。后续调用中的 `session_id` 使用服务返回的稳定 ID。工具会把消息路由到这个 session 已授权绑定的私聊。

## 已确定的决策

1. 首期连接已有 Codex 会话，Chat new 及托管创建在后续阶段实现。
2. 一个私聊窗口选择一个当前 session，同时保留多个 session；后台输出始终标注来源。
3. 首次使用必须经过本地 Web 管理员批准；Agent 配置权限和 IM 用户控制权限分别授权并持久化。
4. Agent 主动发送为主；IM 发起的任务可由 Broker 补发尚未发送的最终结果，按原生 turn 去重。
5. “停止所有工作”的验收范围是该 session 归属的任务树、队列、等待请求和受管本地进程。外部服务上的作业通过登记过的取消句柄逐项报告。
6. Web Portal 管理配置、凭据与授权；Agent 经 MCP 提交配置操作，并由 `configure-im-channel` Skill 引导审批。

## 检查设计契约

已安装 PowerShell 7、TypeScript 和 Python 的环境可以运行：

```powershell
pwsh -NoProfile -File ./scripts/check-design.ps1
python -X utf8 C:/Users/Administrator/.codex/skills/.system/skill-creator/scripts/quick_validate.py ./skills/connect-to-im
python -X utf8 C:/Users/Administrator/.codex/skills/.system/skill-creator/scripts/quick_validate.py ./skills/configure-im-channel
```

可执行入口为 `dist/cli.js`，包含 `serve`、`enroll`、`attach`、`mcp`、`doctor`。运行参数以[接入指南](docs/quickstart.md)为准；`examples/agent-to-im.example.toml` 保留为概念配置参考。
