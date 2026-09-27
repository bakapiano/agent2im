# 验收记录

日期：2026-09-26。范围：v0.2 已有 Codex session + 飞书私聊 + Web 审批 + 四个 MCP 工具。

最终本地回归：`pnpm check` 成功，9 个测试文件 / 80 个自动化用例通过，1 个 Chromium 完整流程通过；设计检查 40 个输入用例、39 个文档链接通过，两份 Skill 校验通过。构建保留一条约 1 MB Web bundle 的体积提示，后续可按页面拆包。

## 本地已验证

- TypeScript 类型检查、Vite Web 构建、Node CLI 构建。
- 40 个公开工具输入正反例。
- Broker：首次身份审批、重复消息、A/B 会话切换、显式问题路由、wait/resume、TTL/重复问询、结果补发和幂等。
- 停止立即递增 epoch；在途派发回执与停止竞争；旧 turn 调用拒绝；原生已接受任务在撤权后停止。
- SQLite 重开：Grant、选择、已回答问题保持，发送中记录转为 unknown。
- Web API：Host/Origin、管理员登录、CSRF、独立 Agent/管理/安装身份、凭据脱敏、审批与撤销。
- Windows DPAPI 真实加解密。
- MCP 官方 Client + 本项目构建后的 stdio sidecar：四个工具真实传输、RPC 认证、问答和参数拒绝。
- Chromium：初始设置、审批、凭据引用、渠道保存/验证/启用、撤销、退出和重新登录，检查浏览器异常。
- Codex CLI 0.154.0：真实 App Server + 本项目 MCP + Broker + 隔离 IM 完整接线。实际 MCP 注册先返回 Web 待审批，测试夹具批准后成功；主动发送、等待回复、IM 排队任务、最终结果回传。
- 原生已有 thread 附着、MCP thread/turn 归属证明、忙碌原生队列清理、turn 中断、goal 清除、历史读取与同 ID resume。

完整命令与结果由 `pnpm check` 重现。浏览器成功截图：`.test-data/portal-channels.png`。测试中的“飞书”使用假 Adapter，真实网络部分限定为本机 App Server、HTTP 模型模拟服务和测试进程。

## 实测发现及实现决策

1. 新 thread 在首次持久化 turn 前可能返回 `no rollout found`；接入指引要求先完成原生首轮持久化。
2. 原生 `thread/queue/add` 在空闲时自动消费；测试对忙碌队列做删除/停止验证。
3. MCP 原生 approval 和本项目 Web Grant 是两套独立权限。自动验收仅在隔离 Codex 中给本项目四个工具测试信任。
4. thread/turn/queue 等实验接口按本机 schema 核对。未知/失败的停止步骤产生残留，派发闸门保持关闭。
5. 数据物理层使用 Drizzle typed `records` JSON 行、事务性 `unique_claims` 和独立审计表，schema version 2。`records.sequence` 固定接受顺序，更新记录保留序号；v1 升级在事务中按原始插入顺序回填。概念实体见 `spec/contracts.ts`，实际持久化类型见 `src/core/model.ts`。

### 继续验收发现并修复的边界

- 重启与原生断线保持 `stopped` / `stop_incomplete` 的派发关闭状态。重启遇到 `stopping` 时转为 `stop_incomplete` 并记录停止未核对的残留，等待用户重试 `/stop`。
- MCP 调用在进入时绑定 session epoch，在异步身份核对后再次比较。停止前发起的迟到调用在新的任务世代仍被拒绝。
- IM 回调同时核对连接实例、渠道身份版本和 App ID；被替换连接的迟到事件保持原有信任边界。
- 上述缺口通过 8 个先失败后通过的用例复现和回归。原生模拟 HTTP 服务同时覆盖 turn 中断造成的请求体取消，最终全量运行无未处理异常。

### 消息生命周期与顺序补充验收

- 已过期或已回答的问题，其待发 Outbox 会被取消。每条消息派发前再次检查问题与授权有效性，涵盖前一条平台调用长时间阻塞的情况。
- `/sessions`、`/status`、切换/任务/回复/停止回执保存其涉及的会话资源范围。Web 缩小会话访问范围后，尚未发出的旧回执再次校验资源。升级时，缺少资源范围的历史待发控制回执取消，用户可重新查询。
- 接受顺序以持久化序号为准，任务 UUID 的字典序保持独立。数据库升级、记录更新、VACUUM 和重新打开均有顺序回归测试；较新 schema 的数据库会拒绝由旧程序降级。
- MCP 传输取消保留仍有效的问题，之后可以读取持久回答。状态查询结合原生状态和当前开放问题，保持停止 fence。
- 子任务树协议夹具覆盖多页 inventory、多层后代、原生队列、goal、后台 terminal 清理、无关会话隔离、清理失败及停止期间新增后代。此项证明 Adapter 的协议控制行为；系统进程终止效果和平台真实投递另行验收。

## 待真实飞书人工验收

需要用户在 Web 输入自建应用凭据，并完成飞书发布、权限和长连接配置。审批由用户本人操作。

Goal 状态：blocked，等待用户完成真实平台配置及审批。该依赖已在连续三轮目标推进中保留；本地自动化与可隔离的原生接线已验证。当前没有运行中的生产 Broker 或已提供的真实渠道配置。用户完成配置后，恢复目标并执行以下人工联调清单。

1. 启用应用后检查 Portal 长连接为 connected。
2. 首次私聊机器人产生唯一 pending；核对租户/open ID 后 Web 批准。
3. 真实已有 Codex session 调用 register，用户批准 Agent 权限。
4. 私聊 `/sessions`、`/switch`、`/status`；发送任务并观察原生执行和私聊最终答复。
5. Agent 主动消息；提问等待；引用问题与 `/reply` 返回原 session。
6. 另一个用户或租户产生独立申请；授权范围互相隔离。
7. `/stop` 清理真实工作树与后台终端；核对残留报告。
8. 重启 Broker，确认同一用户授权和原生历史保持；Web 撤销后再次验证派发生效。

真实飞书平台投递、断网重连、配额和平台幂等窗口均以这轮联调结果为准。真实子 Agent/终端负载压力验收也在此阶段核对。

## 运行边界与后续工作

- 程序为 Windows 本地单用户服务，默认回环端口。飞书 App Secret 和客户端文件经 DPAPI 加密。
- SQLite 保存获批后的消息与工作内容；采用 OS ACL 保护，备份应按同级敏感数据处理。
- 停止范围为可枚举的 tracked resources，外部平台作业需要扩展取消 Adapter。
- 原生消息历史由 Codex 保管；Chat new、托管 runtime、Claude/Copilot、更多 IM 和群聊留到后续阶段。
- 当前凭据 UI 聚焦飞书；高级 Codex token 凭据可经经过认证的 Web API 保存。
- 当前规模采用单机轮询 worker 与 typed JSON 持久化；索引、迁移升级、保留期限和高吞吐扩展可在后续阶段推进。
