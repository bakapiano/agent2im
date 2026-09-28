# 验收记录

更新：2026-09-28。当前主路径为原生队列中继。

本地部署构建 `9fe394869e36221f`，MCP 握手与 Broker health 一致。schema 4 完整性检查通过，飞书 enabled/connected。此前 1 个服务会话映射及其数据已归档至 `.local/install-backups/queue-relay-20260928/`；飞书配置、IM 使用者批准和 Codex 原生历史保留。

当前 11 个测试文件 / 89 项自动化通过；Chromium 流程复验通过，39 项工具输入契约、30 个文档链接及两份 Skill 校验通过。最后一次合并执行中的浏览器步骤曾在 loading 状态超时，随后同版本独立复验通过。

## 真实协议验证

独立中继读取现有 thread 并调用 thread/queue/add，原运行进程持续在线并执行新消息。中继持有的 loaded list 中没有该目标 thread；全过程不调用原生 resume。结果证据位于 `.test-data/queue-cross-host-iREw3c/result.json`。

跨宿主能力探测确认：thread/read 返回 notLoaded，goal/get/clear 和队列操作可用；turn/interrupt 与后台终端接口在中继中无法访问原宿主执行对象。产品状态和停止报告据此表达边界。

## 自动化测试

tests/native.test.ts 使用实际 Codex、独立 home、模拟模型和假 IM，验证：
- 当前原生进程持续运行，首次 MCP register 直接成功。
- Broker 中继与原宿主为不同进程。
- 主动消息、原 MCP 问答、IM 队列任务和 job_id 明确结果回传。
- 状态显示 owner_online、queue_relay 和 executionState=unobserved。
- 停止清理队列和持续目标，准确报告原生执行残留；原宿主仍可继续原生对话。

其他测试覆盖 IM 使用者审批、撤销和到期、路由隔离、epoch 竞争、等待/消息幂等、当前数据格式及不匹配格式拒绝、MCP 传输、安装校验和用户配置保持。

## 真实 TUI

`.test-data/native-tui-B7rupz/result.json` 记录真实普通 CLI 首次注册、消息、回答与 IM 任务回传。原进程 PID 1908 在整个流程保持在线；测试期间原 CLI 无退出或重建步骤。模型、IM 和使用者审批使用隔离夹具。

手动夹具：
1. `pnpm exec tsx tests/manual-cli-fixture.ts --prepared-home`
2. `pnpm exec tsx tests/manual-cli-fixture.ts cli <setup.json>`
3. 浏览器查看 `http://127.0.0.1:21643/fixture`。
4. 核对 completed=true、wait answered、job completed 和真实停止残留。

## 回归与发布

`pnpm check` 运行类型检查、构建、单元/真实原生协议和 Chromium 流程。设计契约由 `scripts/check-design.ps1` 检查，两份 Skill 使用 quick_validate 校验。

安装只更新本项目 MCP/Skills。数据使用 schema 4；运行代码只处理当前格式。历史服务映射在本地发布时另行归档，飞书渠道、使用者批准和原生 Codex 历史保留。

## 能力边界

接入、发送和问答在当前对话中完成。原生模型 turn 的实时状态和强制停止全部子任务尚需原宿主控制接口；当前 /stop 返回 complete=false 和明确残留。Chat new 与其他 Agent/IM Adapter 保持后置。
