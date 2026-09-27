# 本地 Portal、渠道配置与首次使用审批

设计版本：v0.2 · 2026-09-26。首期包含本地 Web 配置和审批、已有 Codex 会话接入、飞书私聊。Chat 新建会话及其托管生命周期保留为后续设计。

## 1. 两个入口，共用一套服务

| 入口 | 面向对象 | 能力 |
| --- | --- | --- |
| Local Web Portal | 本机管理员 | 渠道配置、密钥录入、连接测试、启停、首次审批、授权撤销、状态查看 |
| `configure_im_channel` MCP + `configure-im-channel` Skill | 经身份验证的 Agent 客户端 | 查询配置要求、提交配置、测试连接、启停已获授权的渠道、查询自己的审批状态 |

两个入口共用 ChannelConfigurationService、CredentialStore 和 AccessPolicy。审批决策通过独立的 Web Admin API 提交，MCP 使用受限的 agent-client 凭据。

Portal 默认地址为 `http://127.0.0.1:17643`，内部 Agent RPC 默认使用 `127.0.0.1:17642`。地址均为预定实现配置。

## 2. Portal 的三个简易页面

### 渠道

- 列出渠道名称、平台、App ID 摘要、启用状态、连接健康、最近错误和配置 revision。
- 飞书表单：别名、显示名称、App ID、App Secret 安全输入。
- 操作：保存、测试连接、启用、停用。
- 已保存的密钥以“已配置”展示；编辑凭据使用替换输入。
- 明确展示渠道应用身份与已授权用户数量；应用身份变化时展示重新审批的影响。

### 审批与授权

- 分开显示“IM 用户访问申请”和“Agent 客户端操作申请”。
- 详情包括验证后的身份、所属渠道、申请操作、资源范围、申请时间及必要的关联证据。
- 管理员选择 owner/workspace/session 范围，批准或拒绝；已批准条目可撤销。
- 配置申请显示具体字段差异和 revision，密钥仅显示引用与是否变化。
- 状态：`pending`、`approved`、`denied`、`expired`；授权另有 `active`、`revoked` 状态。

### 已连接会话

- 查看已注册 Codex 会话的标题、短 ID、原生 thread ID、owner、绑定用户、连接健康和运行状态。
- 查看首次审批结果、授权范围和近期审计。
- 新建会话入口在后续阶段提供；当前会话来源为用户已运行并注册的 Codex CLI。

## 3. 身份如何验证

### IM 用户

稳定身份由 `platform + channel_id + channel_identity_version + tenant_id + platform_user_id` 构成。私聊路由另行绑定真实 `chat_id`。

飞书的租户、发送者 open ID、chat ID 和消息 ID来自已认证的 SDK Gateway 事件。昵称、头像与正文中的声明用于展示。管理员审批时看到真实平台 ID及其渠道归属。

### Agent 客户端

稳定身份来自本地注册的 `client_id + installation_id + OS user identity`，由 ACL 保护的客户端凭据验证。本地客户端凭据用于证明申请者身份，操作权限由 Web Grant 决定。

当前 native thread 继续通过 runtime descriptor / App Server 验证。MCP transport ID、clientInfo 显示名和模型参数中的用户声明各自保留为诊断信息。

### Web 管理员

首期一个本机管理员账户。首次服务启动使用本机交互式 bootstrap 建立管理登录，后续使用管理员登录会话。Agent 的客户端凭据与 Web Admin 会话采用不同权限域和凭据用途。

MCP 返回审批编号和页面路径；管理员凭据、bootstrap secret、审批 Cookie 和 CSRF token 留在管理面。

## 4. IM 用户首次使用流程

1. 已启用渠道收到一个真实私聊事件，完成平台认证和去重。
2. AccessPolicy 查询该身份、渠道身份版本与资源范围的持久授权。
3. 首次未授权时创建或复用 `AccessRequest(pending)`，只保留审批所需身份和事件元数据。
4. 机器人发送一次限流的中性提示：“访问申请已提交，请管理员在运行本服务的电脑上批准”，附申请编号。
5. 管理员在 Portal 检查身份，选择 owner、可访问的会话/工作区及操作范围，并点击批准。
6. 事务写入 ApprovalDecision、AccessGrant 和 AuditEvent，生成用户可用的 connection alias。
7. 通知用户审批结果。首次被拦截的任务由用户重新发送；随后每次操作读取有效授权再执行。

审批前会话列表、历史、等待问题和任务操作保持隔离。预审批消息发送走专用、受限的 access-notice 路径，Agent 的 send 工具仍要求业务授权。

如需要配对码确认真人或关联本地 owner，配对码仅作为审批证据，最终 Grant 由 Web 决策产生。

## 5. Agent 首次配置渠道流程

1. Agent 调用 `configure_im_channel`，sidecar 附加验证过的 local client 身份。
2. `inspect` 可以返回公开的平台配置要求；现有渠道数据按授权范围返回。
3. 首次修改/测试/启停申请生成 pending approval，冻结操作摘要、目标渠道和配置 revision；返回 `APPROVAL_REQUIRED`。
4. Agent 将申请编号和 Portal 地址交给用户，暂停该配置动作。
5. 管理员在 Web 确认身份和允许的持续权限，持久化 Grant。
6. Agent 得到用户批准后的继续指示，先查询 `approval_status`，再用原幂等键重试原操作。

批准持久授权与执行配置是两个明确步骤。审批后的原操作仍要验证 revision、凭据引用、渠道身份和当前 Grant。相同幂等键对应同一载荷；变更后的载荷使用新请求。

成功配置一个渠道后，IM 侧的每位使用者仍执行自己的首次访问审批。Agent 的配置权限与远程用户的会话控制权限分别授权。

## 6. 持久授权的范围

建议 scopes：

| Scope | 用途 |
| --- | --- |
| `channel.read` | 查看授权渠道的脱敏配置与状态 |
| `channel.configure` | 保存指定渠道配置、测试和启停 |
| `session.register` | 将验证过的本地会话连接到授权路由 |
| `session.read` | 查询授权会话目录与状态 |
| `session.message` | 给授权会话提交任务或答复问题 |
| `session.stop` | 停止授权会话的归属工作树 |
| `message.send` | 通过授权路由向指定用户发送 Agent 消息 |

Grant 固定绑定主体、渠道 ID/身份版本、owner、scopes 和资源过滤器。默认直到管理员撤销；管理员可设置有效期。跨渠道或跨用户共享授权通过新的显式授权建立。

会话和消息权限的资源过滤器明确包含允许的 conversation ID；平台用户默认限定自己的已验证私聊。Agent 的配置权限可独立授予，注册和发送权限另行限定目标私聊与 owner。

同一主体重启后使用同一持久 Grant。新增 scope、扩大 owner/workspace 范围或改变应用身份时产生新的审批需求。

授权通过后，Codex 原生执行审批仍按用户自己的权限配置执行。`wait_for_user_message` 的普通文本回答作为任务输入证据处理。

## 7. 每次操作都重新校验

检查点包括：

- 每个 IM 命令、普通消息、引用回复和 session 查询。
- 每个 MCP 注册、发送、等待以及渠道配置操作。
- 持久队列实际派发到 Codex 前。
- Outbox 实际向平台发送前。
- Broker / Adapter 重连和恢复尚未完成的任务时。

任务和 Outbox 保存授权 ID/revision、渠道身份版本与目标范围。执行时读取当前策略，确保排队期间发生的撤销和范围变化立即生效。[S9]

撤销默认关闭该授权的后续通道能力，取消尚未派发的输入、未发送输出和该授权关联的等待。已运行的本地任务保留本地可控性；管理员可以另外选择停止相关 session，复用停止协调器。

## 8. 渠道配置、版本与凭据

`ChannelConfig` 与某个用户的 `Connection/SessionRoute` 分开：一个飞书应用可接收多位使用者，各自审批后建立独立私聊路由。

- 使用稳定 `channel_id` 和配置 `revision`。
- 使用独立 `identity_version` 表示 bot 应用/租户身份变化。
- `expected_revision` 处理 Web 与 MCP 同时修改的竞争。
- 凭据在 Portal 安全输入，存入 Windows Credential Manager 或经核验的本机加密存储。
- MCP 参数使用 `credential_ref`；服务校验引用所属 owner、用途和平台。
- 渠道数据、日志、MCP 返回和审批摘要展示脱敏值。
- 改变 App ID、租户或机器人身份时停用旧身份的授权，验证新身份并在 Web 重新批准相关权限。
- 同一应用的凭据轮换先验证身份连续性；验证失败保持停用/错误状态。
- “测试连接”检查凭据和平台 API 连通性；真实消息发送使用已获授权的消息路径。

Agent 配置入口接受列明的字段和安全凭据引用。平台 API 地址由 Adapter 固定选择，配置项保持在平台允许的域名和模式范围内。

## 9. MCP：`configure_im_channel`

首期增加一个工具，包含五类操作：

| operation | 输入重点 | 行为 |
| --- | --- | --- |
| `inspect` | provider，可选 channel_id | 返回配置要求或可见渠道的脱敏信息 |
| `upsert` | alias、display_name、app_id、credential_ref、expected_revision、幂等键 | 建立或更新配置草稿 |
| `validate` | channel_id、expected_revision、幂等键 | 验证当前配置与应用身份 |
| `set_enabled` | channel_id、enabled、expected_revision、幂等键 | 按验证结果和权限启停连接 |
| `approval_status` | approval_request_id | 查询当前申请者自己的审批结果 |

`upsert`、`validate` 和 `set_enabled` 属于不同动作，便于明确配置、网络验证和连接启用的边界。首次验证出的应用身份需要与审批时允许的 App ID/渠道范围一致。

平台用户访问审批、批准/拒绝和 Grant 撤销通过 Web Admin API 完成。

## 10. 本地管理面的安全边界

- 默认绑定回环地址，严格校验 Host 与 Origin；局域网/公网部署作为后续独立配置。
- 管理员登录 Cookie 使用 HttpOnly、SameSite=Strict；HTTPS 部署使用 Secure。
- 所有状态修改需要管理员会话和 CSRF 校验；GET 请求保持查询语义。[S10]
- Agent RPC 的凭据 audience 限定为 agent-client，Web 决策接口要求独立管理员认证。
- 首次 bootstrap secret 单次、短时，由本机交互式流程交给管理员；MCP 响应返回普通审批地址。
- 页面将用户昵称、消息摘要和 Agent 提案按文本渲染。
- 审批提交再次校验 request revision、主体身份与渠道版本，事务写入决定和授权。
- 请求创建、重复通知、失败验证和登录操作均有速率限制。

同一 OS 用户拥有主机完全文件权限时，属于本机管理员信任边界。需要更强的进程对抗隔离时，使用独立服务账户、数据库/密钥 ACL 和带用户在场校验的管理员认证；首期的 Web 审批保证应用接口层的明确授权流程。

## 11. 建议数据表

| 表 | 关键内容 |
| --- | --- |
| channel_configs | provider、alias、App ID、credential_ref、revision、identity_version、state |
| credential_refs | owner、平台用途、密钥后端引用；密钥值留在凭据后端 |
| agent_clients | 安装/OS 身份、凭据哈希/引用、激活与撤销状态 |
| access_requests | subject、渠道与范围、提案摘要、revision、pending/终态、到期时间 |
| approval_decisions | request、管理员、决定、时间、批准时的精确范围 |
| access_grants | subject、channel、identity_version、owner、scopes、资源过滤器、revision、撤销/到期 |
| admin_sessions | 管理员登录状态、CSRF 与有效期 |
| audit_events | 配置、测试、启停、审批、拒绝、撤销及执行时策略判断 |

申请按 subject + channel + requested scope 去重；授权按精确主体和资源边界匹配，审批历史保留。

## 12. 首期验收重点

1. 未批准 IM 用户首次发消息，产生一次申请和有限提示。
2. Web 批准后可用；Broker 重启后授权仍有效。
3. 同名用户、不同 bot 应用和不同租户保持身份隔离。
4. Agent 首次配置需 Web 审批；审批后按范围执行并记录。
5. MCP 参数中的 approved、role、owner 或原始 secret 字段被 schema 拒绝。
6. Agent 凭据调用管理员审批接口时验证失败。
7. 撤销发生在任务/Outbox 排队期间，派发时立即受新策略约束。
8. 渠道身份变化后旧 Grant 失效，新身份重新审批。
9. 配对或审批通过后，首次被拦截任务由用户重新提交。
10. Portal 跨站修改请求、过期 CSRF、旧 revision 审批被拒绝。
11. 密钥出现在正常页面/MCP/日志返回中的扫描测试保持通过。
12. 新注册的 Codex session 只能关联到当前 owner 已授权的路由。

文档与 schema 校验用于设计阶段。真实浏览器、平台身份、持久化和授权执行测试在首期实现中完成。
