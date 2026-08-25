# 上游 Python / Node 适配差距修复计划

## 1. 目标

以 Prime Agent Python RLM 的可观察行为为参照，在不复制 DSH 已拥有的 Agent Loop、Session、Subagent、Jobs、Goal、Compaction、Schedule 或 MCP runtime 的前提下，修正本插件已经承诺但没有正确验证或覆盖的行为，并缩小 Persistent TypeScript Realm 与 IPython REPL 的关键语义差距。

完成标准：

1. Prime 编排能力在 system-prompt assembly 时按真实能力集合 fail-fast。
2. shipped preset 的 continuable child 路径有行为级回归测试，而不是只验证 policy 文本或 one-shot Job。
3. 非 lossless-JSON 的成功 completion 不再被误报为 cell 失败；活对象可通过 generation-local handle 继续寻址。
4. handoff policy 只对大材料、结构化快照或需要耐久性的材料要求文件，不强迫小型委派写 JSON 文件。
5. 明确 Prime RLM Mode 的模型契约、所有权边界、不采用方向和迁移门槛，不再把目标描述成‘generic Code Mode 加更多 policy’。
6. 文档准确区分已交付能力、DSH-owned 能力和仍待上游支持的能力差距。
7. src/ 与生成的 lib/ 同步，npm run check 通过，最终 diff 无无关改动。

## 2. 当前问题

### 2.1 编排能力校验错位

上游 rlm.run() 返回 admission handle，后续由 family registry、消息和取消能力管理。当前 src/policy.ts 只要求 subagent/subagent_fork 与 job_output，却在同一 policy 中要求模型使用 list_agents、send_message、interrupt_agent。这允许不完整的 continuable 部署通过 assembly，也把 continuable child 与 Job 错误绑定。

### 2.2 shipped continuable 路径没有行为测试

agent-presets/prime/agent.cordis.yml 使用 backgroundMode: continuable；现有 tests/orchestration.spec.ts 的后台测试使用 backgroundMode: one-shot 并以 job_output 收集结果。需要覆盖 admission id、roster、follow-up、interrupt、report/settlement 顺序和恢复边界。

### 2.3 completion 语义偏离 REPL

IPython Out 可保存活对象。当前 Realm 的 prepareCompletion() 在最终表达式为 Map、Set、BigInt、函数、循环对象或 class instance 时返回 invalid-output，且不创建 history slot。正确边界应是“跨 Worker wire 的投影必须是 lossless JSON”，而不是“原始活对象必须是 JSON”。

### 2.4 policy 对 handoff 过度约束

上游 rlm.run(prompt, **kwargs) 允许有界、自包含材料直接随 prompt 发送。当前 policy 要求所有 material 先写 JSON handoff file。文件交接应服务于大材料、二进制、多文件快照和跨重启耐久性，而不是成为所有委派的前置成本。

### 2.5 能力声明超过实际交付

上游 Python 已提供 heartbeat CRUD、family messaging/observation、主动 compaction status/run。当前文档把 Heartbeat/Schedule 与 Compaction 简写为“已映射”，但 shipped Prime preset 没有 schedule tools，也没有模型可调用的 compaction status/run。Family sibling/broadcast/recent messages 同样尚无 DSH 原生对应物。

### 2.6 把 notebook 误当成 tool wrapper

当前实现虽然具备持久 Realm，但模型体验仍主要由 generic Code Mode SDK 和不断增长的操作规约定义。简单读、搜、改也容易被引导成参数包装、并行分类、handoff 和错误流程设计。Python Prime 的单一 `ipython` 入口之所以不构成同类限制，是因为它首先提供完整 notebook，再把 host 能力变成环境内的普通调用。若只继续扩充 policy，而不重定义模型侧模式，语义差距会随着工具数量增长。

## 3. 模式结论：Prime RLM Mode

### 3.1 从 Python Prime 应学习什么

重新对照以下上游实现：

- `../prime-agent/packages/coding-agent/docs/rlm.md`
- `../prime-agent/packages/coding-agent/docs/rlm-runtime.md`
- `../prime-agent/packages/coding-agent/src/core/prompts/rlm.ts`
- `../prime-agent/packages/coding-agent/src/core/tools/ipython.ts`
- `../prime-agent/prime-agent-runtime/src/rlm/__init__.py`

上游的关键不是 Python 语法，也不只是“模型只能看到一个 `ipython` 工具”，而是该工具提供了一个低摩擦、长期存在、可检查、可组合的 notebook：普通文件操作、搜索、数据变换、项目命令、Python skill 和 `await rlm(...)` 都是环境中的自然语言级操作；变量、函数、对象和 admission handle 可以直接留在 namespace 中。TypeScript host 仍拥有 provider、Session、child lifecycle、Schedule、Goal、Compaction 和安全策略。

因此，应学习的是下面的产品语义：

1. **唯一入口是能力，不是惩罚。** 单一模型可见工具应换来完整的通用计算环境和更少的决策分叉，而不是要求每个简单动作承担额外编排仪式。
2. **先是 notebook，后是 tool gateway。** 模型在语言环境里自然读、算、筛、改、调用和委派；host bridge 是效果边界，不应成为主要认知对象。
3. **活状态是一等公民。** 中间对象、函数、索引、结果和任务 handle 应可留在 namespace 中并被后续 cell 寻址；只有跨 Worker、跨 Session 或持久化时才需要投影和文件。
4. **生命周期归 host。** notebook 负责编程体验，DSH 继续拥有权限、工具执行、Subagent、Jobs、Goal、Compaction、Session event 和恢复。
5. **policy 只描述不变量。** 常用路径应由 API 形状自然表达；罕见错误恢复、工具细节和专项流程按需展开，不应全部常驻 system prompt。

### 3.2 推荐模式

本项目直接实现专用的 **Prime RLM Mode**，不再把 Prime 定义为“DSH shipped Code Mode 的完整快照，再叠加一份很长的 policy”。Prime preset 关闭默认 Code Mode，删除模型可见的 `run_code`，只注册本插件拥有的 `repl` 工具；底层继续使用 Persistent TypeScript Realm。允许破坏现有 Prime preset、工具名、协议和状态兼容，不保留双轨迁移层。

> 模型只看到 `repl`：执行一个持久 TypeScript REPL cell。纯计算和活对象留在 REPL；文件、命令、网络、Agent 与其他副作用通过预加载 API 执行。工具名和描述不出现 Prime、RLM、brokered、Realm、host bridge 等实现术语。

“brokered”是与 Python 上游有意保留的差异。Python kernel 可以用 worker OS 权限直接访问文件和 shell；DSH 不应为了模仿 IPython 而把 `fs`、`child_process`、网络或凭据直接开放给 Realm。所有外部效果继续经过 DSH 工具权限、sandbox、approval、审计和生命周期管理。Worker 隔离仍不宣称为安全 sandbox。

Prime preset 不允许 native tool calling、`run_code` 与 `repl` 并存。模型 catalog 中只能出现 `repl`；其他 DSH 工具是 host-callable capabilities，不直接进入模型 schema。双入口会迫使模型在每一步选择调用路径、拆散 Realm state，并使 compaction、错误和审计出现两套语义。非 Prime preset 继续使用 DSH 官方模式，不挂载 `repl`。

### 3.3 模型侧契约

`repl` 的稳定输入只包含 `code: string`。展示标题由 host 从 cell 生成，不要求模型填写 description；Session、identity、权限上下文和 binding lease 必须来自可信 tool execution context，也不能由模型作为参数指定。输出是结构化的 stdout、completion projection/history handle、notice 与错误类别。

REPL 预加载自解释 API：`tools.*` 是原始 typed bindings；`agents.spawn(...)`、`agents.list()`、`agents.send(...)`、`agents.interrupt(...)` 是 continuable child 的薄适配；`jobs.*` 管理 one-shot background work。`agents.spawn(...)` 只返回 child handle，结果通过消息、通知或文件到达。Goal、Workflow 和 refinement 仅在能力存在时提供同名 namespace。所有适配必须一一映射到 DSH 原生工具和 handle，不能建立第二套 registry。

目标体验应满足：

- 简单动作是一条普通 cell 表达式，例如 `await tools.read(...)`；不要求先建 todo、handoff file、helper 或并行框架。
- 多步任务才逐渐使用变量、函数、循环、`Promise.all`、child 和 Job；复杂度随任务增长，而不是由模式预收。
- `tools` 来自 Prime execution context 中 host-callable 的 DSH capability catalog，不来自模型可见 catalog。每个 binding 必须保留原始工具名、schema、权限解析和审计归属；本插件不得直接调用底层实现绕过 DSH tool runtime。
- Realm 提供 notebook 式发现能力：能列出当前 bindings，按名称查看短说明与完整 schema，并检查 completion/history handle；不把完整工具手册和所有罕见规约永久塞进 prompt。
- cell 的最终活对象先进入 generation-local history，再生成有界 wire projection。投影失败或截断不能把已成功的执行误报为失败。
- 小型、自包含的 child 上下文直接进入 prompt；只有大材料、结构化快照、二进制或跨重启数据才使用 handoff file。
- continuable child 返回 admission handle；Job 返回 Job handle。二者都应能作为 Realm 中的普通值保存，但由 DSH 各自的 registry 和控制工具管理。
- namespace loss、approval denial、tool failure 和取消使用少量稳定的结构化错误类别，让模型根据当前错误修复；不要依赖常驻 prompt 穷举所有恢复程序。

### 3.4 五层边界

1. **RLM tool/Realm layer（本插件）**：`repl` 注册、可信 Session 路由、持久 Realm、cell 语义、live namespace、completion history、输出投影、namespace-loss notice。
2. **Capability bridge（DSH-owned execution，本插件适配）**：从 host-callable catalog 生成 typed bindings、创建按 cell 撤销的 lease，并调用 DSH tool runtime 执行权限、sandbox、approval 与审计。模型可见 catalog 与 host-callable catalog 必须分离。
3. **Lifecycle layer（DSH-owned）**：Subagent、Jobs、Goal、Schedule、Compaction、Session、report/settlement 和恢复。
4. **Durable data layer（共享契约）**：工作区任务文件、spill artifact 和 DSH 状态；Realm 只保留可重建的热工作集与 locator。
5. **Doctrine layer（本插件）**：短小、按能力装配，但使用模型已经理解的 REPL、tool、agent、job、file 和 error 词汇。基础层只说明持久状态、外部副作用、耐久数据和长任务行为；不向模型讲解插件品牌或内部所有权图。

### 3.5 不采用的方向

- **不采用“给 generic Code Mode 继续加规则”**：这会扩大 prompt、提高简单调用成本，并用文字弥补 API 语义不足。
- **不采用“Realm 直接获得 Node.js 全权限”**：这会绕过 DSH host 的权限、sandbox、approval 与审计边界。
- **不采用“native tools + run_code 自由混用”**：它削弱持久 notebook 作为单一工作面的价值，并产生双重执行语义。
- **不采用“在插件内重写 DSH Agent Loop 或 tool runtime”**：专用模式需要的 catalog、lifecycle 和权限能力应上推 DSH；插件只实现 Realm 和组合适配。
- **不把内部架构名暴露给模型**：外部工具叫 `repl`，递归能力叫 `agents.spawn(...)`；不要求模型理解 Prime、RLM、brokered、Realm、DSH 所有权或 Python module 形态。

### 3.6 破坏性切换策略

本轮不做双轨兼容或渐进迁移，直接以一个可回滚 commit 边界完成切换：

1. Prime preset 关闭并移除 DSH shipped `code` preset 快照、Code Mode SDK assembly 和 `run_code`。
2. 本插件注册唯一模型可见工具 `repl`，并由该工具直接进入 Persistent TypeScript Realm。
3. 将原先为 hybrid Code Worker 路由服务的 model-visible identity handshake 改为 host-trusted execution-context routing；缺少可信 Agent、Session、state key 或 capability lease 时 fail closed。模型不得选择 Realm identity。
4. 删除 Prime 对 generic Code Mode Worker 替换语义的依赖；非 Prime Session 不再进入本插件 runtime，继续由 DSH 官方 preset/runtime 处理。
5. 建立 model-visible catalog 与 host-callable capability catalog 的明确边界。若当前 DSH 没有正式 API，本仓库可以随破坏性版本适配最小桥接，但必须仍调用 DSH tool runtime，不得复制权限、approval、Subagent 或 Job 实现。
6. 一次性更新 preset、bundle patch、policy、README、architecture、生成的 `lib/` 和组合测试；删除旧 `run_code`/Code Mode 兼容测试，而不是长期维护两套断言。
7. 旧 Prime Session 的 live Realm 与旧工具协议不迁移；升级后发出一次明确的 namespace/protocol-loss notice，耐久任务数据仍从工作区文件恢复。

回滚单位是整个 RLM Mode 切换，不提供运行时 feature flag 静默降级到旧 Code Mode。

### 3.7 评测与决策门槛

不能只以“能否调用工具”验收。应对切换前的 `run_code` 模式与切换后的 `repl` 模式使用同一组简单、中等和长程任务，至少记录：

- 任务成功率与最终结果质量；
- 完成一次简单读/搜/改所需的模型回合、cell 数和生成代码量；
- 无效包装代码、无效并行、重复读取和因规约误解造成的失败比例；
- 中间结果被 Realm 复用而非重新注入上下文的比例；
- system prompt 中 Prime 专属常驻 token；
- child admission、消息、取消、Job 收集和 namespace-loss 后恢复的正确率；
- 所有副作用仍经过 DSH 权限与审计边界的证明。

`repl` 切换是本轮既定方向，不再以候选 feature flag 交付；评测作为合并门槛。若权限隔离、fail-closed 身份、DSH 生命周期或非 Prime 回归任一不满足，则整组变更不合并，而不是降级成旧 Code Mode 双轨。

## 4. 所有权边界

### 本仓库直接实现

- 唯一模型可见工具 `repl` 的注册、协议、可信 Session 路由和 fail-closed 行为。
- Persistent TypeScript REPL、completion history、wire projection、budget、取消与 Worker generation。
- host-callable capability 的 typed binding/lease 适配和自解释 namespace；执行仍委托 DSH tool runtime。
- Prime preset、bundle patch、policy、升级说明，以及单元、集成、preset 和 packaging 测试。
- README、architecture 与 upstream decision log 的准确说明。

### 必须复用 DSH

- tool schema、权限、sandbox、approval、审计和实际执行。
- continuable child registry、inbox、report、cancel、cold resume。
- Jobs registry 与 one-shot background provider。
- Goal continuation、Compaction、Schedule、MCP、Session event log。
- Agent Loop、模型调用、上下文组装和非 Prime preset/runtime。

### 本轮不在插件内复制

- sibling/broadcast 消息总线和跨 Session transcript reader。
- recurring heartbeat scheduler。
- compaction engine 或 context token accounting。
- child delete/tombstone、per-child reasoning、自动 refinement。

这些能力只记录为 DSH-native follow-up；除非 DSH 已有正式工具并能通过 profile 组合，否则不在插件中伪造适配层。

## 5. 实施工作包

### WP-A：专用 `repl` 工具与 preset 切换

主要文件：`src/index.ts`、`src/runtime.ts`、`src/realm/`、`cordis.patch.yml`、`agent-presets/prime/agent.cordis.yml` 及 preset/packaging/组合测试。修改 preset 前必须先执行 `docs/upstream-sync.zh.md` 的审阅步骤，但本轮结论允许删除 shipped `code` snapshot，而不是继续同步它。

任务：

1. 注册输入仅为 `{ code }` 的唯一模型可见工具 `repl`，输出稳定的 stdout、completion/history、notice 和结构化 error；UI 标题由 host 自动生成。
2. Prime preset 关闭默认 Code Mode，删除 `run_code`、Code Mode SDK assembly、binding runtime 的模型侧组合以及完整 shipped `code` preset 快照。
3. 由 tool execution context 提供可信 Agent/Session identity 和 state route；模型不能传入或选择 Realm identity。缺少 identity、state key 或 lease 时 fail closed。
4. 删除只为 generic Code Worker 替换服务的 hybrid 路由和 model-visible identity handshake；保留仍被专用 Realm 使用的 Worker、budget、cancel、hard-kill 和 generation fencing。
5. 非 Prime preset 不注册 `repl`，继续使用 DSH 官方 native/one-shot 语义；不得因删除 hybrid runtime 改写全局 Agent Loop。
6. 不提供旧 `run_code` alias、feature flag 或静默 fallback。旧协议调用明确失败，旧 live namespace 明确丢失。

验收：Prime 模型 catalog 精确包含一个执行工具 `repl`，不包含 `run_code` 或其他直接能力工具；非 Prime 组合行为与插件未安装时一致；身份缺失时 fail closed。

### WP-B：host-callable capability SDK

主要文件：`src/policy.ts`、新的 REPL SDK/bridge 模块、host-call 与 lease 测试。

任务：

1. 从当前 Agent 的 host-callable DSH capability catalog 生成 `tools.*` typed bindings，但不把这些工具加入模型 catalog。
2. 每个 cell 建立可撤销 binding lease；cell 完成、abort、timeout 或 Worker 换代后，旧 binding 不能继续调用 host。
3. 所有调用继续进入 DSH tool runtime，复用其 schema 校验、权限、sandbox、approval、审计和错误，不直接调用工具实现。
4. 提供自解释薄 namespace：`agents.spawn/list/send/interrupt` 与 `jobs.list/output/kill`；它们一一映射原生工具和 handle，不建立 registry。
5. 提供 binding 发现与按需 schema 查询；完整工具手册不常驻 system prompt。
6. assembly 时按启用能力 fail-fast，并列出缺失原语；禁用的能力不生成 namespace，也不在 prompt 中出现。

验收：模型只通过 `repl` 即可调用获授权能力；隐藏工具不能被模型直接调用；Realm 调用与原生 DSH 调用得到相同权限、approval 和审计结果；过期 lease 必然拒绝。

### WP-C：REPL completion history 与恢复

主要文件：`src/realm/realm-worker.ts`、`tests/realm-worker.spec.ts`、`tests/completion-history.spec.ts`、`tests/completion-contracts.spec.ts`；必要时修改 protocol 或 Realm host。

设计要求：

1. 成功 completion 无论是否 JSON-compatible，都先按有界规则考虑 generation-local retention。
2. lossless JSON 小值原样返回；大 JSON 使用有界 projection。
3. 非 JSON 活对象若可纳入 history，返回固定 envelope；不得调用用户 `toJSON`、`toString` 或 inspect hook。
4. `$_` 与 `$out(id)` 返回原始对象身份；覆盖 Map、Set、函数、BigInt、循环对象和 class instance。
5. opaque slot 使用独立硬预算和 FIFO 淘汰，不能绕过 entries/nodes/bytes 上限。
6. exception、abort、timeout、hard-kill 不创建 slot；generation fencing 和 expired handle 语义保持明确。
7. namespace/protocol loss notice 指导从耐久文件恢复，不假装重放旧 cell。

验收：成功 cell 不因 wire projection 失败而假失败；旧 generation handle 不能穿透恢复边界；预算测试证明引用保留有界。

**状态：已完成（2026-02-18）。** 实现要点：

- 非 lossless-JSON 的成功 completion 不再 `invalid-output`，而是按独立的 opaque 预算（`RealmCompletionOpaqueLimits`：entries 8 / estimated bytes 8 MiB / nodes 262 144，默认值为 JSON 存储的 1/4）generation-local 保留，并返回固定 envelope（`$out`/`use`/`retained`/`type`/`opaque`/`truncated`）；分类仍由同一次有界走查完成，其抛错点即分类结论，不新增二次遍历，不调用用户 `toJSON`/`toString`/inspect hook。
- `$_` 与 `$out(id)` 返回原始对象身份，覆盖 Map、Set、函数、BigInt、循环对象、class instance、Date、稀疏数组与代理（含 revoked proxy）；opaque 身份复用对对象和函数生效。
- opaque 与 lossless-JSON 两个存储共享同一 `$out`/`$_` 命名空间与单一日志/句柄序，但 entries/nodes/bytes 预算各自独立、各自 FIFO 淘汰；单槽 charge 为分类走查在抛错前已记账的 bytes/nodes（下界、有界），无法入空库时返回 `retained: false` 并带 `reason`，不为其清空历史。
- 对抗性安全：抛错 getter、抛错 proxy trap、revoked proxy、深度超限（RangeError）都落在 opaque 保留路径，cell 成功且错误文案不出现在模型可见结果中。
- hard-kill 后 opaque handle 与 JSON handle 一样全部 `CompletionExpiredError`；id 全局单调不复用。
- 主要文件：`src/realm/protocol.ts`、`src/realm/realm-worker.ts`、`src/realm/realm.ts`、`src/realm/runtime.ts`、`tests/completion-opaque.spec.ts`（新增 20 用例）及受影响契约测试改写；completion/realm/prime-runtime 六套 204 用例与最终全量验证均通过。

### WP-D：Agent/Job 行为与最小模型 doctrine

主要文件：`src/policy.ts`、continuable orchestration 测试、Job 测试和 REPL SDK 测试。

任务：

1. `agents.spawn(...)` 返回 continuable admission handle；`agents.list/send/interrupt` 延续 DSH 原生 roster、inbox、cancel 与 cold-resume 语义。
2. `jobs.*` 只管理 Job id；Agent handle 与 Job handle 不能混用。
3. 小型、自包含 child 上下文直接随 prompt 发送；大材料、结构化快照、二进制或耐久数据才走 immutable handoff file。
4. system prompt 只使用 REPL、tool、agent、job、file、error 等任务词汇，不向模型解释 Prime、RLM、brokered、Realm、Cordis 或插件所有权。
5. 删除针对 generic Code Mode 的 Promise 包装、SDK 语法补丁和实现细节规约；并行、副作用、长任务和恢复只保留不可由 API 自然表达的不变量。

验收：模型无需理解项目架构即可从工具 schema 和短 prompt 正确完成简单调用、并行编排、child follow-up、Job 收集和错误恢复。

### WP-E：文档、评测与破坏性升级说明

文件：README.md、docs/architecture.md、docs/prime-agent-learnings.md、docs/upstream-sync.zh.md、docs/upstream-sync.md、本计划、必要的 eval fixture。

任务：

1. 文档以 `repl` 为唯一模型入口，删除“Prime 等于 patched Code Mode”的描述和旧映射。
2. 记录从 `run_code`/hybrid runtime 到专用 REPL 的 Reject/Replace 决策，以及旧 Session namespace 不迁移的升级说明。
3. 将 Heartbeat/Schedule、主动 Compaction、family observation 等未交付能力继续标为 DSH-native follow-up。
4. 对简单读/搜/改、中等多步处理和长程 Agent/Job 建立切换前后基线，记录 3.7 节指标。
5. 完整执行 preset、bundle patch、packaging、Prime 组合和非 Prime 回归验证；构建并提交对应 `lib/`，删除旧 snapshot 与死代码。

验收：没有文档或测试继续把 `run_code`、generic Code Mode SDK 或 hybrid Worker 描述为当前 Prime 架构；评测证明新入口没有用额外模型术语换取实现便利。

## 6. 多 Agent 执行策略

1. 先由只读审阅 Agent 分别核对 DSH tool visibility/execution API、preset 组合边界和现有 Realm 可复用范围。
2. WP-A 与 WP-B 是同一切换的关键路径：先落定 `repl` protocol 和可信 execution context，再实现 capability SDK，不允许两个 Agent 各自发明路由。
3. WP-C 可在 protocol 定型后独立实现；WP-D 依赖 WP-B 的 namespace 和 DSH handle 映射。
4. WP-E 在代码行为稳定后更新文档和前后评测，不保留旧 Code Mode 作为兼容实现。
5. 独立验证 Agent 审阅是否误复制 DSH 所有权、是否仍有隐藏双入口和模型侧内部术语；主 Agent 运行完整验证并处理集成问题。

## 7. 验证矩阵

迭代验证：

- npx vitest run tests/repl-mode.spec.ts tests/repl-capability-bridge.spec.ts
- npx vitest run tests/continuable-orchestration.spec.ts
- npx vitest run tests/realm-worker.spec.ts tests/completion-history.spec.ts tests/completion-contracts.spec.ts

最终验证：

- npm run check
- preset/组合相关变化时额外运行 packaging-boundary、preset-install、loader-composition、prime-preset-mount.e2e 和 prime-compose.e2e 测试。

最终检查：git diff --check、git status --short、src/ 与 lib/ 构建产物同步，无临时 handoff/result 文件、凭据或本机路径进入提交。

## 8. 风险与回滚

- opaque completion 可能扩大 Realm 引用保留：必须有独立硬预算和 FIFO 淘汰，禁止无界 fallback。
- continuable 测试可能依赖 DSH 内部时序：优先断言公开状态和事件顺序，不依赖 sleep。
- 破坏性切换会使旧 Prime profile、`run_code` 调用和 live namespace 失效：发布说明必须明确；不增加 alias、兼容开关或静默降级，回滚只能整体回退该版本。
- model-visible 与 host-callable catalog 分离若绕过 DSH tool runtime，会形成权限漏洞：必须用 approval、denial、审计与过期 lease 的行为测试证明调用仍走官方执行路径。
- 文档不得先于代码宣称完成；每个工作包只在对应测试通过后更新状态。

## 9. 执行状态

- [x] 完成上游 Python / Node 差距审计。
- [x] 明确专用 RLM Mode 与模型侧 `repl`/`tools`/`agents` 词汇。
- [x] 保存实施计划。
- [x] 完成 WP-A：唯一模型可见 `repl { code }`、trusted Session 路由与 native preset 已切换。
- [x] 完成 WP-B：`tools.*`、`agents.*`、`jobs.*` 经官方 ToolRuntime 嵌套执行。
- [x] 完成 WP-C（2026-02-18，见 §5 WP-C 状态）。
- [x] 完成 WP-D：continuable Agent/Job aliases、调度顺序与最小模型 doctrine 已验证。
- [x] 完成 WP-E：README、architecture、upstream-sync、SVG、迁移测试与生成产物已更新。
- [x] 完整验证通过并审阅最终 diff（284 passed，1 个需 API key 的模型 e2e skipped）。
