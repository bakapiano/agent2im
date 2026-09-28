# Codex Plugin

源码入口为 `plugins/codex/agent-to-im`，manifest 声明两份 Skill 和四个 MCP 工具。首个运行包面向 Windows x64。

## 构建

```powershell
pwsh -NoProfile -File ./scripts/project.ps1 package:plugin
```

产物位于 `dist/plugins/<buildId>/agent-to-im/`：包含 Node 24、CLI/Broker、Web Portal、按锁文件安装的运行依赖、Skill 和插件元数据。构建器复制真实依赖目录，产物可整体搬移。`build.json` 记录版本、Node 平台、构建 ID 与 CLI 校验值。

Codex 将相对 `cwd` 解析到插件根目录。MCP 启动 `scripts/mcp.ps1`，脚本通过自己的目录定位内置 Node 和 CLI。原生 codex 命令与 PowerShell profile 保持原样。

## 本地安装

使用 Codex 的 plugin-creator 将产物登记到个人 marketplace，插件源放在 `~/plugins/agent-to-im`。然后执行：

```powershell
codex plugin add agent-to-im@personal
codex plugin list
```

开发更新使用 plugin-creator 的 cachebuster/reinstall 流程。安装后的独立验收线程读取新 Skill 和 MCP。已打开会话保留它启动时加载的工具，接入动作在调用该工具的当前会话中完成。

本地从独立 MCP/Skill 安装切换到插件时，先备份本项目的注册和两份 Skill，再仅撤下这三项重复入口。其他原生配置、权限、插件及历史保持原样。

## 首次调用与数据

1. MCP initialize/listTools 只加载工具定义。
2. 首次工具调用在 `%LOCALAPPDATA%/agent-to-im` 初始化本地服务配置、DPAPI 安装身份和客户端凭据。
3. Broker 按需启动；多个 sidecar 并发初始化共用一个客户端身份。
4. `$configure-im-channel` 查询平台状态及配置指引。Agent 可运行插件 `scripts/portal.ps1`，打开本地浏览器并自动带入首次设置令牌。
5. 用户设置管理员密码，录入机器人凭据，验证与启用；Web 审核目标 IM 使用者。
6. `$connect-to-im` 将当前原生会话注册到获批私聊。

初始令牌只通过本地 URL fragment 传给 Portal，页面载入后清理 fragment。App Secret 留在 Portal 和 DPAPI 凭据库；MCP 使用 credential_ref。

测试和显式定制数据位置使用 `AGENT_TO_IM_DATA_DIR`。常规使用采用默认数据目录。插件缓存只保存程序资源；渠道配置、审批和消息记录留在独立用户数据目录。运行 Broker 与插件版本需一致，版本冲突返回明确诊断。

当前 schema 为 5；原生身份和渠道均含 provider 字段。运行代码读取当前结构，格式不同的数据库在启动时返回错误。

## 验收

- 插件 manifest、两份 Skill 校验。
- 仓库外产物运行，核对零外部目录链接、SQLite addon 加载、MCP 冷启动和 Portal 页面。
- 原生 CLI 安装插件，在隔离 home 内注册当前 thread，发送、问答、任务结果回传和停止报告。
- IM 使用者审批、session 任意工作目录接入、原生 owner PID 与历史保留回归。

详见[架构](architecture.md)、[平台扩展约定](extensions.md)和[验收记录](acceptance.md)。
