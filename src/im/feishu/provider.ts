export const feishu = {
  id: 'feishu',
  displayName: '飞书',
  requirements: [
    '飞书自建应用机器人',
    'App ID',
    'Portal 安全录入的 credential_ref',
    '长连接与 im.message.receive_v1',
    '读取单聊消息及机器人发送权限',
  ],
  guide: 'references/im/feishu.md',
} as const;
