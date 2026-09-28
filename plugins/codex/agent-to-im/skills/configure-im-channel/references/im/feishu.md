# 飞书渠道

Provider: `feishu`。以 `inspect.status=ready` 和实时 requirements 为准。

1. 引导用户打开飞书开发者后台，选择其自建应用，启用机器人能力。
2. 在权限配置中开通读取单聊消息、以机器人身份发送消息所需权限。
3. 事件接收方式选择长连接，订阅 `im.message.receive_v1`；确认应用发布状态、使用范围覆盖目标用户。
4. 在本地 Portal 录入 App ID 与 App Secret。App Secret 经本机 DPAPI 加密，取得 `credential_ref` 后由 MCP 保存渠道。
5. 依次验证、启用。验证检查凭据及机器人身份，连接健康在 Portal 核对。
6. 目标用户私聊机器人。管理员核对平台用户 ID、租户和渠道后，在 Portal 审批该 IM 使用者。
7. 返回当前 Codex 会话执行 connect-to-im，随后通过 IM `/sessions`、普通文本和 Agent MCP 回信验证双向通路。

凭据失败时核对应用及密钥；机器人检查失败时核对机器人启用及发布状态；收不到消息时核对长连接、事件订阅、权限和应用使用范围。只报告实际通过的检查。
