# 实施与验收计划

当前主路径：Skill → MCP 当前会话元数据 → Broker 队列中继 → 原 CLI 队列消费。

## 必须验收

1. 原 codex 命令及 PowerShell profile 保持原样。
2. register 在当前 CLI 中直接成功，前后 owner PID 和 thread 保持一致。
3. Broker 使用独立 App Server 入队，原 CLI 实际执行任务。
4. 主动发送和问答走当前 session 的 MCP。
5. IM 任务由 Agent 使用 job_id 明确发送最终结果。
6. 审批对象仅为 IM 使用者；撤销、到期与跨私聊路由正确。
7. 状态区分队列投递、结果完成和原生执行不可观测。
8. /stop 清理本地与原生队列/目标，对原宿主执行对象返回准确残留。
9. 当前 schema 创建与重开，其他格式明确报错。
10. 安装固定发布、备份、幂等和用户配置保持。

## 后续

完整原生执行控制、Chat new、其他 IM/Agent Adapter 单独实施。参考[架构](architecture.md)、[协议](protocol.md)和[平台接入](portal-and-access.md)。
