# OpenAI Codex 新上下文模式研究

> 研究日期：2026-09-10
>
> Codex 基线：`openai-codex@03f014564deef528c25e80fe67ec51871cb6ee51`
>
> 上次项目内基线：`openai-codex@8e6a44b428`（2026-09-04）
>
> 范围：只研究 experimental context management / token-budget 模式，即 `notes + history + new_context + 无摘要换窗`。不评估、不接入 Codex 远端 compaction 协议。

## 结论

1. **Codex 的新模式与 Prime 当前方向一致。** 到阈值后不是让另一个模型生成 handoff 摘要，而是开启全新模型窗口；任务状态写入 notes，旧对话通过 history 按需回取，运行环境继续存在（`codex-rs/core/src/compact_token_budget.rs:21-93`；`codex-rs/core/src/tools/handlers/new_context_window_spec.rs:6-16`）。
2. **这仍是实验模式，不是 Codex 默认稳定行为。** `TokenBudget` 与 `ContextManagement` 都标为 `UnderDevelopment`、默认关闭；实验激活还受账号、backend 和模型 capability 限制（`codex-rs/features/src/lib.rs:1611-1620`；`codex-rs/core/src/session/token_budget.rs:13-57`）。
3. **上下文架构不需要重写，但 task notes 的构建协议值得 Adapt。** Prime 已有无模型 history directory、原始 Session 日志回取、CAS task notes、主动 `new_context`，普通 checkpoint 后还保留 REPL Realm heap；缺的是 Codex 那种“平时增量维护、临界点结构化收束、耗尽前强制保存”的分阶段协议。
4. **需要优化三个生命周期细节。** 第一，Prime 主动切窗不应继续借用语义上限定为 provider overflow 的 DSH `context-overflow` trigger；第二，task note 应有稳定的最小内容模板和可判断新鲜度的 trusted metadata；第三，应评测“一次近阈值提醒 + 最后 notes 缓冲”，降低自动换窗前 notes 过时的概率。
5. **不要照搬 Codex 的远端状态形态。** 跨 agent history/notes、1 MB 虚拟 notes 文件、opaque window/item ID 和 eventual consistency 是其服务端 backend 的约束，不是 Prime 本地 Session 模型的天然升级。

## 1. 新模式如何工作

### 1.1 激活与成熟度

配置入口是 `features.context_management.experimental_mode`。只有该开关启用、起始模型声明 `supports_experimental_context`、使用需要 OpenAI 登录的 Codex backend，并且账号是 ChatGPT Plus、Pro 或 Pro Lite 时，启动逻辑才启用 TokenBudget 并挂载 history/notes；自定义 provider、API key、自带 bearer token、AWS 路由等不会进入该模式（`codex-rs/features/src/feature_configs.rs:301-313`；`codex-rs/core/src/session/token_budget.rs:13-57`）。

当前 bundled `gpt-6-astra` 声明支持实验上下文，但其 model-owned `token_budget.enabled` 仍为 false；显式 experimental mode 才走实验激活。当前元数据给出的提醒阈值是 6,144 token，fallback buffer 是 16,384 token（`codex-rs/models-manager/models.json:3-36,104-112`）。这说明实现已完整进入主干，但产品开关仍然保守。

演进证据：`cff76fa96`（2026-09-02）加入实验激活；`6af345407`（2026-09-06）又增加模型 capability 门控，并区分 fresh child 与 history fork，属于上线前继续收紧，而非稳定默认。

### 1.2 窗口身份与模型可见上下文

每个窗口持有 `first_window_id`、`previous_window_id`、当前 `window_id` 和窗口序号。切窗时生成新 UUIDv7、清除 pending request，并重新允许本窗口的 reminder/fallback 各触发一次（`codex-rs/core/src/state/auto_compact_window.rs:4-103`）。完整初始上下文以 developer fragment 告诉模型 agent name 与这些窗口 ID，还可附最多 4,000 bytes 的 backend thread hint（`codex-rs/core/src/context/token_budget_context.rs:12-75`；`codex-rs/ext/history-notes/src/extension.rs:30-32,97-150`）。

这些 ID 不是压缩算法本身，而是远端 normalized history 的寻址键。模型被要求把相关 window/item ID 写进 notes，下一窗口才能直接读取旧 item；不知道 ID 时再 list/search（`codex-rs/models-manager/models.json:104-112`）。

### 1.3 预算、提醒与最后缓冲

Codex 同时计算四个量：完整 active-context 使用量、计入自动切窗 scope 的使用量、scope limit、完整模型窗口硬上限。scope 可以是 `total`，也可以是 `body_after_prefix`：后者从当前 active usage 中减去本窗口首次请求的 prefill input tokens，避免大而固定的 carried prefix 造成刚切窗就再次触发；但无论 scope 如何，完整模型窗口仍是不可绕过的硬上限（`codex-rs/core/src/session/context_window.rs:7-19,52-109`）。prefill 优先使用服务端首次 usage 的 input tokens，恢复或尚未拿到 usage 时可先用估算值（`codex-rs/core/src/state/auto_compact_window.rs:38-45,105-140`；提交 `80fdd4688`）。

模型可以调用 `get_context_remaining`，得到 `{ tokens_left }`；返回值是基础自动切窗边界和完整窗口边界两者中更小的剩余量（`codex-rs/core/src/tools/handlers/get_context_remaining_spec.rs:8-35`；`codex-rs/core/src/tools/handlers/get_context_remaining.rs:81-89`）。

窗口进入 reminder threshold 后，Codex 注入一次 developer reminder。若配置了 fallback prompt，基础预算耗尽时不会马上切窗，而是注入一次强约束 prompt，并只开放额外 buffer，让模型完成一次 notes 写入；buffer 或完整窗口耗尽后才切窗。每个窗口的 reminder 与 fallback 都是 level-triggered、每窗口至多一次的状态（`codex-rs/core/src/session/token_budget.rs:161-223`；`codex-rs/core/src/config/mod.rs:1143-1159,1234-1252`；提交 `6df037d47`、`768330dd6`）。

### 1.4 主动与自动换窗

`new_context` 的模型可见说明明确承诺：开启新上下文窗口，但不清空、重置或影响 environment state。handler 只把请求登记到 Session；模型采样和工具执行结束后，如果当前 turn 需要 follow-up，turn loop 消费该请求并在下一次采样前切窗（`codex-rs/core/src/tools/handlers/new_context_window.rs:13-43`；`codex-rs/core/src/session/turn.rs:527-599`）。请求在读取时即清除，属于 one-shot intent。

TokenBudget compaction 仍进入统一 pre/post compact hook、`ContextCompaction` started/completed 生命周期，但不调用模型或服务端摘要。`start_new_context_window` 替换模型历史，只重建当前 step 的初始上下文、world state 和来源可验证的 client developer 消息，然后重算 token usage（`codex-rs/core/src/compact_token_budget.rs:21-93`；`codex-rs/core/src/session/mod.rs:4350-4400`）。旧 conversation 不自动进入新窗口。

### 1.5 notes/history 恢复层

History/notes 是独立 extension，共九个动作：history 的 list windows、list items、read item、search contents，以及 notes 的 list、read、search、append、write（`codex-rs/ext/history-notes/src/tools.rs:24-54`）。

- history 只读，以 agent name、opaque window ID、item ID 寻址；list/search 最终一致，新 item 可能几秒后才出现。
- notes 是虚拟路径，interface 支持以绝对 agent path 寻址其他 agent；当前模型 guidance 把写入限制在当前 thread。单文件上限 1,000,000 UTF-8 bytes。成功 write 后 direct read 立即可见，但 list/search 最终一致。
- 查询和写入实际调用 OpenAI backend 的 `alpha/history/v2/*`、`alpha/notes/v2/*` endpoint；敏感 search/write arguments 通过专用 header 标记加密，单次 backend timeout 为 35 秒（`codex-rs/ext/history-notes/src/backend.rs:14-17,29-91`）。
- extension 每次构建 full context 时还会请求最多 4,000 bytes 的 `thread_hint`；失败或返回超限时静默省略，不阻断会话（`codex-rs/ext/history-notes/src/extension.rs:97-150`）。

这是一种“工作窗口可丢、事实记录另存、按地址恢复”的设计，不是语义摘要。代价是模型必须及时写 checkpoint，并承担一次或多次 notes/history backend 调用。

## 2. 与 Prime 当前设计的对照

| 维度 | Codex experimental context | DSH Prime 当前实现 | 判断 |
| --- | --- | --- | --- |
| 换窗内容 | 清空旧模型 history，重建 initial context | 旧 surface 替换为有界 history directory，并保留 recent tail | Prime 更渐进；无需改成全清空 |
| 摘要模型 | 不调用 | 不调用 | 已对齐 |
| 执行状态 | environment state 不受 `new_context` 影响 | 普通 checkpoint 不销毁 Realm，变量/函数继续存在 | Prime 更明确，应保留 |
| 旧历史 | OpenAI backend，window/item ID，最终一致 | 当前 Session 原始事件，stable seq，本地直接回取 | Prime interface 更小、可审计 |
| notes | 多虚拟文件、单文件 1 MB、可跨 agent | 每 Session 单份 6,000 字符 task note，revision CAS | Prime 更符合有界状态与隔离要求 |
| 主动切窗 | dedicated `new_context` request，one-shot consume | dedicated 模型工具，但内部借用 `context-overflow` trigger | Prime seam 需要修 |
| 预算可见 | guidance + `get_context_remaining` + reminder | 每个 REPL 结果尾部显示 used/window | 无需再加查询工具 |
| 最后保存机会 | 一次 reminder + 16,384 fallback buffer | 靠固定 policy 和模型在里程碑主动写 notes | 值得 A/B reminder/fallback |
| scope | `total` 或 `body_after_prefix`，另有 hard cap | canonical request + provider usage anchor 的 total pressure | 先观测重复触发，再决定 scope |
| child/shared state | fresh child 重算；fork 可保留；工具可跨 agent 读 | child 独立 Session/history/notes | 不复制跨 agent 能力 |
| 成熟度 | UnderDevelopment，默认关闭 | Prime 已作为 shipped 行为并有 deterministic integration coverage | Codex 只能作设计证据 |

Prime 当前的 `HistoryWindowEngine` 是一个较深的 module：只覆写 DSH Basic 的 `summarize()` seam 生成目录，范围选择、工具配对、compaction lock、原子 surface replace、持久化和 overflow recovery 继续由 DSH 负责（`src/context-manager.ts:32-42`；`D:/project/deepseek-harness/packages/compaction/compaction-basic/src/index.ts:259-358`）。Codex 的新模式没有提供理由让 Prime 复制这些内部实现。

DSH token meter 也不是纯字符估算：canonical request envelope 与最近成功调用匹配时会复用 provider usage，否则按完整 header 与当前 surface 重估（`D:/project/deepseek-harness/packages/llm/token-meter/src/index.ts:120-181`）。因此 `body_after_prefix` 是可选策略，不是修复错误计量的必选项。

## 3. 优化建议

### P0：补正确的主动换窗 seam

Prime 的 `tools.new_context` 在下一 `agent/pre-step` 调用 `compactIfNeeded(agent, 'context-overflow', ...)`（`src/context-manager.ts:117-145`），但 DSH interface 把该 trigger 明确定义为 provider-confirmed context overflow（`D:/project/deepseek-harness/packages/compaction/compaction/src/index.ts:101-117`）。当前 Basic 恰好借此绕过 pressure threshold，不代表未来 adapter 必须兼容。

应先在 DSH 增加 active-turn requested checkpoint interface，再让 Prime 调用；不要在 Prime 复制私有 range selection。这个修改深化现有 compaction module：调用方只表达“主动切窗”，implementation 隐藏安全范围、事务和失败恢复。

### P1：明确请求失败语义

Codex 在尝试换窗前消费 pending request；Prime 只有成功或 no-op 后才删除 WeakMap entry，其他异常会让后续 pre-step 隐式重试（`src/context-manager.ts:125-143`）。新 seam 落地时应把它定义成 one-shot，或明确实现 durable retry；不要保留当前偶然语义。建议倾向 one-shot 清除并显式失败，补重复调用 coalesce、异常后重试、进程重启测试。

### P1：吸收 task notes 的三阶段构建协议

Codex 值得学习的不是 1 MB 虚拟文件，而是 notes prompt 的**时机分层**：

1. **平时 guidance**：长任务中增量维护 goal、decisions、progress、task-specific learnings 和 next steps，并清理已经失效的旧内容；
2. **临界 reminder**：给出真实剩余预算，要求在主动切窗前把仍在处理的用户请求和关键操作绑定到可回取的 history 地址；
3. **最后 fallback**：只允许一次 notes 写入和随后切窗，防止模型在已经没有预算时继续展开任务（`codex-rs/models-manager/models.json:104-112`）。

Prime 当前 policy 和 `notes_write` description 已覆盖 goal、corrections、verified progress、evidence addresses、unresolved items 与 next steps，内容字段本身不缺；缺的是“何时必须收束”和“如何替换陈旧项”。建议保留自由 Markdown 与单份 6,000 字符 note，不改成大型 JSON schema，也不由 Host 调模型自动总结。推荐的最小内容模板是：

```text
Goal
Current constraints and user corrections
Verified progress -> evidence seq/file path
Key decisions and reasons
Open questions / next steps
External state or assumptions that must be rechecked
```

写入流程继续使用现有 CAS：同一 checkpoint cell 内先 `notes_read`，合并并删除被新事实取代的条目，再 `notes_write`，最后才 `new_context`。不要把每轮记录追加成流水账；note 是当前恢复快照，原始 chronology 已在 Session history。

还可给 notes 文件增加 Host 自动写入的 `updatedAtSessionOffset`（或等价字段），而不是要求模型手抄窗口 ID。它只记录 note 写入时看到的排他 Session 日志位置，不承诺日志已同步落盘，也不证明内容正确；恢复时若后续又有 user correction，模型即可把 note 判为可能过时。该 metadata 应由可信 Session 生成，不接受模型输入，并保持旧文件可迁移。

文案应各归其位：常驻 policy 只说明何时维护与材料不可信；`notes_write` description 是内容 checklist、CAS 和完整替换规则的唯一权威位置；动态 reminder 只给当前预算与立刻更新的动作。不要在三个 surface 重复整段说明。

### P2：先落一次性 checkpoint reminder，fallback buffer 继续评测

Prime 已持续显示 Context used/window，不需要照搬 `get_context_remaining`。本次先在自动 pressure checkpoint 前增加每工作窗口一次的提醒，让模型更新现有 task note；提醒在 downstream pressure listener 结算后作为本 step 最后一条 admitted message 进入最终 surface，计算时包含尚未入日志的本 step 消息；专用 source 与当前 surface 上的 Session 自有事件恢复一次性状态，局部 replacement 仍保留旧提醒时不会重复注入。严格有界的阈值后最后写入机会仍需 DSH lifecycle seam，暂不在 Prime 复制；因此 Prime preset 把 16,384 tokens 用作更早的 pre-threshold lead，而不是声称复刻 Codex 的 6,144 reminder + 16,384 post-threshold buffer 语义。

先冻结当前版本做 A/B，至少比较：任务成功率、用户纠正保留率、旧状态误用、notes 新鲜度、总 token、额外 step 数和 p90 延迟。若没有质量净收益，不增加 prompt 噪声。不要让 Host 自动生成语义 notes。

### P3：仅在证据出现时增加 body-after-prefix

如果日志显示固定 system/tool prefix 使 compaction 后仍立刻超过 pressure threshold，再向 DSH pressure policy 增加 checkpoint baseline scope，同时保留 full-window hard cap。当前没有这项实证，不应只因 Codex 有该开关就改阈值模型。

### 小成本回归保护

Prime 的 0.3 policy 只精确匹配 `deepseek-official/deepseek-v4-flash`（`agent-presets/prime/agent.cordis.yml:161-186`）。preset/packaging 行为测试同时固定该精确路由和 16,384-token reminder lead，避免 alias、模型改名或配置同步后静默漂移；这与 Codex 按模型 capability 激活的做法一致，但仍保持 DSH 的精确路由语义。

## 4. 明确不做

- 不接入或仿制 Codex 远端 compaction endpoint、encrypted compaction item、stream 协议和 request trimming。
- 不把 LLM handoff 摘要恢复为 Prime 默认路径。
- 不复制跨 agent history/notes、1 MB notes 文件或 opaque window/item ID；Prime 的 Session seq、Session 隔离和 6,000 字符 CAS task note 足够且更安全。
- 不新增 `get_context_remaining`：Prime 已在每个 REPL cell 结果显示 context used/window。
- 不自动把 retrieved history 或 notes 提升为可信指令；继续按不可信任务材料处理。

## 5. 相对上次基线的新信息

`8e6a44b428..03f014564` 共 323 个提交。项目在 2026-09-06 已依据当时 Codex 0.153.x 吸收 history/notes/new_context 方向；这次没有发现需要推翻现有上下文架构的新算法，但 notes 的分阶段构建协议仍值得补齐。新增的关键证据是：

- `6af345407`：实验上下文又增加模型 capability 门控，并修正 fresh child/fork 激活语义；
- `b4507997e`：重建上下文必须使用捕获的完整 step settings，避免活跃 turn 中配置漂移；
- 当前 feature registry 仍把 TokenBudget/ContextManagement 标为 UnderDevelopment、default false；
- current model metadata 已明确给出 6,144 reminder threshold 与 16,384 fallback buffer，可作为 Prime A/B 的候选量级，而不是直接默认值。

## 验证

- Codex checkout：`https://github.com/openai/codex.git`，detached at `03f014564deef528c25e80fe67ec51871cb6ee51`，working tree clean。
- 本报告只使用 Codex 源码、测试与 git commit message；未运行 Rust 测试。
- DSH/Prime 对照读取本仓库源码与只读 sibling `D:/project/deepseek-harness`；未修改 sibling。
- 后续优化实现修改了 task-note persistence、context-manager/policy、Prime preset、行为测试和生成的 `lib/`；没有修改只读 sibling，也没有接入远端 compaction。
