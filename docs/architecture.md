# 架构设计

更新：2026-09-28。当前接入采用原生队列中继。

## 产品入口

用户照常启动 Codex，在当前对话调用 `$connect-to-im`。MCP 从宿主元数据获得 threadId，识别原进程和 CODEX_HOME。Broker 直接注册该会话，并持有独立的队列中继 App Server。执行权持续保留在原 CLI。

```text
IM 用户 ⇄ IM Adapter ⇄ Broker ⇄ 队列中继 App Server
                          ↑             ↓ thread/queue/add
                      当前会话 MCP ← 原 Codex CLI 执行任务
```

注册、发送和等待均由当前会话的 MCP 发起。原生 CLI 继续消费自己的队列。用户正常关闭 CLI 后，已排入的原生消息保留在原生队列，用户正常重新打开会话时消费。

## 组件责任

| 组件 | 责任 |
| --- | --- |
| Broker | IM 身份审批、会话映射、原生队列投递、等待、明确结果回传、停止报告、持久化 |
| MCP sidecar | 从本次调用元数据获取 thread；识别原进程；请求 Broker；返回消息/等待结果 |
| 队列中继 | 使用同一原生 home，通过 stdio 调用 thread/read 和 thread/queue/add/list/delete、goal/get/clear |
| 原 CLI | 唯一的会话执行宿主，管理模型、工具、原生权限和历史 |
| Web Portal | 渠道配置、IM 使用者审批、会话及审计 |
| IM Adapter | 认证平台事件、规范化身份和消息、发送回执 |

注册链路只接受当前接口格式。数据存储使用当前 schema，新空库初始化；其他 schema 明确报错。进程和协议错误显式返回。

## 身份与审批

- 产品审批对象为 IM 使用者，依据平台 user ID、租户、渠道身份和私聊。
- 本地客户端凭据证明请求来源；本次 MCP threadId 和原进程身份将调用绑定到真实原生会话。
- 同一 native home/thread 对应稳定 Session ID，IM 私聊保存当前选择。
- cwd 是原生元数据；可选工作区别名用于显示。
- 渠道配置由 Web 或已认证本地 MCP 直接执行。IM 使用者批准、拒绝、撤销及到期持久化。

详情见[Portal 与审批](portal-and-access.md)。

## 注册与消息

1. MCP initialize/listTools 独立完成；实际工具调用按需启动或联系 Broker。
2. register 读取本次宿主 threadId、原 PID/创建时间/可执行文件和原生 home。
3. Broker 通过队列中继读取该 thread 元数据并登记。技术参数由工具处理。
4. 唯一已批准 IM 私聊自动绑定；多个候选由用户选择。
5. IM 普通任务先持久化，再通过 thread/queue/add 入队。原 CLI 在自己的会话里处理。
6. IM 任务携带稳定 job_id。Agent 通过 send_message_to_user(purpose=result, job_id) 明确回传结果。

队列回执代表投递被接受。结果完成由对应 Agent 的明确结果调用记录。接收重复事件、投递重试及结果发送使用幂等键；不确定结果保持 unknown。

## 问答和切换

wait_for_user_message(ask) 保存问题和 Outbox，投递后等待关联回答。单次等待有上限，mode=resume 使用同一请求与期限。问题持久化，MCP 断开后仍可继续取回已保存答案。

普通回复进入当前私聊选择的 session；引用问题和 /reply 固定回到原问题。切换只改变后续选择，已经接收的任务和回复保持既定路由。

## 状态与停止

status 展示 owner_online/offline、controlMode=queue_relay、executionState=unobserved，以及本项目任务、等待、消息回执。中继的 thread/read 对外部执行宿主返回 notLoaded，因此实时 turn 状态与原生终端由原宿主管理。

/stop 先递增 session epoch、停止 Broker 派发、取消等待及排队消息，然后清理原生队列和持续目标。当前队列中继的 turn/interrupt 和后台 terminal 控制无法访问另一个宿主中的执行对象。报告保持 complete=false，并列出需要在原生界面停止/核对的执行资源。停止控制不通过退出接入、重启或接管原 CLI 实现。

原生历史、模型配置与执行权限保留。Chat new、完整原生执行控制、其他 IM/Agent Adapter 为后续独立能力。

## 存储

schema 4 保存客户端、渠道、IM 审批、session/runtime、Inbox/Outbox、Job、Wait 和审计。每个异步动作携带 session epoch；派发前核验 IM 使用者批准与当前 epoch。按接受顺序处理任务，保留平台未知回执。

当前数据目录只读写本版结构。发行目录固定构建号；安装只修改本项目 MCP/Skill 文件，使用带校验的备份保护用户配置。
