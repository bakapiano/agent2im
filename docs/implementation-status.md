# 实施状态

当前实现按队列中继接入：原 CLI 保持运行并持有执行权，MCP 直接注册，Broker 通过独立 App Server 投递原生队列。

产品审批仅针对 IM 使用者；本地渠道配置直接执行。消息、问题回复和 job_id 结果回传通过 MCP。数据库使用当前 schema 5。

Codex Plugin 源码位于 `plugins/codex/agent-to-im`。运行包内置 Node、Broker 与 Portal，首次调用自动登记本地客户端。平台代码按 `src/im/<provider>` 和 `src/code-cli/<provider>` 分组，通过独立注册表组合。飞书与 Codex 已实现；微信、QQ、Claude、GHCP 维护规划元数据和扩展入口。

状态展示宿主在线性及本项目工作记录，原生执行状态明确为 unobserved。停止会清理队列/持续目标和 Broker 工作，原宿主 turn/子任务/终端作为明确残留报告。

安装保持原 codex 命令和 PowerShell profile。版本与验证结果见[验收记录](acceptance.md)。
