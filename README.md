# agent-to-IM

让正在运行的 Codex 会话拥有 IM 联系入口。用户在当前对话调用 `$connect-to-im`；Broker 通过独立 App Server 投递原生队列，原 CLI 继续持有执行权。

## 当前能力

- Codex CLI + 飞书私聊；IM/Agent Adapter 接口为后续扩展保留。
- 当前会话直接注册、列出/切换 session、提交任务。
- Agent 主动发送、提问并在原工具调用中接收回答。
- IM 任务携带 job_id，结果由 Agent 通过 MCP 明确回传。
- Web 只审批谁可以从 IM 与 Agent 互动。
- 已认证本地 MCP 可直接配置渠道，密钥经 DPAPI 保存。
- 原 codex 命令、PowerShell profile、模型权限和历史保持原样。

状态展示宿主在线性及 Broker 的队列/等待/结果记录。/stop 清理 Broker 工作、原生待处理队列和持续目标；原宿主的运行中 turn、子任务与终端控制以明确残留报告展示。

## 使用

安装 MCP 与两份 Skill 后，在当前 Codex 对话调用：

```text
$connect-to-im
```

飞书使用者通过 Web 审核后，可以发送：

```text
/sessions
/switch s_12345678
/status
帮我检查项目并回传结果
/reply q_12345678 继续
/stop
```

原 CLI 保持打开以消费原生队列。接入只使用当前格式；新库初始化为 schema 4，其他数据格式直接报错。

## 文档

- [本地安装与使用](docs/quickstart.md)
- [架构](docs/architecture.md)
- [协议](docs/protocol.md)
- [Portal 与 IM 使用者审批](docs/portal-and-access.md)
- [实施计划](docs/implementation-plan.md)
- [验收](docs/acceptance.md)
- [当前状态](docs/implementation-status.md)
- [后续生命周期](docs/session-lifecycle.md)
- [后续 Agent 调研](docs/research/agent-host-integration.md)
- [依据](docs/references.md)
- [MCP 配置示例](examples/codex-mcp.example.toml)
- [领域契约](spec/contracts.ts)

CLI 命令：serve、enroll、mcp、install-local、rollback-local、doctor、version。验证：`pwsh -NoProfile -File ./scripts/project.ps1 check`。
