# 本地 Portal、渠道配置与 IM 使用者审批

更新：2026-09-28。产品审批对象是通过 IM 与 Agent 互动的人。

## 入口与责任

| 入口 | 能力 |
| --- | --- |
| Web Portal | 配置渠道、录入凭据、验证/启停、审核 IM 使用者、查看会话与审计 |
| configure_im_channel MCP / Skill | 经本地客户端认证后查询、保存、验证和启停渠道 |
| connect-to-im MCP / Skill | 自动核验当前原生会话，登记并绑定已批准的 IM 收件人 |

Portal 使用管理员登录 Cookie 与 CSRF。MCP 使用独立的本地客户端凭据，凭据与运行上下文由 sidecar 注入。本地注册过程核验真实调用来自哪个 thread，以确保消息交给正确的人和会话。

## 审核谁可以互动

稳定身份由平台、渠道、渠道身份版本、租户和平台 user ID 构成。私聊另行绑定真实 chat ID。昵称用于显示；平台认证事件中的 ID 是审批依据。

1. 用户首次私聊机器人，服务保存身份审批元数据并发送一次中性提示。
2. 管理员在“IM 访问审批”核对使用者身份、租户、渠道和私聊。
3. 点击“允许此用户互动”或“拒绝”。
4. 批准结果持久化为该 IM 身份及私聊的有效 Grant。用户重新发送操作。
5. 已批准使用者可以列出和切换自己的已连接会话、发送任务、回答问题及停止任务。
6. 撤销或到期后，入站操作、待发消息和任务派发重新核验使用者资格。正在派发的任务按停止/未知状态规则处理。

使用者之间以平台身份和私聊路由隔离。会话来源、工作目录及原生 session 数量由注册和路由流程处理。原生执行审批、sandbox 和历史继续由 Codex 管理。

## 数据模型

- AccessRequest：使用者 subject、显示名、channelId、identityVersion、conversationId、状态、revision、申请时间、期限。
- Grant：使用者 subject、channelId、identityVersion、conversationId、批准/撤销状态、revision、批准时间、可选到期时间。
- AuthStamp：收件人 subject、channelId、identityVersion、conversationId；在每次实际派发时读取当前 Grant。
- Native binding：本地 clientId、home、threadId、cwd、运行端和实例身份；用于真实调用归属。

审批 API 只接收申请 ID 和 revision。批准、拒绝、撤销均通过 Web 管理端完成。MCP 工具不携带审批决定。

## 配置渠道

Web 和已认证的本地 MCP 使用同一个 ChannelService，配置动作直接执行。操作包括 inspect、upsert、validate、set_enabled。expected_revision 保护并发编辑，幂等键保护重试。

App Secret 通过 Portal 写入 Windows DPAPI 凭据后端。MCP 只接收 credential_ref。更换 App ID 或机器人身份后，原 IM 使用者审批失效，新身份重新经过 Web 审核。

## 管理界面

- 渠道与连接：配置、凭据引用、连接健康和已发现私聊。
- IM 访问审批：使用者申请，以及已审核使用者的撤销操作。
- 会话：标题、原生 thread、cwd、运行状态和详情。
- 审计：身份审批、配置修改、注册、投递及停止记录。

默认 Portal 为 `http://127.0.0.1:17643`，本地 RPC 为 `http://127.0.0.1:17642`。启动与安装见[接入指南](quickstart.md)。

## 持久化

数据库使用当前 schema 5。空库初始化，已有库须满足当前格式。IM 身份决定和原生队列映射分别保存。原生历史由 Codex 保管。
