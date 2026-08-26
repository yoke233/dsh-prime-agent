# dsh-prime-agent 当前架构

## 文档范围

本文只描述仓库当前已经实现并随包交付的架构，不记录版本路线、未来阶段或候选设计。代码、`agent-presets/prime/agent.cordis.yml` 与 `cordis.patch.yml` 是最终事实来源。

`dsh-prime-agent` 在 DeepSeek Harness（DSH）之上提供一个 RLM-first 控制面：Prime Session 通过唯一模型可见的 `repl` 工具（参数 `{ code }`）使用持久 TypeScript Realm，普通 Session 继续使用 DSH 官方 one-shot Code Runtime。插件复用 DSH 的 Agent、Subagent、Jobs、权限、日志和 Session 生命周期，不创建第二套 Agent Loop。

## 领域术语

| 术语 | 当前含义 |
| --- | --- |
| Session | DSH 持有的会话身份与持久事件日志，是 Realm、child 和 local learning state 的归属键。 |
| Realm identity | 由 Session 稳定映射得到的不透明 id，用于把同一 Session 的 Prime cell 路由到同一个 Realm。 |
| Worker generation | 一个 Realm 当前活着的 Worker Thread。hard kill 后会换代，旧 live namespace 永久丢失。 |
| live namespace | Worker generation 内跨 cell 保留的普通顶层变量、函数、对象、Map 和索引。它不是持久存储。 |
| cell / run | 一次 `repl` 调用。一个 Realm 同时只执行一个 cell。 |
| binding lease | 当前 cell 对 DSH 工具 binding 的临时调用权；cell 结束即撤销，保留下来的旧 wrapper 不能越轮调用工具。 |
| Realm ownership lease | 一个 Realm 的跨进程 live-heap 所有权；不同 Realm 不互斥。 |
| continuable child | 由 DSH 持久化、可接收后续消息并可冷恢复的子 Agent。其 id 不是 Job id。 |
| Job | DSH 的通用后台任务。它有 `job_output`/`job_list`/`job_kill`；continuable child 不通过 Job 收集结果。 |
| handoff file | 父子 Agent 在共享工作区传递大材料或结果的普通文件。只写一次是 policy 约定，不是文件系统授权。 |
| harness entry | `refine` 注入 prompt 的一条有界、非可信建议记录。 |
| refinement transaction | 对 harness entries 的一次 apply 或 rollback 审计记录。 |

“Agent Family”只描述 DSH 持有的直接父子关系和后代树，不表示本插件拥有独立 family registry。“Context Capsule”不是当前运行时对象；当前跨 Agent 上下文原语是 handoff file。

## 系统组合

```text
DSH profile
├─ cordis.patch.yml（纯插入）
│  ├─ 官方 code-runtime row（原样保留）
│  │  └─ 非 Prime 会话 ─────────────→ 官方 one-shot Worker
│  ├─ dsh-prime-agent/runtime（prime-code-runtime）
│  │  └─ primeRealmRuntime 服务
│  │     ├─ Realm identity ← 可信 exec.agent.id（Agent scope 解析）
│  │     └─ Realm pool ──→ persistent Worker
│  └─ 官方 tool-subagent-report（next-step）
│
└─ Prime Agent scope
   ├─ agent-presets/prime（独立 agent-plane 组合）
   └─ dsh-prime-agent
      ├─ 唯一模型可见工具 repl（参数 { code }）
      ├─ cell 内隐藏绑定 tools / agents / jobs
      ├─ cell 内组合工具 apply_patch（Codex 兼容 Add/Update）
      ├─ control-plane policy（Persistent REPL guidance）
      └─ refine
```

包有两个运行入口：

- `dsh-prime-agent`：Agent scope 内的 `repl` 工具注册、Realm 身份解析、control-plane policy、continual learning 与 prompt assembly（模型 catalog 只保留 `repl`）。
- `dsh-prime-agent/runtime`：host scope 内的 `primeRealmRuntime` 服务、Realm pool、按 Realm 的进程 lease、父进程生命周期监控与 Prime preset 落位；官方 `code-runtime` row 完全不动。

## 安装与 preset

随包 `cordis.patch.yml` 只执行一个操作：把 `dsh-prime-agent/runtime` 作为新 row 纯插入。官方 `code-runtime` row 原样保留——Prime 包不替换它、不携带也不挂载 one-shot fallback，非 Prime 会话继续由宿主官方 runtime 按官方语义处理。该 host row 注册唯一命名的 `primeRealmRuntime` 服务、监控直接父进程并在启动时落位 Prime preset。

Subagent report 完全复用 DSH 0.1.1-rc.2 base bundle 的官方 `tool-subagent-report`。其默认 `next-step` 调度通过 `parent.steer()` 让运行中的 parent 在最近 step 消费报告，并唤醒空闲 parent；continuation manager 同时负责唤醒记账以及 report 先于后续 settled notice 的 FIFO 顺序。本包不再替换或复制该能力。

runtime 启动时把随包 Prime preset 复制到 `$DSH_HOME/.agent-presets/prime`，仅在目标目录不存在时写入。已有目录永不覆盖；要采用新快照必须由操作者删除旧目录后重启。

默认 preset、默认 tools mode 与其他 preset 不会改变。

## 唯一模型控制面

Prime Agent scope 的模型 catalog 只含一个执行工具 `repl`。prompt assembly 先走完整流程，再在 next() 之后把 tools 列表过滤到只剩 `repl`；`refine`、Subagent、Jobs、文件系统、MCP 及其他工具不进入模型 schema，只作为 cell 内预加载的隐藏绑定出现。模型直接调用 `repl` 之外的任何工具都会被 guard 拒绝（提示 “use the repl tool for this session”）；组合不满足该不变量时，assembly 明确失败。

`repl` 的参数是单个 `code` 字符串。插件把官方“一次 async 函数”说明改写成持久 REPL cell 说明：

- 支持顶层 `await`。
- cell 的末尾表达式是结果，顶层 `return` 无效。
- 普通顶层 binding 留在同一 live namespace，供后续 cell 直接使用。
- cell 内预加载三个绑定命名空间：`tools.*`（当前 Agent catalog 中除 `repl` 外的全部工具）、`agents.*`（`spawn`/`fork`/`list`/`send`/`interrupt` → `subagent`/`subagent_fork`/`list_agents`/`send_message`/`interrupt_agent`）、`jobs.*`（`list`/`output`/`kill` → `job_list`/`job_output`/`job_kill`）。程序始终得到 canonical value，SDK 从当前 catalog 生成真实 `ToolOutputMap`；对象结果若未经转换直接成为 completion，Worker 才用关联的官方 content 展示。SDK 同时声明 `$_`、`$out(id)`、`$out.list()/drop(id)/clear()`；这些能力不可作为外层工具直接调用。
- 固定 Agent 文案只教授 persistent TypeScript、已解析工具值、生成返回类型、completion intrinsics、preview 不可解析、Windows 路径优先 `/` 与紧凑 live 工作集；不拼接用户聊天、具体任务、仓库路径、历史失败或可选工具名。
- 必须跨 Worker 或 host 重启保存的进度写入工作区文件。

Prime 不增加搜索 provider。源码发现仍调用 DSH 原生 `grep`；生成 SDK 只在 Realm interface 将 `grep.pattern` 扩展为 `string | RegExp`。Worker 使用启动时捕获的原生 getter 把无 flags 的真实 `RegExp` 投影为 `.source`，再按 lossless JSON 进入 Host binding seam；带 flags 或伪造的 exotic value 明确失败，DSH schema、授权、执行与日志路径不变。

MCP 同样不进入 Realm runtime。profile 显式安装 DSH Host MCP client 后，server tools 注册到统一 `ctx.tools` catalog，repl 单元自动获得对应 `tools.*` 绑定；连接、认证、重连、工具代际、子进程与清理由 Host 插件拥有。本插件不复制上游的 Python kernel-owned MCP 或 ACP MCP program。

### 本地 `apply_patch` 组合能力

`dsh-prime-agent` 在 Agent scope 注册 `apply_patch`，因此它会进入 Realm 自动生成的 `tools.*` SDK，但外层 prompt assembly 仍只暴露 `repl`。该工具不是新的文件系统 provider：parser 与 planner 在本地纯计算层对齐 Codex patch grammar 与默认 `NormalizeToLf` 文件更新算法；支持 marker 周边空白、heredoc wrapper、Environment ID、重复路径的顺序规划、EOF 和纯追加，并按 exact、忽略行尾空白、忽略首尾空白、Unicode 标点/空格归一化的顺序选择首个匹配。parser 只额外拒绝 NUL 路径；相对路径、绝对路径及包含 `..` 的路径均原样交给当前 Agent catalog 中正式的 DSH `read` / `write`，由 owning Session 的文件能力解析并授权。nested dispatch 通过 `ctx.tools.execute(...)` 转发 owning Agent、parent token、root call id 与取消信号，DSH 继续拥有 Session cwd、sandbox、approval、observation、日志和单文件原子发布。

当前组合层支持 `*** Add File` 与 `*** Update File`，且 Add 与 Codex 一样可覆盖已有文件；Delete/Move 在 planning 阶段明确失败。所有目标先完整读取并完成 Codex 风格 hunk 定位，之后才发生第一次 write，因此 parse、路径、读取或 planning 失败没有文件副作用。正式 `read` 的 canonical 行 DTO 不携带原始换行 metadata，executor 会把快照规范化为 LF；更新后的非空文件按 Codex 默认模式补齐末尾 LF。

多文件写入是按 patch 顺序执行的多个正式 DSH `write` 调用，不是 batch transaction。后续 write 失败时工具返回 `PARTIAL_APPLY` 并列出此前成功路径，不伪装成成功，也不宣称自动回滚或 crash-atomic。当前 DSH 没有受策略保护且可组合的 delete/rename seam，因此本插件不通过 Node `fs`、shell、`git apply` 或空文件写入模拟这些操作。

`apply_patch` 在工具定义 seam 上实现标准 `DiffCallView` / `DiffResultView`。调用阶段从 patch 解析出按文件、按 hunk 排列的 `{ path, oldText, newText }` 与可打开位置；成功结果优先使用持久化 `presentationMeta`，nested dispatch 没有 result metadata 时从同一 durable patch 参数重建等价视图。Prime REPL bridge 不发明独立 UI metadata，而是与官方 `run_code` 一样，在真实开始与结算时写入 `tool/code-dispatch-start` / `tool/code-dispatch`，携带 root/parent/sub-call identity、JSON arguments、`content` 与 `isError`。官方 Web 直接把这些事件折叠成递归 `subCalls`；TUI 通过同一协议和工具 presenter 渲染。失败、旧日志或无法解析的参数仍走 generic error fallback，绝不把失败意图渲染成已应用差异。

`edit` 仍保留：它的窄 interface 对一次 literal replacement 更省 token、更容易审阅，也能保持 `old_string` 唯一匹配约束；`apply_patch` 用于相关的多 hunk 或多文件 Add/Update。`write` 只用于有意替换完整文件。模型 policy 按这三个粒度选择工具，不做 alias 或兼容 shim。

## Realm 身份路由

`repl` 的执行路径不使用握手，也没有任何模型可见的身份工具：

1. 工具执行要求存在 owning Agent 会话（`exec.agent`）；缺少可信 Agent/Session 执行上下文时直接失败。
2. Agent scope 用可信的 `exec.agent.id` 作为 session owner，从共享 `<stateDirectory>/realm-identity` 存储解析该会话稳定的不透明 Realm identity（首次访问时生成并持久保存）。
3. 插件为本次 cell 构建 per-run 租约绑定（`tools`/`agents`/`jobs`），并把 Realm id、程序、绑定与 abort signal 交给 host 侧的 `ctx.primeRealmRuntime.run(...)`。
4. host 服务按 Realm id 在跨进程 lease 下准入对应 Realm：不同 Session/Realm 可由不同进程同时运行；同一 Realm 已被其他存活进程持有时明确拒绝，不降级。
5. 无法解析出 Realm id、命名了不可用的 Realm id，或缺少可信执行上下文时 fail closed——明确报错，不路由到任何其他 runtime，也没有 one-shot fallback。

每个 Session 的随机 Realm identity 持久保存；原始 Session id 只参与 keyed path/HMAC framing，不进入文件名。

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
- 模型 schema 中没有身份或引导工具；worker 仍按保留名 `prime_realm_identity` 过滤租约成员作为纵深防御，但该名称不再注册，也永不进入模型 prompt。

每个 cell 同时受 host-call 总量和并发量限制，超限调用被拒绝，不扩大权限。

### 完成值、日志与大输出

Worker 通过 Inspector 取得 cell 的末尾表达式并执行一次有界分类：lossless JSON 完成值走序列化 history，Map、Set、函数、BigInt、循环对象和 class instance 等非 JSON 值走 generation-local opaque history。日志与 Realm → Host 的 completion value 共同受 `maxOutputBytes` 硬上限约束。工具 binding 在 Host 侧把 canonical value 与可选官方 content 放入仅供 Worker 解包的内部结果；程序只得到 canonical value，Worker 以私有 WeakMap 关联对象 identity 与展示文本。

完成值本身由 runtime 自动保留在 generation-local 的 completion history 中，模型优先通过 `$_` 读取最近已保留结果，只有访问较早结果时才使用 `$out(N)`；`$out.list()/drop(id)/clear()` 提供管理操作。`maxCompletionFullBytes`（默认 64 KiB）以内的完成值原样返回，超过后 Worker 仍产生固定 schema 的有界内部 envelope。Realm 在验证 terminal nonce 与 envelope shape 后才附加 discriminated `ReplPresentation`：retained preview 携带有效 handle，unretained preview 不携带 handle，opaque reference 不携带结构 projection；用户程序伪造旧 envelope 同形对象没有可信 metadata，仍是普通 JSON。降级链是 full → rich projection → minimal reference → output-limit，只有连最小内部引用都放不进剩余预算时才真正失败。捕获遍历带早退：越过 `max(maxCompletionHistoryEntryBytes, maxCompletionFullBytes)` 的值不再被完整走查，因此其超出边界的部分不做 lossless 校验，而 history 保留的是原对象引用、不是快照。handle 由 host 全局单调分配、绝不复用，hard-kill 后旧 handle 明确抛 `CompletionExpiredError`。opaque history 使用独立预算（默认 8 项、估算 8 MiB、262144 nodes）和独立 FIFO，不会挤占 lossless JSON history；`$_`/`$out(N)` 返回原对象 identity，分类过程不调用用户 `toJSON`、`toString` 或 inspect hook。

外层 `repl` canonical value 保持结构化：`logs`、可选 `result` 和可选可信 `presentation` metadata 仍可由调用方程序化读取。模型 renderer 不再 `JSON.stringify({ logs, result })`：logs 和 scalar string 原样显示，full structured value 只 pretty-print 一次；retained preview 首先提示 `$_`、再给历史 `$out(id)`，unretained preview 不显示 handle，opaque reference 不调用用户 hook，无 logs 且无 completion 时返回空文本。renderer 不添加普通结果类型标题或 Markdown fence。preview 是观察文本而非可解析数据，后续计算必须回到命名变量、`$_` 或 `$out(id)`。

工具调用的 canonical value、官方 content、日志与 spill locator 仍由 DSH 工具层管理。Prime binding 始终把 canonical value 返回给程序；非空官方 content 只与对象 identity 关联，并仅在该对象直接成为 completion 时替代其模型展示。提取字段、spread 或其他转换产生的新值继续走普通 completion 路径；primitive canonical value 保持原值。Prime preset 为模型可见的工具结果配置 12KB best-effort spill 阈值，超过预算时 spill artifact 保存完整 notebook renderer 文本并按需读取。store 缺失、保存失败或 notice 无法放进预算时，策略保留完整 inline 成功结果并告警，不伪造 locator。这个预算不限制 Realm heap，也不等于上游 IPython 的 snapshot pruning；Realm 不复制 DSH 的 spill 或工具日志存储。

控制面 policy 只在全部结果都必需时建议 `Promise.all`；独立 best-effort 探测使用 `Promise.allSettled` 或逐项捕获 `ToolCallError`，同时检查失败并重新抛出意外错误。这些是模型侧编排约定，不改变 DSH 工具失败或 Realm partial-commit 语义。

### 失败与换代

| 情形 | 当前结果 |
| --- | --- |
| 语法错误 | cell 不执行，namespace 不变。 |
| 普通程序异常或被程序捕获的工具失败 | 当前 cell 失败或由程序处理；Worker generation 保留。未捕获异常只投影简洁 message，不暴露 Worker/V8 内部调用栈。异常前已经完成的声明、赋值和外部副作用可能保留，遵循 REPL partial-commit 语义。 |
| completion 序列化失败 | cell 已执行且 namespace 保留，当前结果以 invalid output 失败；判定范围以有界走查为界，超出捕获天花板的部分不校验。 |
| completion 过大 | cell 成功；外层 canonical value 保留有界内部 envelope 与可信 presentation metadata，模型只见 notebook preview。原值按 history 预算保留；未通过准入时不提供 handle，也不暗示 `$_` 可取回原值。 |
| 排队 cell 在 dispatch 前取消 | 只取消该 cell。 |
| active abort、compute/wall timeout、输出失控、Worker exit、OOM 或控制协议违规 | hard-kill 当前 Worker；后续 cell 创建新 generation。 |
| hard kill 后第一次真正 dispatch | 返回 namespace restart notice，明确上一 generation 的 bindings 与保留结果已丢失。 |
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

`refine` 是控制面之后的次级学习层。模型侧显式工具接口包括：

- `inspect`：读取 scope 的 revision、entries 与近期 transactions。
- `apply`：提交带 trigger、具体 evidence、可验证 expected outcome 与最小 edits 的事务。
- `rollback`：在目标事务的所有输出都未漂移时恢复 before snapshots。

apply 与 rollback 都要求调用方先 inspect，并携带 `expected_revision`；磁盘锁内再次检查 revision。每笔事务保存 before/after，历史有界保留。skill/subagent entry 必须引用调用时真实可见的工具，不能把 `repl` transport 当作 SDK member。

人类侧 `/refine [--local|--global] [instructions]` 通过 DSH `ctx.commands.register` 注册。handler 使用 `Agent.runMaintenance` 与普通 turn 串行，按 `session.requestHeader()?.config`、再按 `agent.options` 复用 provider/model；它只向 `ctx.llm.stream()` 发送有界、图片已投影的文本会话尾部、当前 scope 摘要和可选指令，不开放工具。输出必须是 JSON proposal；截断、取消、非 stop、JSON/shape 错误或 revision 冲突全部 fail closed。空 edits 不落盘，非空 edits 走同一个 `HarnessStore.apply`。`/refine rollback <transaction-id> [--global]` 直接复用 `HarnessStore.rollback`。插件卸载先注销命令，再 drain 已开始的调用。

local state 以 Session id 的 SHA-256 摘要命名。`allowGlobalRefinement` 默认为 false，此时 global inspect 和 mutation 都拒绝；启用后使用单一 `global.json`。手动 `/refine` 会生成 proposal 并在校验后直接提交，没有单独的人类 review 阶段、自动效果观察或 global 人工批准流程；auto-refine 仍未启用。

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

identity 与 continual 文件使用跨进程锁和原子替换；损坏、超限和 revision 冲突明确失败。多个 host runtime 可以共享一个 `stateDirectory`。身份解析成功后，runtime 在创建 live heap 前惰性取得该 Realm 的进程 lease：不同 Session/Realm 可由不同 TUI 同时运行；同一 Realm 已被其他存活进程持有时明确拒绝，不降级为 one-shot。idle/LRU 回收会先完整终止 Worker，再释放该 Realm 的 lease；旧 Worker 完全终止前，其他进程不能创建同一 Realm 的第二份 heap。记录的 owner pid 被明确证明不存在时，stale lease 可由下一 host 回收；PID 已复用或 liveness 不可判定时保守拒绝，避免生成第二份 heap。崩溃若遗留 `*.lease.lock`，操作者须确认对应 Session 无存活 host 后再清理。

Host runtime 在模块加载时冻结启动宿主的直接父 pid，并立即开始监控。macOS/POSIX 上父进程退出后发生的 reparent，以及 Windows 上父 shell 被强制终止但子进程继续存活，都会触发同一条根级清理路径：停止监控，dispose 整个 Cordis tree，等待 Realm Worker 终止，再释放该 host 持有的 Realm leases，随后以 0 退出；根级 dispose 未在 5 秒内结算则以非零状态强制退出。父 pid 为 init 或当前进程时不安装监控；探测结果不能证明父进程消失时保持运行，避免误杀合法宿主。

## 配置界面

Agent-scope `dsh-prime-agent`：

| 配置 | 默认值 | 作用 |
| --- | --- | --- |
| `stateDirectory` | 必填 | Realm identity 与 continual state 根目录。 |
| `refineToolName` | `refine` | Continual Harness 工具名（可配置）。 |
| `allowGlobalRefinement` | `false` | 是否允许 global harness 读取和写入。 |
| `refinementMaxTokens` | `4096` | `/refine` 辅助模型请求的最大输出 token。 |
| `refinementMaxConversationChars` | `80000` | `/refine` 会话尾部文本预算。 |
| `requireOrchestrationTools` | `true` | 是否在 prompt assembly 时要求 Agent catalog 具备 Subagent admission（`subagent`/`subagent_fork`）与 `agents`/`jobs` 控制（`list_agents`、`send_message`、`interrupt_agent`、`job_output`、`job_list`、`job_kill`）。 |
| `continual` | 有界默认值 | entry、evidence、transaction、状态文件和 prompt 预算。 |

Host-scope `dsh-prime-agent/runtime` 透传官方 `computeMs`、`maxWallMs`、`maxOutputBytes`、`maxOldGenerationSizeMb`，并增加 `maxActiveRealms`（默认 8）、`maxIdleMs`（默认 600000）、`maxHostCallsPerRun`（默认 200）、`maxParallelHostCallsPerRun`（默认 16），以及 completion history 与投影的六个上限：`maxCompletionHistoryEntries`（默认 16）、`maxCompletionHistoryEstimatedBytes`（默认 32 MiB）、`maxCompletionHistoryNodes`（默认 1,000,000）、`maxCompletionHistoryEntryBytes`（默认 8 MiB）、`maxCompletionFullBytes`（默认 64 KiB）、`maxCompletionProjectionBytes`（默认 4 KiB）。

runtime row 与 Prime preset 的 `stateDirectory` 必须相同，否则身份记录与 lease 目录不一致，所有 Prime 请求都会 fail closed。

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

仓库测试覆盖：Realm identity 稳定解析与持久化、多个 host 共享状态、同 Realm 跨进程互斥与接管、Session 隔离、跨 cell binding 连续性、调用顺序、binding lease、host-call 预算、超时/abort/Worker 换代、namespace-loss notice、completion history 预算、输出上限与 Unicode、工具失败恢复、approval escalation、Subagent Job 编排、官方 report 组合边界、preset 落位和 bundle patch 结构。

Prime REPL 的固定提示、completion metadata 与 notebook renderer 契约见 [Prime REPL Notebook 呈现规格](repl-notebook-presentation.zh.md)；上游行为映射与同步流程见 [Prime Agent 学习笔记](prime-agent-learnings.md) 和 [上游同步与差异对照手册](upstream-sync.zh.md)。
