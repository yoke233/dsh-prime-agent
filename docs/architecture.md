# dsh-prime-agent 当前架构

## 文档范围

本文只描述仓库当前已经实现并随包交付的架构，不记录版本路线、未来阶段或候选设计。代码、`agent-presets/prime/agent.cordis.yml` 与 `cordis.patch.yml` 是最终事实来源。

`dsh-prime-agent` 在 DeepSeek Harness（DSH）之上提供一个 RLM-first 控制面：Prime Session 通过唯一模型可见的 `run_code` 使用持久 TypeScript Realm，普通 Session 继续使用 DSH 官方 one-shot Code Runtime。插件复用 DSH 的 Agent、Subagent、Jobs、权限、日志和 Session 生命周期，不创建第二套 Agent Loop。

## 领域术语

| 术语 | 当前含义 |
| --- | --- |
| Session | DSH 持有的会话身份与持久事件日志，是 Realm、child 和 local learning state 的归属键。 |
| Realm identity | 由 Session 稳定映射得到的不透明 id，用于把同一 Session 的 Prime cell 路由到同一个 Realm。 |
| Worker generation | 一个 Realm 当前活着的 Worker Thread。hard kill 后会换代，旧 live namespace 永久丢失。 |
| live namespace | Worker generation 内跨 cell 保留的普通顶层变量、函数、对象、Map 和索引。它不是持久存储。 |
| cell / run | 一次 `run_code` 调用。一个 Realm 同时只执行一个 cell。 |
| binding lease | 当前 cell 对 DSH 工具 binding 的临时调用权；cell 结束即撤销，保留下来的旧 wrapper 不能越轮调用工具。 |
| Realm ownership lease | 一个已认证 Realm 的跨进程 live-heap 所有权；不同 Realm 不互斥。 |
| continuable child | 由 DSH 持久化、可接收后续消息并可冷恢复的子 Agent。其 id 不是 Job id。 |
| Job | DSH 的通用后台任务。它有 `job_output`/`job_list`/`job_kill`；continuable child 不通过 Job 收集结果。 |
| handoff file | 父子 Agent 在共享工作区传递大材料或结果的普通文件。只写一次是 policy 约定，不是文件系统授权。 |
| harness entry | `prime_refine` 注入 prompt 的一条有界、非可信建议记录。 |
| refinement transaction | 对 harness entries 的一次 apply 或 rollback 审计记录。 |

“Agent Family”只描述 DSH 持有的直接父子关系和后代树，不表示本插件拥有独立 family registry。“Context Capsule”不是当前运行时对象；当前跨 Agent 上下文原语是 handoff file。

## 系统组合

```text
DSH profile
├─ cordis.patch.yml
│  ├─ 官方 code-runtime row（disabled）
│  ├─ dsh-prime-agent/runtime
│  │  ├─ Prime request ──→ Realm identity ──→ Realm pool ──→ persistent Worker
│  │  └─ ordinary request ──────────────────→ 官方 one-shot Worker
│  └─ 官方 tool-subagent-report（next-step）
│
└─ Prime Agent scope
   ├─ agent-presets/prime
   ├─ dsh-prime-agent
   │  ├─ control-plane policy
   │  ├─ prime_refine
   │  └─ prime_realm_identity
   └─ Code Mode：模型只看见 run_code，其他工具成为 TypeScript SDK bindings
```

包有两个运行入口：

- `dsh-prime-agent`：Agent scope 内的 policy、continual learning、Realm handshake binding 与 Code Mode assembly 检查。
- `dsh-prime-agent/runtime`：host scope 内的 hybrid Code Runtime、Realm pool、官方 fallback、按 Realm 的进程 lease、父进程生命周期监控与 Prime preset 落位。

## 安装与 preset

随包 `cordis.patch.yml` 只执行一组 runtime 替换：停用官方 `code-runtime` row，插入 hybrid runtime。普通请求由 hybrid runtime 内部挂载的官方 Worker Thread Runtime 原样处理。

Subagent report 完全复用 DSH rc.8 base bundle 的官方 `tool-subagent-report`。其默认 `next-step` 调度通过 `parent.steer()` 让运行中的 parent 在最近 step 消费报告，并唤醒空闲 parent；continuation manager 同时负责唤醒记账以及 report 先于后续 settled notice 的 FIFO 顺序。本包不再替换或复制该能力。

runtime 启动时把随包 Prime preset 复制到 `$DSH_HOME/.agent-presets/prime`，仅在目标目录不存在时写入。已有目录永不覆盖；要采用新快照必须由操作者删除旧目录后重启。

默认 preset、默认 tools mode 与其他 preset 不会改变。

## 唯一模型控制面

Prime Agent scope 必须使用 Code Mode。存在 owning Agent 时，prompt assembly 必须只暴露 `run_code`；`prime_refine`、Subagent、Jobs、文件系统及其他工具只作为生成的 TypeScript SDK 成员出现。组合不满足该不变量时，assembly 明确失败。

插件把官方“一次 async 函数”说明改写成持久 REPL cell 说明：

- 支持顶层 `await`。
- cell 的末尾表达式是结果，顶层 `return` 无效。
- 普通顶层 binding 留在同一 live namespace，供后续 cell 直接使用。
- 大结果应在程序内过滤、聚合或抽取，只把当前决策需要的摘要送回模型。
- 必须跨 Worker 或 host 重启保存的进度写入工作区文件。

Prime 不增加搜索适配层。源码发现直接调用 DSH 原生 `grep`；Code Mode 以 TypeScript 正则字面量的 `.source` 生成 `pattern`，Realm bridge 仍只传无损 JSON。

MCP 同样不进入 Realm runtime。profile 显式安装 DSH Host MCP client 后，server tools 注册到统一 `ctx.tools` catalog，Code Mode 自动把它们生成当前 Agent 的 TypeScript bindings；连接、认证、重连、工具代际、子进程与清理由 Host 插件拥有。本插件不复制上游的 Python kernel-owned MCP 或 ACP MCP program。

## Realm 身份与 hybrid 路由

Prime preset 在 Agent scope 注册固定名称 `prime_realm_identity`。hybrid runtime 对每次 Code Runtime 请求执行以下路由：

1. bindings 中没有该成员：完整委托官方 one-shot runtime。
2. 成员存在但不可调用、响应格式错误或认证失败：明确失败，不降级。
3. 成员有效：runtime 生成 32 字节随机 challenge，取得绑定当前 Session 的 token 与 challenge proof。
4. host 侧用同一个 `<stateDirectory>/realm-identity` 验证 token、proof 与 challenge，得到 Realm identity。
5. 通过认证的请求按调用准入顺序进入对应 Realm。

每个 Session 的随机 Realm identity 持久保存；原始 Session id 只参与 HMAC framing，不进入文件名。token 同时带版本、Realm identity、Session binding 与 MAC，proof 绑定本次 challenge。比较使用 constant-time 校验，错误不暴露 token、proof、secret、Session id 或宿主路径。

同一 Session 恢复后仍映射到同一 Realm identity，但 live namespace 只存在于当前进程的 Worker generation；host 重启后得到空 namespace。fork child 有自己的 Session 和 Realm，不继承父 Realm heap。

## Persistent Realm

### live namespace

Worker 使用长期 V8 上下文执行连续 cell。顶层声明在当前 generation 内持续存在；工具 binding global 的 Proxy 身份也跨 cell 稳定，因此已保存的函数可以在后续 cell 使用当前轮次重新租用的工具实现。

cell 以严格模式和 V8 REPL 语义执行，支持顶层 `const`、`let`、`var`、function、class、destructuring、闭包与 top-level `await`。同类声明按 REPL 语义重声明。`tools` 等注入 global 是保留名；第一次合法 Prime run 冻结 Realm 的注入 global schema，后续 run 可以更新已有 namespace 的成员，但不能增加 namespace 或改变其错误类描述符。

同一 Realm 的 cell 严格串行。不同 Realm 在 pool 配额内并行。排队 cell 的取消只移除自身，不影响正在执行的 cell。

DSH compaction 不遍历、序列化或清理 Realm heap，spill 也不会驱逐用户保留的 binding。live namespace 因此只应作为紧凑工作集：大源数据和结果放在任务文件或现有 spill artifact，Realm 长期保留路径、索引、函数和摘要。当前没有隐式的 binding 级 GC。

### binding lease

每个 cell 开始时，Worker 安装本轮声明的 namespace members；结束前先撤销全部 lease，再结算结果。调用时再次校验 lease，因此：

- 当前 cell 可以调用 DSH 工具，schema、权限、sandbox、日志、取消和结果保留仍由 host 执行。
- 旧 cell 保存的 Proxy 和 wrapper 可复用身份，但不能在没有当前 lease 时调用。
- 本轮已接受的 host 调用全部结算后，cell 才完成。
- arguments 与 resolution 必须是无损 JSON；函数和原生 handle 只能留在 Worker heap，不能穿过 host bridge。
- `prime_realm_identity` 只用于 bootstrap，永不租给模型程序。

每个 cell 同时受 host-call 总量和并发量限制，超限调用被拒绝，不扩大权限。

### 完成值、日志与大输出

Worker 通过 Inspector 取得 cell 的末尾表达式，并把可序列化完成值交给 host。日志与完成值共同受 `maxOutputBytes` 硬上限约束；越界明确失败，不静默截断程序结果。

工具调用的 canonical value、持久日志 preview 与 spill locator 仍由 DSH 工具层管理。程序可以在 Realm 内使用完整 canonical value 做归约，而 Prime preset 为模型 projection 与 `tool/code-dispatch` 日志配置 12KB best-effort spill 阈值。backend 可用且 locator notice 能容纳时，超出部分由 DSH spill artifact 保存并按需读取；store 缺失、保存失败或 notice 无法放进预算时，策略保留完整 inline 成功结果并告警，不伪造 locator。这个预算不限制 Realm heap，也不等于上游 IPython 的 snapshot pruning；Realm 不复制 DSH 的 spill 或工具日志存储。

### 失败与换代

| 情形 | 当前结果 |
| --- | --- |
| 语法错误 | cell 不执行，namespace 不变。 |
| 普通程序异常或被程序捕获的工具失败 | 当前 cell 失败或由程序处理；Worker generation 保留。异常前已经完成的声明、赋值和外部副作用可能保留，遵循 REPL partial-commit 语义。 |
| completion 序列化失败 | cell 已执行且 namespace 保留，当前结果以 invalid output 失败。 |
| 排队 cell 在 dispatch 前取消 | 只取消该 cell。 |
| active abort、compute/wall timeout、输出失控、Worker exit、OOM 或控制协议违规 | hard-kill 当前 Worker；后续 cell 创建新 generation。 |
| hard kill 后第一次真正 dispatch | 返回 namespace restart notice，明确上一 generation 的 bindings 已丢失。 |
| active Realm 数达到上限 | 先回收最久未使用的 idle Realm；没有 idle 候选时拒绝新 Realm admission。 |
| runtime dispose | 停止 admission，取消队列，终止并等待全部 Worker 与 host 调用。 |

idle Worker 不阻止 host 退出，并在 `maxIdleMs` 后回收。一次 hard kill 只计一次 generation 变化；尚未真正进入 Worker 的调用不会错误消费 namespace-loss notice。

## Agent 编排与文件交接

Prime preset 复用 DSH 的 continuable Subagent 架构：

- `subagent` 与 `subagent_fork` 配置为 `backgroundMode: continuable`。省略 `run_in_background` 或传 `true` 时，在 child inbox 接受初始消息后立即返回持久 child id，不等待该轮完成。
- `list_agents` 列出可继续的直接 child 或后代；`ready` 表示只存在于持久存储、可恢复，不表示有结果待收集。
- `send_message` 给直接 child 排入一个后续 FIFO turn；child 不驻留时由 DSH 从 Session persistence 冷恢复。
- `interrupt_agent` 只中断目标当前 turn，保留排队消息、child 身份和已发布后代。
- child 的 `report` 只投递给直接 parent。官方 `next-step` 调度让运行中的 parent 在最近 step 消费，并唤醒空闲 parent；report 不结束 child turn。
- DSH 自有的 settled notice 独立于 child 是否主动 report，负责说明一次 Activation 如何结束。

continuable child 没有 Job result promise：其详细过程保存在 child Session，选定结论通过 report 返回。当前没有 child delete，也没有把 child transcript 作为单个结果 collect 的工具。

Jobs 是另一条生命周期：后台 shell 和使用 one-shot background provider 的工作返回 Job id，并由 `job_output`、`job_list`、`job_kill` 管理。Job 与 continuable child id 不可互换。

慢任务和独立任务采用非阻塞控制循环：先由 managed Job 或 continuable child 接受工作，保存 id 或输出位置，再继续不依赖结果的父任务；没有独立工作时结束当前 turn，等待 report、settlement notice 或后续调度。policy 禁止用 `sleep`/`setTimeout` 轮询或长阻塞 `await` 占住 cell/turn。直接面向用户的 root 在多回合、计划型或多 child 工作中按有意义里程碑汇报结果、阻塞和下一步；subagent child 不注入这条用户进度规则，仍通过 `report` 面向 parent。

未显式覆写时，child 继承 parent Session 的工作目录，并基于 parent preset 组合自己的 Agent scope；child 级 allow/deny 仍可进一步收窄工具。跨 Agent 的大材料按 policy 走 handoff file：

1. 父把材料序列化到一个工作区文件，spawn prompt 只携带任务、路径以及每个 key 的摘要和规模。
2. child 按需读取、在程序内归约，把完整结果写入另一个文件。
3. child report 只携带可执行结论和结果路径。
4. 没有 child 再需要时删除交接文件。

handoff file 是写入时刻的快照；“写后不改”由 policy 约束，不由 runtime 强制。共享工作区没有 Capsule 级访问控制，文件路径也不是授权凭证。

## Continual Harness

`prime_refine` 是控制面之后的次级学习层，当前接口只有：

- `inspect`：读取 scope 的 revision、entries 与近期 transactions。
- `apply`：提交带 trigger、具体 evidence、可验证 expected outcome 与最小 edits 的事务。
- `rollback`：在目标事务的所有输出都未漂移时恢复 before snapshots。

apply 与 rollback 都要求调用方先 inspect，并携带 `expected_revision`；磁盘锁内再次检查 revision。每笔事务保存 before/after，历史有界保留。skill/subagent entry 必须引用调用时真实可见的工具，不能把 `run_code` transport 当作 SDK member。

local state 以 Session id 的 SHA-256 摘要命名。`allowGlobalRefinement` 默认为 false，此时 global inspect 和 mutation 都拒绝；启用后使用单一 `global.json`。当前 apply 是直接写入事务，没有 proposal/review 阶段、自动效果观察或 global 人工批准流程。

进入 prompt 的 entry 是有界、JSON 引用的非可信建议。它不能替代基础 system prompt，也不能覆盖当前 user 指令、权限、sandbox 或工具约束。任务数据、研究材料、执行进度和大上下文不属于 Continual Harness。

## 状态布局

```text
<stateDirectory>/
├─ realm-identity/
│  ├─ hmac.key
│  ├─ sessions/<keyed-session-path>.json
│  └─ leases/<realm-id>.lease
└─ continual/
   ├─ global.json
   └─ sessions/<sha256-session-id>.json
```

Realm heap、child Session、Job 和工作区 handoff files 不存放在上述插件私有目录：前者是 Worker 内存，child/Job 由 DSH 持有，handoff files 属于任务工作区。

identity 与 continual 文件使用跨进程锁和原子替换；损坏、超限和 revision 冲突明确失败。多个 host runtime 可以共享一个 `stateDirectory`。认证成功后，runtime 在创建 live heap 前惰性取得该 Realm 的进程 lease：不同 Session/Realm 可由不同 TUI 同时运行；同一 Realm 已被其他存活进程持有时明确拒绝，不降级为 one-shot。idle/LRU 回收会先完整终止 Worker，再释放该 Realm 的 lease；旧 Worker 完全终止前，其他进程不能创建同一 Realm 的第二份 heap。记录的 owner pid 被明确证明不存在时，stale lease 可由下一 host 回收；PID 已复用或 liveness 不可判定时保守拒绝，避免生成第二份 heap。崩溃若遗留 `*.lease.lock`，操作者须确认对应 Session 无存活 host 后再清理。

Host runtime 在模块加载时冻结启动宿主的直接父 pid，并立即开始监控。macOS/POSIX 上父进程退出后发生的 reparent，以及 Windows 上父 shell 被强制终止但子进程继续存活，都会触发同一条根级清理路径：停止监控，dispose 整个 Cordis tree，等待 Realm Worker 终止，再释放该 host 持有的 Realm leases，随后以 0 退出；根级 dispose 未在 5 秒内结算则以非零状态强制退出。父 pid 为 init 或当前进程时不安装监控；探测结果不能证明父进程消失时保持运行，避免误杀合法宿主。

## 配置界面

Agent-scope `dsh-prime-agent`：

| 配置 | 默认值 | 作用 |
| --- | --- | --- |
| `stateDirectory` | 必填 | Realm identity 与 continual state 根目录。 |
| `refineToolName` | `prime_refine` | Continual Harness 工具名。 |
| `allowGlobalRefinement` | `false` | 是否允许 global harness 读取和写入。 |
| `requireCodeMode` | `true` | 是否强制模型只看见 `run_code`。 |
| `requireOrchestrationTools` | `true` | 是否在 prompt assembly 时检查可见 Subagent admission 与 `job_output`。 |
| `continual` | 有界默认值 | entry、evidence、transaction、状态文件和 prompt 预算。 |

Host-scope `dsh-prime-agent/runtime` 透传官方 `computeMs`、`maxWallMs`、`maxOutputBytes`、`maxOldGenerationSizeMb`，并增加 `maxActiveRealms`、`maxIdleMs`、`maxHostCallsPerRun`、`maxParallelHostCallsPerRun`。

runtime row 与 Prime preset 的 `stateDirectory` 必须相同，否则 handshake 两侧读取不同 HMAC key，所有 Prime 请求都会 fail closed。

## 当前契约边界

- Worker 隔离不是安全 sandbox；真正的文件和命令权限由 DSH host 工具与 sandbox policy 决定。
- live namespace 不跨 Worker generation 或 host restart 持久化，也不自动重放历史 cell。
- 不支持未受 DSH 管理、跨 cell 持续调用工具的 detached async work。
- Host runtime 属于启动它的直接父进程；不支持有意脱离该父进程作为 daemon 继续运行。
- cell 内原生 dynamic `import()` 没有 import callback，会明确失败；外部能力通过 DSH tools 使用。
- 不提供 IPython/Jupyter backend、在线 Realm reset、Context Capsule store、`share`/`mount` 或父子文件授权。
- 不提供 continuable child delete 或 transcript collect。
- 不提供 per-spawn child reasoning-level 参数；该能力需要 DSH Subagent 原生拥有继承、resolved-model 校验、持久化与冷恢复。
- 本插件不拥有 spill artifact 的配额、保留期或清理；当前 local backend 可随超限结果持续增长，生命周期治理必须由 DSH spill store/部署层提供。
- Continual Harness 不自动生成 proposal，不包含 review/apply 分离流程，也不自动建议或执行 rollback。
- 插件不创建 Agent registry、消息总线、Session store、Job registry、Goal driver、Workflow engine 或 Compaction 实现。

## 验证面

仓库测试覆盖：Realm identity 并发签发与认证、多个 host 共享状态、同 Realm 跨进程互斥与接管、Session 隔离、跨 cell binding 连续性、调用顺序、binding lease、host-call 预算、超时/abort/Worker 换代、namespace-loss notice、输出上限与 Unicode、工具失败恢复、approval escalation、Subagent Job 编排、官方 report 组合边界、preset 落位和 bundle patch 结构。

上游行为映射与同步流程见 [Prime Agent 学习笔记](prime-agent-learnings.md) 和 [上游同步与差异对照手册](upstream-sync.zh.md)。
