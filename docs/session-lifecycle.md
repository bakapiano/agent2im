# 后续阶段：Chat 新建 Session 与原生 Resume

保留设计：2026-09-26。Chat new、受管进程创建和 release 交接已后置。本文为后续实施参考；当前首期接入已有 Codex 会话，并交付 Portal、渠道配置和 Web 首次审批。

下文中的“首期”指未来启动该托管生命周期阶段时的第一版策略。当前范围以 [实施计划](implementation-plan.md) 为准。

## 1. 三层生命周期

| 层 | 谁维护 | 生命周期 |
| --- | --- | --- |
| IM Session | agent-to-IM Broker | 标题、用户、路由、当前选择、任务记录长期保留 |
| Native thread | Codex | 原生历史由 Codex 写入并恢复，使用 `thread.id` 标识 |
| Runtime instance | Broker 或用户的原生 CLI | 承载一次运行；停止、释放或重启后可以更换 |

设计原则：一个已经建立原生身份的 IM Session 始终指向同一个 Codex thread。运行进程可以重建，恢复时使用原 `thread.id`。

Codex 返回的 `thread.sessionId` 表示 session tree 的关联标识；本项目的 `native_thread_id` 取 `thread.id`。本项目自己的 `session_id` 是独立 UUID。三个字段分别保存。

## 2. `/new` 采用两阶段创建

### 阶段 A：登记空会话

收到 `/new agent-im 登录问题` 后，Broker 在一个事务中：

1. 验证 owner、私聊和 workspace alias。
2. 创建 Session UUID、短 ID、标题、工作目录及原生 Agent home 引用。
3. 设置 `state=draft`、`history_state=uncreated`，当前 runtime 为空。
4. 更新私聊的当前选择，返回“已创建，等待第一条任务”。

这个阶段是控制面操作。用户可以查询、改选和保留这个空会话。原生 resume 入口在真实 Codex thread 产生后提供。

草稿的 `/stop` 只处理已登记的排队工作。后续明确任务到达时，是否首次创建以 native identity 是否已经建立为准。

### 阶段 B：第一条任务建立原生 thread

收到该 Session 的第一条任务后：

1. 持久化任务、创建操作 ID 和 `state=provisioning`；同一 Session 的其他输入进入队列。
2. 在允许的工作目录启动受管 App Server，使用与用户原生 Codex 相同的 Agent home。
3. 完成初始化，调用 `thread/start`，明确选择 `ephemeral=false`。
4. 记录返回的 `thread.id`，通过原生接口设置标题，绑定 Session、runtime 和 native identity。
5. 建立 MCP 的受信运行描述，提交第一条任务并观察原生事件。
6. 根据原生持久化证据更新 `history_state`；达到恢复验收条件后显示 native resume 命令。

原生 thread 尚未完成可恢复历史写入时，状态保留为 `pending_persistence`。空 thread 的落盘时机、第一条输入的保存时机及硬中断后的恢复，都在本机版本上单独验收。

创建操作通过 Broker ledger 幂等。`thread/start` 结果不确定时，核对该创建操作独占的 runtime 中已经存在的 thread，再决定继续动作。关联仍不明确时进入待核对状态。

Agent 后续调用 MCP `register`，按已验证 native identity 找到这一条 Session。它补齐注册上下文并返回现有 ID。

## 3. 状态如何变化

| 事件 | IM Session / 工作状态 | 原生历史 | 运行实例 |
| --- | --- | --- | --- |
| `/new` | `draft` | 尚未创建 | 空 |
| 第一条任务 | `provisioning` → `running` | 建立持久 thread | Broker 启动 |
| 等用户回复 | `waiting_user` | 保持原 thread | 保持运行 |
| 一轮完成 | `ready` | 保存结果 | 保持可附着 |
| `/switch B` | 只修改当前选择 | A/B 各自保留 | A 的工作继续 |
| `/stop A` 完成 | `stopped` | 保留已有历史 | 任务树清理完成；独占受管实例释放 |
| `/release A` 完成 | 工作状态保留，`wake_policy=manual_registration` | 保留已有历史 | Broker 释放所有权 |
| 原生 CLI 恢复 A | Broker 显示原生接手/控制已释放 | 原 thread 增加新内容 | 原生 CLI 承载 |
| 原生会话再次 register | 同一 IM Session，更新控制上下文 | 同一 thread | 附着当前实例 |
| 重启/崩溃 | 先 `offline` 或核对中 | 由 Codex 恢复 | 验证旧实例后再接续 |

`history_state`、`runtime_id`、`runtime_owner` 和 `wake_policy` 独立于工作状态展示，避免把“停止工作”“释放接入”和“删除历史”混为一个操作。

首期空闲运行实例按显式生命周期管理：`idle_release_seconds=0`。有界空闲回收列为后续策略，并以排队任务、等待、goal、后台资源、终端附着和所有权核对为释放条件。

## 4. 与原生 Codex 共用历史

### 4.1 使用同一个 Agent home

受管 App Server 继承用户正常使用的 `CODEX_HOME`。未显式设置时，解析该用户的原生默认 home，并保存规范化路径引用。

Launcher 同时校验实际 OS 用户与 home 引用。后台自启也沿用这个身份和配置，避免服务账户变化导致会话落入另一套原生存储。

每 Session 隔离的是运行进程和任务归属。Codex 配置、认证和原生历史继续使用用户原有 home。本项目数据库保存映射、路由、任务和消息审计；原生 transcript、索引和模型上下文的写入交给 Codex 接口。

这意味着“从工具里新建”与“从终端恢复”使用同一个原生存储。用户若有多个 `CODEX_HOME`，Session 固定保存建立时的 home 引用，并在恢复提示中标明。

### 4.2 持久化约束

- 新建使用 `ephemeral=false`，采用安装版本可恢复的原生 history mode。
- 恢复调用 `thread/resume({threadId})`，验证返回 `thread.id` 与原记录一致。
- 保存原生来源分类；列表查询显式包含 `appServer` 等来源。
- 普通停止和释放保留原生历史，生命周期操作与归档/删除操作分开授权。
- 首期 MCP 服务器为可选集成：配置 `required=false`，Codex 的普通恢复仍可作为独立工作流使用。
- MCP sidecar 在 Broker 离线时仍完成工具初始化；具体调用返回 `BROKER_UNAVAILABLE`，避免把服务连接当作原生启动前提。
- `cwd`、Agent home、provider/profile 的有效配置引用随会话记录，接回终端时明示需要的环境。

## 5. 两种终端接回方式

### 5.1 运行中：附着同一个 App Server

用户希望保持当前执行进度并接回终端时，使用原生 CLI 的远程连接，目标是已经承载该 thread 的实例。

命令形态：

```powershell
codex resume <native_thread_id> --remote ws://127.0.0.1:<port> --remote-auth-token-env AGENT_IM_CODEX_TOKEN
```

端点、令牌环境变量和原生 ID 由本地可信控制面解析；IM 回帖展示 Session ID 和本地接回指引，密钥留在本机。

这是同一执行实例上的额外客户端。关闭这个终端只结束该客户端连接，Broker 的任务仍按原生命周期运行。具体客户端退出行为需要 P0 验证。

### 5.2 交给普通原生 resume：先释放，再冷恢复

增加一个清楚的交接动作：`/release [session_short_id]`，或未来对应的本地 CLI 命令。

1. 验证工作树已空闲。存在运行任务、排队输入或等待时，返回具体项并保持原控制策略，由用户选择完成任务或先 `/stop`。
2. 持久化 ReleaseOperation 的 draining 状态和目标唤醒策略，暂存新的 Broker 派发请求，复核原生状态和持久化边界。期间出现新的原生活动时，将交接留在待核对状态，展示具体阻塞项。
3. 在静止与持久化条件成立时取消订阅，并优雅结束该 Session 独占的受管实例；核对实际退出。
4. 提升控制 epoch、清除运行租约，保留 Session/native identity/route，并持久设置 `wake_policy=manual_registration`。draining 期间的新增输入保留在 Inbox，待重新注册后处理。
5. 输出恢复用的原生 ID、工作目录和 Agent home 引用。只有第 4 步完成后才展示交接成功。

恢复流程优先读取未完成的 ReleaseOperation；draining 期间进程退出或 Broker 崩溃时，先完成交接核对，保持自动派发关闭。

然后用户在同一 Agent home 下使用：

```powershell
codex resume <native_thread_id>
```

Broker 重启后仍尊重这个交接状态。新的 IM 输入可以返回“该会话已交给原生终端”的状态提示，恢复派发需要在原生会话重新注册。

用户在恢复后的原生会话调用 `$connect-to-im`。注册器按 `agent + agent_home_id + native_thread_id` 找回原 Session，并核对当前可连接 runtime，随后绑定到这个活实例。

## 6. 原生选择器与直接 ID 恢复

原生 CLI 有工作目录和来源筛选。本机 0.154.0 的 help 提供：

```powershell
codex resume --all --include-non-interactive
```

`--all` 扩大 cwd 范围，`--include-non-interactive` 扩大来源范围。这个命令用于选择器；已知完整 native thread ID 时可直接按 ID 恢复。

`/status` 应分别返回：IM short ID、native thread ID、原生历史状态，以及当前适用的“热附着”或“释放后恢复”提示。

## 7. 单一执行所有权

基本原则：一个 native thread 在任一时刻由一个执行实例推进；多个客户端通过该实例共同交互。

两种明确的安全路径是：活实例上的远程附着，或释放后的原生冷恢复。Broker 的本地租约约束自己的派发；外部原生 CLI 的跨进程行为需要由实际 Codex 版本验证。

首期做以下保证：

- 本工具持有活实例时，为用户提供连接同一实例的指引。
- 明确 release 后，Broker 持久保持手动重新注册门槛。
- 启动或恢复前核对已知实例的 endpoint、PID generation、原生 thread 和持久状态。
- 发现其他宿主已接手或所有权不明时，暂停新执行并请求核对。
- 所有权交接不明、进程崩溃后结果不明时，原始任务记录进入核对流程。

任意外部 CLI 在受管实例仍运行时直接执行裸 resume 的行为列为 P0 兼容性测试：实际版本若有原生所有权保护就接入该机制；否则产品引导使用明确的附着/释放路径。

## 8. 工作目录与接入配置

进程创建时使用工作区别名解析后的原目录。原生恢复时的目录选择遵循 Codex 自己的行为，提供 `-C` 仅在用户明确要覆盖目录时使用。

`connect-to-im` 作为工具/Skill 接入能力使用。普通原生恢复保留用户日常使用的模型、权限和配置工作流；再授权 IM 时由注册流程检查能力。

## 9. 验收门槛

1. `/new` 创建 draft；第一条消息建立一次 native thread，重复事件保持幂等。
2. 原生 thread ID 建立后保持稳定，runtime ID 可在恢复时更新。
3. IM 中产生历史后，release，再用原生 `codex resume <id>` 继续；再注册后 IM 看见同一 Session。
4. 核对同一 Agent home 的默认选择器、跨目录选择器及来源筛选。
5. 热附着与 Broker 同时发消息时由同一执行实例处理，终端退出后 IM 继续。
6. release 在忙碌时返回具体工作项；空闲 release 保留原生持久数据。
7. release 后重启 Broker，再发 IM 消息，原生所有权保持。
8. 原生 CLI 在受管实例仍运行时直接 resume：记录真实冲突/附着行为，制定版本适配策略。
9. 首轮写入前、写入中、写入后崩溃，分别验证 `history_state` 和恢复提示。
10. MCP 服务离线时，普通原生 resume 仍能完成日常对话；恢复 IM 接入时重新注册。

依据：本项目 [兼容性记录](references.md) 中的 S1、S2、S8，以及本机生成的 ThreadStart/ThreadResume/ThreadList schema。
