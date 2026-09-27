# 实施与验收计划

设计版本 v0.2。首期目标：已有 Codex 会话 + 飞书私聊 + 本地 Portal + Web 首次审批持久化。

## 首期范围

- Session 由当前运行的 Codex CLI 经 MCP 注册。
- 私聊提供会话列表、切换、状态、输入、问题回复和停止。
- 本地 Portal 提供渠道配置、凭据录入、测试连接、启停、访问审批和授权撤销。
- MCP 提供注册、发送、等待与 `configure_im_channel`。
- Skills 为 `connect-to-im` 和 `configure-im-channel`。
- IM 用户和 Agent 客户端首次操作分别通过 Web 审批，后续按持久 Grant 校验。

Chat new、受管 runtime、release 交接、Claude Channels 和 Copilot Extension 进入后续阶段。

## P0：验证接入与授权边界

1. **当前会话身份**：在本机 Codex 0.154.0 上验证 MCP sidecar、本地客户端、runtime descriptor 与真实 thread 的归属。
2. **现有会话控制**：验证消息入队、状态事件、等待回复与归属任务停止，保持原生终端会话及其他实例的边界。
3. **身份与 Grant**：验证飞书原始身份、Agent 客户端凭据、首次 pending、Web 审批、持久化与重启恢复。
4. **Portal 边界**：验证管理员登录、不同凭据权限域、Origin/Host、CSRF 和审批 revision；Agent RPC 凭据只能进入它的权限域。
5. **配置与凭据**：验证安全 credential_ref、配置版本竞争、平台身份连续性、首次启用和授权变化。

P0 通过标准：已有会话可注册、消息可正确往返，首用审批和持久授权真实生效；停止报告准确表达已处理与残留资源。

## P1：首期可用闭环

- Broker、SQLite migrations、渠道配置、Inbox/Outbox、AccessRequest/Grant 和审计。
- 本地 Web Portal 的渠道、审批授权、已连接会话三个页面。
- 飞书真实私聊事件接收和发送，完成最小权限与身份验证。
- `/sessions`、`/switch`、`/status`、`/send`、`/reply`、`/stop` 和普通消息。
- 四个 MCP 工具与两份 Skill。
- IM 任务最终答复补发与显式发送去重。
- 审批结果和 Grant 持久化；拒绝、过期、撤销和渠道身份变更生效。
- 配置示例转为实际 CLI/服务入口，依赖版本锁定。

## P2：首期加固

- Broker/MCP/平台断连恢复和未知投递状态核对。
- 实际派发时的 Grant 检查，覆盖撤销与队列/Outbox 的竞争。
- Secret 扫描、速率限制、日志保留、备份与凭据轮换。
- 审批页旧 revision、重放、XSS/CSRF 与错误身份测试。
- 原生待审批状态在 IM/Portal 可见；原生执行权限继续遵循 Codex 配置。

## 后续阶段

- Chat `/new`、持久 thread 创建、独立受管进程和原生 resume/release 往返，沿用[生命周期设计](session-lifecycle.md)。
- 第二个 IM Adapter，复用核心授权、路由、等待和取消逻辑。
- 群聊会话边界、多人可见性与发言策略。
- Claude Channels、Copilot Extension，沿用[调研记录](research/agent-host-integration.md)。
- 原生工具审批的 IM 远程批准流程，作为与渠道首次访问审批独立的功能。

## 首期验收矩阵

| 场景 | 预期结果 |
| --- | --- |
| 未授权飞书用户首次发送消息 | 一个 pending 申请和限流的中性提示 |
| Web 批准该用户 | 持久 Grant 生效，用户重新发送操作 |
| 重启后同一用户再次访问 | 复用当前有效 Grant |
| 同昵称、不同 open ID/渠道/租户 | 分别验证和授权 |
| Agent 首次配置渠道 | pending，Web 批准后才执行配置 |
| Agent 请求审批自己的授权 | 仅能查询本人申请；审批走 Web Admin |
| Grant 撤销发生在队列等待期间 | 实际派发按最新策略拒绝 |
| Grant 撤销发生在 Outbox 等待期间 | 待发送数据受新策略约束 |
| App ID/机器人身份改变 | 旧身份 Grant 失效，新身份重新审批 |
| Web 与 MCP 同时改同一渠道 | expected_revision 检测冲突 |
| 原始 secret 或伪造身份进入 MCP 参数 | schema 拒绝 |
| Agent RPC 凭据访问 Web 决策接口 | 权限域校验失败 |
| Web 跨站/旧 CSRF 提交批准 | 请求被拒绝 |
| 旧审批页批准已变更的提案 | revision 校验失败 |
| 重复注册相同 native thread | 同一 IM Session，选择按幂等结果处理 |
| Agent 声明其他 thread | 身份核对失败 |
| 注册两个既有会话 A/B 后切换 | 历史、任务、等待和消息来源保持分离 |
| A 消息已入站后切换 B | 按固化目标交给 A |
| A 等待期间切到 B，再引用 A 问题回答 | 返回 A 的原 MCP 调用 |
| 一条用户回复重复投递 | 单次认领 |
| wait 超时后 resume | 同一问题与原始期限 |
| MCP 中断后用户回复 | Broker 保存，重连后按授权取回 |
| wait 阻塞时 stop | 控制面及时响应 |
| 停止遇到可归属的队列、goal、子 Agent、terminal | 分项取消并验证 |
| 仍有无法确认的任务资源 | stop_incomplete，展示残留 |
| 宿主已退出后收到任务 | offline 和原生恢复/注册指引 |
| 两个用户访问对方 session | 按 owner/route/resource 范围拒绝 |
| 显式 result 与自动最终结果补发竞争 | 使用同一最终结果投递键 |
| 平台已发送但回执丢失 | unknown，核对后再继续 |
| Broker 重启 | 先恢复授权，再核对会话与消息状态 |

## 已确定的产品取舍

| 决策 | 当前方案 |
| --- | --- |
| 首期会话来源 | 用户已有 Codex CLI，会话通过 MCP 注册 |
| 渠道配置入口 | Web Portal 与 configure_im_channel 共用配置服务 |
| 首次使用 | Web 管理员批准后持久化精确范围 Grant |
| 授权主体 | Agent 客户端与 IM 用户分别验证 |
| 后续请求 | 每次校验，并在任务/出站实际派发时复核 |
| 凭据处理 | Web 安全输入，MCP 使用受限引用 |
| 托管 new | 后续阶段 |
| 初期 IM | 飞书私聊文本 |
| 原生 resume | 用户按原生流程恢复，再注册当前活实例 |

## 建议代码布局

```text
src/
  broker/          SessionRegistry、Router、Wait、Outbox、Stop
  access/          身份验证、AccessRequest、Grant、策略与审计
  channels/        ChannelConfigurationService、校验和生命周期
  credentials/     Windows 凭据后端与受限引用
  portal/          管理员登录、配置、审批、授权、会话视图
  mcp/             四个工具与 sidecar
  adapters/im/     Feishu
  adapters/agent/  现有 Codex App Server 附着与控制
  persistence/     SQLite migrations 和 repositories
  cli/             daemon、portal bootstrap、attach、doctor
tests/
  contracts/       工具输入和 Adapter 契约
  policy/          身份、范围、撤销、审批 revision
  integration/     Broker + 假 IM + 真实 Codex
  portal/          浏览器登录、审批与配置流程
  e2e/             经用户授权的飞书私聊
```

服务、Web、MCP 与 Skills 已实现。实际布局采用 `src/broker.ts`、`src/server.ts`、`src/cli.ts`、`src/mcp.ts` 及领域目录。执行结果和剩余平台联调见 [验收记录](acceptance.md)。
