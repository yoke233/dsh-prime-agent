# 异步子 Agent 最终结果重复投递：待修复设计记录

## 状态

- 状态：待协议确认，尚未实施
- 影响面：DSH continuable subagent 的父子消息与 Activation settlement
- 发现现象：子 Agent 的同一最终文本先以 `agent-message` 到达父 Agent，随后又随 `subagent-settled` 到达，触发两个父 Agent step，并产生两次用户可见回复
- 核对基线：本机只读 `../deepseek-harness` checkout，commit `76fda729799fe9b3848dbe2c211d4b231032b81e`

本文只记录待修复事项。本仓库不得修改同级 `../deepseek-harness`；真正的协议修复应先进入 DSH 上游，本仓库再升级已发布依赖并验证组合行为。

## 复现

父 Agent 异步启动一个 continuable 子 Agent，任务仅要求返回一句话。当前链路为：

1. DSH 在原始任务后追加指令，要求子 Agent 结束前调用 `send_message` 把结果发给父 Agent。
2. 子 Agent 调用 `send_message(result)`，runtime 立即向父 Agent inbox 插入 `agent-message`，并唤醒或 steer 父 Agent。
3. 子 Agent 随后以相同文本结束自己的 turn。
4. Activation 静默后，continuation manager 无条件向父 Agent插入 `subagent-settled`，其中再次包含最后一条 assistant message。
5. 父 Agent因此处理两个模型输入，并可能向用户回复两次。

这不是单纯的前端重复渲染；重复在父 Agent inbox 和模型 step 之前已经形成。

## 已确认的源码事实

### 自动追加的子 Agent 提示

DSH 上游：

- `packages/subagent/subagent/src/continuation.ts:303-316`
- `continuableInitialPrompt()`

当前提示要求子 Agent在结束前通过 `send_message` 发送最终结果。该文案由 runtime 自动追加，不是调用方任务的一部分。

### 无条件 settlement

DSH 上游：

- `packages/subagent/subagent/src/continuation.ts:1450-1602`
- `watchSettlement()`、`finishDisposal()`
- `packages/subagent/subagent/src/continuation.ts:1605-1671`
- `notifySettlement()`

每个已向调用方公布 id 的 Activation 都会收到一次 settlement account。通知携带 `stopReason` 和当前 Activation 的最后一条非空 assistant output，并通过 `followup` 或 `steer` 送入父 Agent。

该保证是必要的：模型失败、取消、token 上限或 policy refusal 时，子 Agent可能没有机会主动发送消息，但父 Agent仍必须知道本轮如何结束。

### 现有契约与测试

- `docs/subsystems/subagent.md:198-216`：settlement 是 runtime 对一次 Activation 的结束说明，来源类型为 `subagent-settled`。
- `packages/subagent/subagent/tests/continuation.spec.ts:2013-2049`：要求 settlement 携带最终输出，而且即使子 Agent发送过显式消息也不能取消 settlement。
- `packages/subagent/tool-subagent/src/index.ts:587-596`：delegation 工具已承诺后台运行结束后自动发送 outcome 和 final assistant message。
- headless settlement fixture 的子任务显式包含“Do not call send_message”，说明现有测试通过调用方规避了默认提示造成的双投递，未覆盖默认行为。

## 领域语义

### Durable Child Session

可持续复用的子 Agent身份与持久历史。它不会因为一次 Activation settlement 被永久删除。

### Activation

Durable Child Session 的一次进程内驻留期。当前 turn、inbox 和后代都静默后即可释放；之后向同一 child id 发送消息会 cold-resume 一个新 Activation。

### agent-message

Agent 主动选择发送的相邻父子消息。适合必须在当前 Activation 结束前影响对方下一步的中间发现、问题或协调信息。

### subagent-settled

runtime 对一次 Activation 的终态说明。它应是本轮最终输出和停止原因的唯一权威交付路径。

## 推荐设计

采用单一终态所有者：**settlement 负责最终交付，`send_message` 负责提前通信。**

1. 修改 `continuableInitialPrompt()`：保留动态 parent id，只指导子 Agent将必须提前到达的信息通过 `send_message` 发送；最终结果正常写入 closing assistant message，由 settlement 自动交付。
2. 保持 `notifySettlement()` 对所有已公布 Activation 的无条件投递，包括异常 stop reason 和 partial/empty output。
3. 保持 `send_message` 的即时投递、直接父子授权和 cold-resume 语义；它不拥有或改变终态。
4. 将用户可见措辞从容易暗示永久终止的 `finished` 调整为“一次运行已结束、子 Agent仍可恢复”的表达；该文案改进与结果去重分开提交也可以。
5. 若需防止事件重放，只按稳定的 message/event id 做幂等；不要按自然语言内容推断两个语义事件相同。

建议的模型可见语义，不固定具体自然语言：

> 父 Agent id 可用于提前通信。需要在本轮结束前改变父 Agent下一步时使用 `send_message`；最终结果直接作为本轮 closing response 返回，runtime 会在 settlement 时自动交付。

## 不采用的方案

### UI 按文本去重

发生得太晚：父 Agent已经被唤醒并消耗了额外模型 step。相同文本也可能分别代表合法的中间确认和最终结论。

### 按 child id 去重

一个 Durable Child Session 可以经历多次 Activation。同一个 child id 的后续 settlement 是合法的新事件，按 child id 去重会丢失结果。

### 子 Agent发送过消息就取消 settlement

无法区分中间进度与最终结果，也会在异常结束时丢失 stop reason 和最终 partial output。

### 给 `send_message` 增加 `progress | final` 并让两条路径都能结束任务

这会产生两个终态所有者，扩大模型必须理解的 interface，并引入 final message 与 settlement 的顺序、崩溃和重试竞争。除非未来明确需要“结束前立即提交最终结果”，否则不引入。

### 延长空闲驻留时间掩盖竞态

Idle grace period 只能改变两次通知的时间间隔，不能消除两个语义输入；同时增加资源占用和生命周期状态。可作为冷启动性能优化单独评估。

## 验证计划

### DSH 上游

1. 更新 initial-prompt 测试：初始任务应表达“最终输出由 settlement 自动交付”，不再要求结束前发送最终 `send_message`。
2. 增加默认异步完成回归：子 Agent只产生 closing assistant output，父 Agent只接收一个 `subagent-settled`，只被终态结果唤醒一次。
3. 保留显式中间消息测试：`agent-message(progress)` 立即到达，随后仍有一次包含终态的 `subagent-settled`；这是两个不同语义事件。
4. 覆盖 `completed`、`aborted`、`max-tokens`、`refusal`、`error`，确保异常路径仍无条件报告。
5. 覆盖复用：同一 child id cold-resume 后产生新的 Activation 和新的 settlement，不被上一轮抑制。
6. 更新 headless settlement fixture，移除调用方任务中的 `Do not call send_message` 临时规避，并核对父 Agent模型 step 数量。

### 本仓库集成

DSH 发布修复版本后：

1. 升级相关 `@deepseek-ai/dsh-subagent` / tool 依赖和 lockfile。
2. 运行 prompt dump，确认最终组装提示不再要求子 Agent主动重复最终结果。
3. 增加 Prime 组合回归：异步一句话任务只产生一次最终用户回复。
4. 按仓库要求运行 `npm run check:all`，并核对打包边界。

## 完成标准

- 普通异步完成只有一条权威最终结果进入父 Agent。
- 每个已公布 Activation 仍有且仅有一个 settlement account。
- 中间 `send_message` 仍能及时影响父 Agent。
- 异常结束仍报告 stop reason 和可用的 partial output。
- 同一 Durable Child Session 可以通过原 child id 恢复并完成后续 Activation。
- 不依赖文本相似度、模型记忆或 UI 隐藏来保证正确性。
