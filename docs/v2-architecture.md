# dsh-prime-agent 架构：DSH 原生 RLM 控制面

## 状态

本文描述当前架构。插件不读取 0.1 状态，不提供迁移或兼容入口。

- 持久 TypeScript Realm 是主能力；`prime_refine` 是次级学习层。
- Code Mode 是唯一模型可见控制面。
- IPython、Context Capsule `share`/`mount` 和自动 refinement 不属于当前版本。

## 核心判断

Prime Agent 最有辨识度的部分不是一组 memory 条目，而是 RLM 工作方式：上下文成为可寻址数据，推理成为对数据、工具和 Agent 的程序化调度。

插件保留"上下文外置、按需读取、代码组合工具"的 RLM 不变量，并复用 DSH 已拥有的运行时：

```text
用户任务
  → run_code（组合、过滤、并发）
  → Realm state（跨 run 保留中间值、函数与索引）
  → subagent / jobs（独立执行与后台生命周期）
  → 持久任务文件（跨重启检查点）
  → 反复验证后的经验才进入 prime_refine
```

设计顺序是：

1. 持久 Realm 负责跨 run 的计算命名空间。
2. DSH Code Mode 负责程序化控制。
3. DSH Subagent/Jobs 负责执行生命周期。
4. Continual Harness 只负责稳定经验。

## 组件边界

### `realm/` 与 `runtime.ts`：持久计算命名空间

选择 Prime preset 的 Session 经 `prime_realm_identity` handshake 路由到长期 TypeScript Worker：显式写入 `state` 的函数、对象、Map、索引和 module cache 在正常的后续 `run_code` 之间保留。普通 Session 继续使用官方 one-shot Worker。身份、generation 语义、binding lease 与资源治理见 [v0.3 路线](v0.3-roadmap.md)。

Realm 是 live-only 的：hard kill 后 heap 丢失,下一次 run 收到明确的 generation 通知。需要跨重启存活的检查点由程序显式写入持久任务文件。

### Code Mode：唯一模型控制面

当存在 owning Agent 时，system prompt assembly 必须只向模型暴露 `run_code`。`prime_refine`、Subagent 和 Jobs 作为 Code Mode SDK 成员被程序调用。

控制面 policy（`src/policy.ts`）明确要求：

- Realm `state` 是默认工作区，中间值赋值即保留。
- 先归约、后返回：大结果在程序内过滤、聚合，只返回当前决策需要的摘要。
- 阶段边界把必须跨重启存活的内容写入持久任务文件。
- 独立前台工作用 `Promise.all`；best-effort 探测逐项捕获；副作用型 mutation 顺序执行。
- 后台工作通过 DSH Subagent admission 与 Job handle 继续。
- 失败是事实不是瞬态；sandbox denial 只允许一次同操作最小权限请求。

插件在 assembly 阶段检查 Subagent 与 `job_output` 是否真实可见。缺少必需编排能力时明确失败，不假装具备 Prime 式体验。

### DSH Subagent/Jobs：生命周期所有者

插件不创建 Worker registry、消息总线或 Agent Loop。

- 前台并发：Code Mode 中对真实 Subagent 工具使用 `Promise.all`。
- 后台 admission-first：使用工具的 `run_in_background: true`，保留返回的 Job id。
- 稍后回收：使用 `job_output`。
- 取消、观察、持久化和 completion delivery：由 DSH Jobs/Subagent 拥有。
- Goal、Workflow、Compaction、Schedule：继续使用 DSH 原生能力。
- 子代理上报调度由随包 `subagent-report` row 按父状态逐次选择投递（父忙折入当前轮次，父闲唤起一轮）。

### `continual/`：次级学习层

`prime_refine` 提供 inspect/apply/rollback：

- 禁止存任务数据、研究笔记、中间结果和大上下文。
- apply 必须有 trigger、具体 evidence、可验证 expected outcome 与最小 edits。
- rollback 需要 expected_revision 与 transaction_id，拒绝 evidence、expected outcome 与 edits；可选 trigger 记录回滚动机，缺省时事务写入合成文案。
- apply/rollback 使用 optimistic revision。
- rollback 只在目标事务输出未被后续修改时成功；回滚事务与 apply 一样留痕，记录动机、rollbackOf 与 before/after。
- 严格校验针对歧义或越权的输入；与当前操作语义相容的动机说明应被接受并留痕，不应迫使调用方丢弃它。
- skill/subagent 条目必须引用真实可见工具，不能引用 `run_code` transport。
- local/global 默认都由部署策略控制，global 默认关闭。

continual prompt snapshot 只包含有界的稳定经验。每条经验以 JSON-quoted 的不可信建议记录呈现，结构性字段拒绝控制与格式字符，模型策略明确禁止记录覆盖当前 system、user、权限或工具约束。基础 system prompt 不可由 refinement 修改。

## Prompt 与 token 边界

每轮动态 prompt 包含：

1. 控制面 policy。
2. 有界 continual learning snapshot。

大值不进入 prompt：它们要么以 Realm `state` 活值存在于 Worker heap，要么落在持久任务文件里,进入上下文的只有程序显式返回的归约结果。

## 状态布局

```text
<stateDirectory>/
  realm-identity/
    hmac.key
    sessions/<keyed-session-path>.json
  continual/
    global.json
    sessions/<sha256-session-id>.json
```

local 文件名使用 Session id 的散列，不把原始 id 暴露到文件名。状态提交使用跨进程锁与原子替换；损坏或超限状态不会静默降级。

## 为什么不使用 IPython

持久 IPython 的优势是保留活 Python 对象、函数和 Kernel 命名空间；代价是另一套进程、Comm/RPC、资源配额、崩溃恢复、安全和 Agent scope 绑定。

DSH TypeScript Code Runtime 已提供唯一模型可见 `run_code` 界面、scoped tool SDK、并发组合、日志、取消、输出约束以及与 Subagent/Jobs 的原生集成。持久 Realm 在此之上补齐了 Prime 的持久计算命名空间：函数、import、对象、索引和 client 跨 run 延续，而无需第二套 Kernel 生命周期。

## 配置与部署不变量

- `stateDirectory` 必填。
- `requireCodeMode` 默认 true。
- `requireOrchestrationTools` 默认 true。
- global refinement 默认 false。
- refine 工具名必须匹配小写字母、数字和下划线规则。
- 所有 limit 必须为正整数；Schemastery 还对 state 的最低安全值做约束。
- bundle patch 替换 host `code-runtime` provider 并接管 subagent-report 投递；随包 Prime preset 由 runtime 启动时落位。默认 preset、`tools` mode 与既有 preset 均不变。

## 后续边界

### 0.4：Context Capsule 与 Agent Family

- 不可变 `share`/`mount` 与显式父子上下文授权。
- admission-first child handle、恢复、follow-up、collect、cancel 与 delete。
- child 主动 reply、capsule 生命周期。

### 0.5：学习闭环

- 从失败、纠正与稳定成功生成 proposal。
- proposal、review、apply 分离。
- global 修改默认需要明确批准。
- 观察效果并提出回滚建议，不自动扩大权限。

## 上游同步

Prime Agent 会继续变化。每次更新都应比较行为不变量，而不是机械复制代码。基线、观察路径、判断矩阵和验证步骤见 [上游同步与差异对照手册](upstream-sync.zh.md)。
