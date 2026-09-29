# 平台目录与扩展格式

当前实现组合为飞书 × Codex CLI。目录按两个独立扩展轴组织：

```text
src/
  im/
    port.ts                 # 平台认证事件、连接、发送回执
    catalog.ts              # 平台标识与配置指引
    registry.ts             # 根据 Channel.provider 选择适配器
    feishu/                 # adapter、provider、channel-fields
    wechat/                 # provider 元数据，规划中
    qq/                     # provider 元数据，规划中
  code-cli/
    port.ts                 # 原生身份、运行连接、投递、停止报告
    catalog.ts
    registry.ts             # 根据 RuntimeLink.provider 选择适配器
    codex/                  # discovery、runtime、install、provider
    claude/                 # provider 元数据，调研中
    ghcp/                   # provider 元数据，调研中
  channels/                 # 平台无关的配置生命周期
  access/                   # IM 使用者审批
  local/                    # 数据目录、凭据初始化
  broker.ts                 # 公共消息与会话协调
plugins/
  codex/agent-to-im/
    .codex-plugin/plugin.json
    .mcp.json
    scripts/
    skills/
      connect-to-im/
      configure-im-channel/references/im/
```

## 命名和代码格式

- 平台 ID 与目录同名，采用小写：`feishu`、`wechat`、`qq`；`codex`、`claude`、`ghcp`。
- `provider.ts` 保存无副作用元数据，适合 Portal 和服务共用。网络 SDK 只在对应平台目录加载。
- `port.ts` 定义业务所需能力；`registry.ts` 负责选择与能力可用性。Broker 使用两个注册表。
- `provider` 是必填持久化字段。原生会话唯一键为 `(provider, homeId, threadId)`；不同平台可以使用相同原生 ID。
- 格式由 `.editorconfig` 与 `.prettierrc.json` 固定：2 空格、100 列目标宽度、LF。执行 `pnpm format` 或 `pnpm format:check`。文件名采用 kebab-case，类型和类使用 PascalCase。
- `eslint.config.mjs` 检查控制语句大括号、每行一条语句、独立变量声明、未使用变量、类型导入及 Hook 依赖。`pnpm lint` 使用零警告门槛，`pnpm check` 同时执行 lint 和 format 检查。
- 通用行为测在公共测试；平台协议测试归入对应平台目录；插件发布验收覆盖真实 CLI 安装和仓库外运行。

## 新增 IM 平台

1. 在 `src/im/<id>/` 声明 provider 元数据、配置字段和指引。
2. 在该目录实现 `ImFactory` 与 `ImConnection`：验证机器人身份、建立认证连接、规范化平台稳定身份、处理发送回执。
3. 为该平台定义专属配置 schema 与 Portal 字段；当前 `upsert` 的 App ID 约定来自飞书。
4. 将工厂加入 CLI 的 `ImRegistry` 组合入口，状态随工厂注册变为 `ready`。
5. Skill 的 `inspect(provider)` 返回该平台要求与对应 `references/im/<id>.md`。
6. 测试身份隔离、重复消息、引用回复、凭据用途、机器人身份变更、未知回执和撤销后的派发边界。

待接入平台保留 provider 元数据和指引。它们可通过 `inspect` 查询规划状态；配置写入以已实现的平台 schema 为准。

## 新增 Code CLI

1. 在 `src/code-cli/<id>/` 定义宿主上下文发现、身份验证和 `RuntimeFactory`。
2. 实现 `LiveRuntime` 的连接、状态、排队、取消、停止报告和关闭。注册表依据 provider 调度。
3. 平台自己的插件或 MCP 启动入口向公共 MCP 注入 `discoverContext`，由宿主提供原生身份。
4. 验证原执行宿主与原生历史持续保留、任务结果携带 job_id、状态与停止残留准确。
5. 配置格式及接入说明放进 `plugins/<id>/` 的发行包中。

Claude Code 与 GitHub Copilot CLI 的调研继续维护在[宿主接入调研](research/agent-host-integration.md)。Chat new 的生命周期继续作为[后续能力](session-lifecycle.md)。

## 共同边界

审批只面向 IM 使用者。渠道、私聊、原生会话各自持有稳定标识；已认证本地 MCP 负责技术身份核验与配置。平台扩展复用现有 Broker、epoch、Inbox/Outbox、问答关联和审批持久化。
