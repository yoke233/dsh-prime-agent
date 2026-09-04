# 2026 前沿 code mode / RLM / 上下文工程调研与可吸收清单

> 状态：调研结论；2026-09-04 已吸收第 1–14 条（5.1 全部八条提示词改动；5.2 的无状态子调用做成 `agents.query`/`agents.queryMany` 私有成员而非独立 `llm` 全局，原因见 `docs/architecture.md`「Worker 销毁与注入全局数」；`repl` 结果尾部 `Context: 已用 / 窗口 tokens` 行；DeepSeek 默认路由 `modelPolicies.thresholdRatio: 0.3`）。未做：5.2 第 10 条的变量目录、5.3 全部。第 6 节评测尚未运行。
> 日期：2026-09-04
> 范围：为什么模型拿到 Prime 的持久 REPL 后仍按 one-shot 工具调用使用，2026 年前沿（论文、官方博客、harness 源码）怎么解决同类问题，哪些可以吸收进本项目。
> 证据等级约定：**A** 有对照评测的论文或官方评测；**B** 官方 API 文档/规范；**C** 官方工程博客（含厂商自测）；**D** 仅源码/README；**L** 本机会话日志统计。

## 1. 结论

**诊断**：本项目的问题不是缺机制，而是三件事叠加。

1. 模型可见提示词把 code mode 的「经济学」丢了。DSH 官方 PTC（`run_code`）提示里有两句核心指令——"Only what you print or return is program output — curate it" 与 "every other intermediate result stays out of the conversation, so extract just what you need"（`packages/core/tools/src/ptc.ts:49`、`ts-types.ts:259`）。Prime 在 `system-prompt/assemble` 里用自己的 `tools:sdk` 文本整段替换了它们（`src/index.ts:329-342`），替换后的 `REPL_AGENT_PROMPT` 通篇是机制说明，没有一句告诉模型「只有 cell 的返回/打印进上下文，所以先在程序内归约」。同一次截取（`src/index.ts:163-175` 只取 ```` ```ts ```` 块）还丢掉了上游 `SDK_INSTRUCTIONS`、`SDK_PROGRAM_INSTRUCTIONS`（含 "Independent read-only calls MAY overlap under `Promise.all`"）与 `renderBashExample` 的调用样例机制（`ts-types.ts:271-283`）；而本项目的 bridge 调度（`src/repl/bridge.ts:122` 按 `executionMode` 选 parallel/exclusive）与上游 PTC 完全一致，这些指令在机制上都成立。
   同一层面的另一处：`repl` 的 tool description 只有 "Execute a TypeScript REPL cell."（`src/index.ts:255`），而 Codex code mode 的 `exec` description 第一行是 "Run JavaScript code to orchestrate/compose tool calls"，且整份 code-mode 契约都在工具描述里，`gpt-5.2-codex` 的 system prompt 一字不提批处理；Anthropic 2026-07-24《The new rules of context engineering for Claude 5 generation models》的立场是 "put instructions on how to use tools in the tool descriptions rather than the system prompt."（并称 "We removed over 80% of Claude Code's system prompt"）。模型判断「这个工具是干嘛的」时读的是 description，它现在说的是「执行一个 cell」而不是「编排/组合工具调用」。
2. `src/policy.ts:35` 的第一句是刹车："Keep a simple action simple; introduce loops, helpers, parallelism, agents, or jobs only when the task benefits."；上游 prime-agent `rlm.ts` 同位置是油门："Python is the orchestration language: use Python for loops, conditionals, parsing, and state. ... Always assign read/search results to named variables so you can revisit them later."
3. 上下文控制只有单条封顶、没有累计预算。需要先纠正一个认知：cell 内 `tools.*` 子调用的返回值**本来就不进模型上下文**，只进程序变量与会话日志（日志副本另有 spill 臂，`dsh-spill-policy` README："a log copy is not model context"）。进入上下文的只有模型自己 `console.log` 与 completion 的显示文本，每 cell 由 `maxInlineBytes: 12000` 封顶。但 12KB 是单条溢出保护，不是预算：50 个 cell 各回 10KB 就是约 500KB ≈ 125k token，在 compaction 触发前没有任何机制回收；`compaction-tool-result-pruner` 与 `compaction-basic` 只在压力/溢出时运行，而 DeepSeek 路由默认 contextWindow 100 万 token 导致 60 个会话零次 compaction。模型在写 cell 时既没有事前预算信号，也看不到自己已经烧了多少（VISTA 所称的 "proprioceptively blind"）。问题的准确表述是：**cell 显示输出的跨 turn 累积无预算、无衰减、对模型不可见。**

**本地证据**（12,142 个真实 Prime cell）：一 cell 一次调用且几乎原样回流占 59–68%；有调用的 cell 中只有 12–16% 把可见输出压到原始输出一半以下；声明的变量只有 8–9% 被后续 cell 引用；`$_` 使用率 0%。详见第 2 节。

**前沿共识**（详见第 4 节）：

- 单一代码工具 + 类型化 SDK + 输出硬限额是行业三件套（Cloudflare、Anthropic、OpenAI、Vercel、LangChain、DSH PTC），本项目已有其二；缺的是把「只有显式输出进上下文」写成事前预算，并给 2–3 个组合/归约 few-shot。要点破的是：code mode 在源码层「省 context」只成立一半——省的是**工具定义** token（Cloudflare 1.17M → ~1,000；Anthropic 生产流量 20–40%），执行**结果**侧多数纯 code-mode 项目根本没有预算（Vercel 超限硬失败、Cloudflare AI SDK 路径默认不截断、LangGraph CodeAct / langchain-sandbox / E2B 零截断）；本项目的 spill + 可回取在这一列里是少数派，问题只在于模型不知道它的存在与预算。
- 「拿到 code mode 却不批量」是模型属性而非配置错误：arXiv:2607.10569 测得 Codex 会批量而 Claude 不会；PrimeIntellect 自述 GPT-5-mini "the RLM is worse than the LLM, except when it is told a strategy"；RLM 论文 Figure 4(a) 证明 in-context 轨迹示例即使与任务无关也显著改善首次分解。结论：补提示词 + 示例是对的方向，且必须用实际路由模型（deepseek-v4-flash）自己测。
- RLM 范式的核心动作是「在循环里对 N 个 chunk 各做一次无状态子调用，把结果收进变量」；本项目只有 continuable subagent，没有 `llm_query` 式原语，结构上做不了这个动作。
- 持久 REPL 状态是本项目相对 OpenAI/Vercel/Cloudflare 的稀缺优势，但提示词只说了「保留」，没说「因此跨 cell 增量构建、不要重读」。arXiv:2603.01209 量化了后果：无状态训练的模型在持久 runtime 里重复推导已有状态，多烧约 3.5× token。
- Harness 改动的正确成功指标是「每个成功任务的成本」而非通过率：arXiv:2607.22585 测得 harness 让 token/solved task 差 40 倍而通过率差 0–8pp；arXiv:2607.03691 警告 35 个 scaffolding 版本 resolve rate 无显著提升而 token 涨 70%+。

**可吸收清单**（按性价比排序，完整对照见第 5 节）：

| # | 动作 | 类型 | 成本 | 主要依据 |
| --- | --- | --- | --- | --- |
| 1 | 重写 `policy.ts:35-36`：代码是编排语言；无条件把读取/搜索结果绑定到命名变量并从变量继续 | Adopt（prompt） | 零 | 上游 `rlm.ts`；本地 declare-and-forget 数据 |
| 2 | 重写 `repl` 的 tool description（现为 "Execute a TypeScript REPL cell."）为「用 TypeScript 编排/组合工具调用」并补回 DSH PTC 的两句：只有 cell 返回/打印进上下文；其余留在 REPL，只提取需要的部分 | Adopt（prompt） | 零 | Codex `exec` description "Run JavaScript code to orchestrate/compose tool calls"；Anthropic 2026 "put instructions on how to use tools in the tool descriptions"；DSH `ptc.ts`/`ts-types.ts` |
| 3 | 把 12KB spill 从事后惩罚改为事前预算：在提示词里明说每 cell 可见输出预算，超出即落盘 | Adopt（prompt） | 零 | PrimeIntellect 8192 字符/轮；deepagents 4000 字符 |
| 4 | 兑现 typed `ToolOutputMap`：可在同一 cell 内串联、直接取字段，不需要中间显示 | Adopt（prompt） | 零 | smolagents 规则 5 |
| 5 | 加 3 个 ≤6 行的 TypeScript few-shot：循环批量 + 过滤归约；大文件 peek/切片；早停 | Adopt（prompt） | 零 | RLM 论文 Fig 4(a)；Anthropic PTC 四模式；Tool Use Examples 72%→90% |
| 6 | 加一条红旗自检：「一个 cell 只有一个 `await tools.x()` 且原始结果直接成为 completion」= 把 REPL 当语法糖；附反向条款「一次 grep 能定位就直接读」 | Adopt（prompt） | 零 | `alexzhang13/rlm` ORCHESTRATOR_ADDENDUM；论文附录 C.3 |
| 7 | 删除或压缩 `$_` 段落（约 120 词，12k cell 零使用），保留一句 | Adopt（prompt） | 零 | 本地数据 |
| 8 | spill / preview 文案加因果句：截断之后该做什么（从变量切片、grep、聚合），而不只说值还在 | Adopt（prompt） | 零 | RLM 论文 "You will only be able to see truncated outputs ... so you should ..."；smolagents 截断文案 |
| 9 | 在 `read`/`grep`/`pwsh`/`web_search` 的 JSDoc 上各加一句归约提示 | Adapt（prompt，单点） | 极低 | Anthropic dynamic filtering default-on |
| 10 | 把子 agent 定位为上下文归约手段：大输出探索交给 child，只取回结论；在 `agents.spawn` 的 JSDoc 写明回传契约（结构化摘要 + 文件路径，不回传原始工具输出）和判据「parallel context-heavy research or independent implementation 才委派；single known lookup, edit, or command 直接做」 | Adopt（prompt） | 零 | Anthropic 多 agent 博客（1,000–2,000 token）；prime-agent `buildSubagentGuidance`；Claude Code Workflows `agent(prompt, { schema })`；K2.5 Agent Swarm |
| 11 | policy 区分 compaction 与 restart：compaction 后 Realm 变量仍然活着，直接从变量继续；只有 restart notice 才从文件重建。现有 `policy.ts:46` 只讲 restart | Adopt（prompt） | 零 | Claude Code 压缩后需重读 ≤5 文件、Anthropic harness 博客改用 context resets——本项目不需要，这是独有优势 |
| 12 | 增加 Realm 私有绑定 `llm(prompt)` / `llm_batch(prompts)`：无状态子调用，走 `ctx.llm.stream()`，受现有 host-call 预算约束；同时写入 `.d.ts` 与批量预算规则 | Adapt（runtime，小） | 中 | RLM 论文；`dspy.RLM`；`alexzhang13/rlm`；本项目 `refine` 绑定已示范同一模式 |
| 13 | 预算可见：每个 `repl` 结果尾部追加一行会话级 REPL 输出累计 / 窗口，并在 spill/preview 时附变量目录（名 / 类型 / 大小）。纯追加，不改写历史，KV cache 代价为零 | Adapt（runtime，小） | 低–中 | Chroma Context-1 continuous visibility（prune accuracy 0.824 → 0.941）；VISTA 消融（dashboard 独立于归档工具）；Context Rot 拒答率 0.035%（模型不会自报） |
| 14 | DeepSeek 路由的 compaction 策略：为 `deepseek-official/deepseek-v4-flash` 配 `modelPolicies`（更低 thresholdRatio 或 retainTokens） | Adapt（config） | 极低，需评测 | 本地零 compaction；context rot 证据 arXiv:2607.17937 |
| 15 | 按轮观测掩蔽：保留最近 3–5 个 cell 的完整显示，更早 cell 的 logs 段替换为占位符 + locator（错误豁免，一次掩够） | Defer（先确认 DSH 是否允许 compaction 之外的 surface replace，再评测） | 中，破坏 KV cache | JetBrains arXiv:2508.21433（成本减半、solve rate 持平摘要）；Microsoft arXiv:2606.10209（全量 71% < 最近 5 次 79%）；Anthropic `keep: 3`；反证 arXiv:2607.12161（token −38.4% 但 billed +6.8%） |
| 16 | 超预算后的 hard cutoff：`repl` 结果只回 locator 不回内容，直到模型归约 | Defer（依赖第 13 条） | 中 | Chroma Context-1 |
| 17 | compaction 摘要里点名仍需用到的 REPL 变量 | Defer（需 DSH summarize hook） | 中 | PrimeIntellect rlm-harness README |
| 18 | `refine` 承载「输出归约模式」条目（如 `npm test` 只留失败段）；采纳 ACE 的 brevity bias / context collapse 两个失效模式概念 | Defer | 中 | TACO arXiv:2604.19572；ACE arXiv:2510.04618 |
| 19 | 可协商的输出预算：让模型在 cell 里声明本次显示预算（Codex `// @exec: {"max_output_tokens": N}` 的等价物），并把 spill notice 补足为「原始大小 / 总行数 / shape sketch / 截断起始行 / locator + 回读指令」四件套（现在只有最后一项） | Defer（后者属 DSH spill-policy） | 中 | Codex `exec` pragma 与截断头；pydantic `shape: {sketch}`；OpenHands "truncated part starts around line N" |
| 20 | 核查本项目与 DSH 的 plugin 注入是否以 user 角色发送：`refine` 结果经 `agent.steer(createUserMessage(...))`（`src/continual/plugin.ts:127`）、repl 图片转发 `exec.deferContext(createUserMessage(...))`（`src/repl/bridge.ts:67`）、DSH `repeat-tool-reminder` 的 `additionalContexts`。DeepSeek-V3.2 §3.2.1：新 user message 会丢弃历史推理内容 | Adapt（先核查，可能零改动） | 低 | arXiv:2512.02556 §3.2.1；DSH `MessageSource.kind: 'plugin'` 是否在请求序列化时仍为 `role: user` 待确认 |
| — | 动态工具发现/渐进披露 | Reject | — | SDK 约 14k token 远低于 MCP 1–5% 阈值；破坏稳定前缀 |
| — | 为「更像 code mode」移除 `edit`/`apply_patch` | Reject | — | arXiv:2607.10569 edit friction：output token +39.9% |
| — | 照搬 RLM 的 `context` 变量与 `FINAL_VAR` 协议 | Reject | — | 本项目无单条超长输入场景；论文自陈协议脆（16%/13% 出错） |
| — | Kimi 式纯头部截断、DeepSeek 论文的 discard-all | Reject | — | REPL 模式下 curate 失败即永久丢失；discard-all 是搜索任务结论 |

第 1–11 条是纯提示词改动，按 [[evidence-by-active-eval-not-usage-gates]] 的立场应按设计判断一次做齐，再用第 6 节的离线评测验证；第 12–14 条是小 runtime/config 改动，先做 12 与 13（互不依赖），14 视评测决定；15–18 等前面上线并有对照数据后再议。验收口径必须是 billed cost + 成功率 + 多次重复的方差，不是 token 数（arXiv:2607.12161、arXiv:2608.06503）。

## 2. 本地证据：Prime 会话里 code mode 的实际使用

数据来源：`~/.dsh/sessions/**/session.jsonl.zstd` 中所有含 `repl` 调用的会话（2026-09-04 扫描，只读；脚本 `scripts/eval/analyze-repl-usage.mjs`，用法 `node scripts/eval/analyze-repl-usage.mjs --samples 5 --out <json>`）。cell 分类按「嵌套 `tool/code-dispatch` 数 + 代码特征」判定；`single-call-processed` 抽样核对后基本是 `r.lines.map(l => \`${l.number}: ${l.text}\`).join('\n')` 式格式化回显，不是归约。（证据等级 L）

| 指标 | deepseek-v4-flash（60 会话 / 4656 cell） | gpt-5.6-sol（81 会话 / 7486 cell） |
| --- | --- | --- |
| 一 cell 一次调用（原样回显 + 格式化回显） | 27% + 41% = 68% | 42% + 17% = 59% |
| 多调用组合（循环 / `Promise.all*` / 归约） | 14% | 20% |
| 纯计算 cell（0 次调用，只处理变量） | 4% | 3% |
| 有调用的 cell 中，可见输出 ≤ 原始输出 50% | 16% | 12% |
| 有调用的 cell 中，可见输出 ≥ 原始输出 90% | 61% | 77% |
| 原始输出 ≥ 4k 字符的 cell 里做了 ≤50% 归约的 | 16% | 22% |
| 声明了顶层变量的 cell | 94% | 80% |
| 声明的变量名在后续任一 cell 被引用 | 9% | 8% |
| cell 代码引用了更早 cell 的变量 | 14% | 18% |
| 使用 `$_` | 0% | 0% |
| `read` 带 offset/limit | 55% | 82% |
| 同名同参数重复调用 | 7% | 4% |
| 触发 12KB spill 的 cell | 11% | 16% |
| 可见结果字符数 mean / p50 / p90 | 3444 / 1573 / 10951 | 3418 / 1478 / 11374 |
| 每 turn cell 数（≈ 模型往返次数） | 67 | 19 |
| 每 turn 回流可见字符 | ~232k | ~65k |
| compaction 摘要 / prune 替换 | 0 / 0 | 9（8 个会话）/ 397 |

解读：

- 模型把 REPL 当 one-shot 工具用是主流形态。「声明变量」这条 policy 被执行了（80–94%），但「复用变量」没有（8–9%），即 declare-and-forget。
- `$_` 整段固定提示在 12k 个 cell 中零使用，是纯上下文开销。
- 归约主要发生在 gpt-5.6 的 `Promise.all*` 批量读取里（20% cell），但批量读取的可见输出仍常顶到 12KB（p90 ≈ 11k）：「并行」没有带来「压缩」。
- DeepSeek 路由：`llm-deepseek` 适配器 `DEFAULT_CONTEXT_WINDOW = 1_000_000`（`packages/llm/llm-deepseek/src/adapter.ts:140`），`compaction-basic` 阈值 0.8 → 80 万 token 才触发；60 个会话零 compaction、零 prune，每 turn 约 23 万字符工具输出直接堆进上下文，唯一控制是每 cell 12KB spill。
- gpt-5.6 路由有 397 次 prune 替换，说明 DSH 自带的 head/tail pruner 在压力下确实工作，但之前的所有 turn 都是全量。
- DSH base bundle 的 `repeat-tool-reminder`（阈值 [3,5,8]）在 Prime 下失效：它按连续同名同参调用计数，外层 `repl` 每次代码不同会打断链，嵌套的重复 `read` 永远数不到 3。

## 3. 现状盘点：本项目与 DSH 已有的上下文控制机制

| 机制 | 位置 | 参数 | 触发时机 | 对 Prime 的实际作用 |
| --- | --- | --- | --- | --- |
| 嵌套 `tools.*` 结果不进上下文 | `src/repl/bridge.ts` binding + DSH `tools/ptc-dispatch-log` | 日志副本另受 12000 字节 spill 臂 | 每次子调用 | 程序拿 canonical value；进上下文的只有 cell 的 logs 与 completion 显示。这是 Anthropic PTC "only sees the final output" 的同构实现，但提示词没告诉模型 |
| 模型可见 `repl` 输出 spill | Prime preset `prime-spill-policy`（DSH `@deepseek-ai/dsh-spill-policy`） | `maxInlineBytes: 12000`（DSH base 出厂 50000） | 每次 `repl` 结果 post-execute | 头尾各半预览 + locator；`read` 在模型侧跳过但 Prime 外层是 `repl`，所以 read 结果也会 spill；11–16% 的 cell 触发 |
| completion 单槽保留与 preview | `src/realm/*`、`src/index.ts` renderer | `maxCompletionFullBytes` 64 KiB、`maxCompletionProjectionBytes` 4 KiB、retained 8 MiB / 1e6 nodes | completion 超 64 KiB | 值留在 `$_`，模型见 preview；`$_` 零使用 |
| tool-result pruner | Prime preset `compaction` 组（DSH `compaction-tool-result-pruner`） | `thresholdChars 8192 / head 4096 / tail 1024`，marker `[... tool result middle pruned ...]` | 只在 compaction 压力或溢出时对当前 surface 全部 tool/result 运行 | DeepSeek 路由从未运行；gpt 路由 397 次 |
| 会话 compaction | Prime preset `compaction-basic` | `thresholdRatio 0.8`、`retainRatio 0.16`、`maxTokens 8192`、`auto true`；`summarize()` 是唯一子类 hook | `agent/pre-step` 压力或 `CONTEXT_WINDOW_EXCEEDED` | DeepSeek 1M 窗口下基本不触发 |
| 固定提示 | `src/index.ts:79-105` `REPL_AGENT_PROMPT`；`src/policy.ts:34-46` | — | 每次组装 | 机制说明为主，无归约动机、无示例、无预算 |
| 工具 JSDoc 追加 | `src/index.ts:107-117` `TOOL_AGENT_GUIDANCE` | edit/glob/grep/pwsh/write | — | 只有正确性约束，无归约提示 |
| 子 agent | `agents.spawn/fork`（continuable） | admission 即返回 id | — | prompt 有委派与非阻塞指导，但未定位为上下文归约手段；`agents.*` 使用率 1–3% |
| 无状态子调用 | 无 | — | — | RLM 核心原语缺失 |
| 变量目录 | 无 | — | — | 模型看不到自己 REPL 里有什么 |

## 4. 前沿来源综述

### 4.1 Code mode / 程序化工具调用

**行业实现已收敛为三件套**：工具面收缩（只暴露一个代码工具）、类型化 API 生成、输出硬限额。

| 实现 | 单工具 | 类型生成 | 输出限额 | 持久状态 | 来源 |
| --- | --- | --- | --- | --- | --- |
| Anthropic Programmatic Tool Calling | `allowed_callers: ["code_execution_20260120"]` | Python async 函数 | 只回流最终 stdout | ❌ | B/A https://platform.claude.com/docs/en/agents-and-tools/tool-use/programmatic-tool-calling |
| OpenAI PTC（2026-07-09 随 GPT-5.6） | `allowed_callers: ["programmatic"]` | JS 函数 | 同上 | ❌ 明写无 "persistent JavaScript state between program executions" | B https://developers.openai.com/api/docs/guides/tools-programmatic-tool-calling |
| Cloudflare `@cloudflare/codemode` 0.5.1（`cloudflare/agents/packages/codemode`） | `search()`+`describe()`+执行，发现在沙箱内 | TS interface + JSDoc | `DEFAULT_MAX_TOKENS = 6000`（24k 字符）砍尾 + "Narrow the request to reduce response size."；AI SDK 路径 `transformResult` opt-in、`logs` 永不截断 | ❌ 一次 execute；靠 durable log + `codemode.step` + snippets | D 源码；C https://blog.cloudflare.com/code-mode/ 、code-mode-mcp（1.17M → ~1,000 tokens）、dynamic-workers（2026-03-24，"can cut token usage by 81%"，厂商断言无基准） |
| Vercel AI SDK `@ai-sdk/code-mode` 1.0.49（2026-07-30 首 commit） | `code_mode`（QuickJS-WASI） | Zod → TS 签名；description ≤140 词由测试锁定 | **零截断，超限硬失败**（result 1 MiB / tool output 4 MiB → `CODE_MODE_SERIALIZATION_ERROR`） | ❌ 每次新 isolate | D 源码；B https://ai-sdk.dev/docs/ai-sdk-core/code-mode |
| LangChain deepagents `CodeInterpreterMiddleware`（2026-05） | QuickJS | `tools.*` | **结果截断 4,000 字符** | ✅ thread/turn/call 三档 | C https://www.langchain.com/blog/give-your-agents-an-interpreter （"up to 35% fewer tokens on some tasks"） |
| Pydantic AI Harness `CodeMode`（Monty 运行时，2026-03 起） | `run_code` | 类型化签名；description "The last expression's value is automatically captured as the return value ... Avoid `print()` for return values" | 30s/256MiB/`max_tool_calls = 100`（超限报错 "Call fewer tools, for example by filtering the inputs first, or split the work"）；截断是正交的 `tool_output_limits`：阈值 10,000 / 截断 4,000 / preview 1,000，默认 `Spill(then=Truncate())`，替身 "[Tool output too large ...; stored to handle ... Read it with read_tool_result(...)]\nshape: {sketch}"，源码自述 "the Claude Code pattern" | ✅ "State is preserved between calls (REPL-style)" | D 源码；B https://pydantic.dev/docs/ai/harness/code-mode/ |
| DSH PTC（`agent-tool-presentation: ptc`） | `run_code` | `declare const tools` 按字典序 | spill 50000 + pruner | ❌（one-shot） | D `packages/core/tools/src/ptc.ts` |
| **dsh-prime-agent** | `repl` | TS declaration + JSDoc | 12KB spill（事后） | ✅ 跨 cell | 本项目 |

**关键措辞（可直接改写进提示词）**：

- Anthropic PTC 文档：「Tool results from programmatic calls are not added to Claude's context - only the final code output is」「calling 10 tools directly uses ~10x the tokens of calling them programmatically and returning a summary」；四个官方模式：Batch processing with loops / Early termination / Conditional tool selection / Data filtering（`errors = [line for line in log_text.splitlines() if "ERROR" in line]` 然后只 `print(errors[-10:])`）。
- Anthropic《Code execution with MCP》（2025-11-04，https://www.anthropic.com/engineering/code-execution-with-mcp）：`allRows.filter(...)` → `console.log(pendingOrders.slice(0, 5))` → "The agent sees five rows instead of 10,000."
- Anthropic《Advanced tool use》（2025-11-24，https://www.anthropic.com/engineering/advanced-tool-use）：Tool Use Examples 让复杂参数准确率 72% → 90%，"keep it concise: 1-5 examples per tool"；PTC 复杂研究任务 43,588 → 27,297 tokens。
- Anthropic《Improved web search with dynamic filtering》（2026-02-17，https://claude.com/blog/improved-web-search-with-dynamic-filtering）：把「模型写代码过滤结果再进上下文」做成 `web_search_20260209` 的 default-on 行为，平均 input token −24%、性能 +11%。
- smolagents `code_agent.yaml` 规则 5："For tools WITH JSON output schema: You can confidently chain multiple tool calls and directly access structured output fields in the same code block!"；规则 6："never re-do a tool call that you previously did with the exact same parameters"；规则 10："The state persists between code executions"。截断文案 `..._This content has been truncated to stay below N characters_...`，头尾各半（`MAX_LENGTH_TRUNCATE_CONTENT = 20000`）。
- OpenHands `<EFFICIENCY>`（0.30.0 → 2026 SDK 逐字保留）："Each action you take is somewhat expensive. Wherever possible, combine multiple actions into a single action".
- DSH 自家 PTC（`ts-types.ts:259`）："Emit results with `return` and/or `console.log(...)`. Only what you print or return is program output. ... every other intermediate result stays out of the conversation, so extract just what you need."

**收益边界（A 级证据，必须并列引用）**：

- arXiv:2607.10569《When Does Restricting a Coding Agent to execute_code Help?》（2026-07，RIT）：三臂消融 × 两 agent，四格通过率全部打平（差 <3pp）而成本摆动 20–40%；SWE-bench × Claude 一格 code_only **+14.4%**（不显著），归因于 edit friction（禁用原生编辑后 output tokens +39.9%，edit chars 与 output tokens Spearman ρ = 0.488）；批量化是模型属性："Claude's API empirically does not batch on SWE-bench (code_only issues 30.1 calls per run vs. 27.9 for baseline)" 而 Codex 17.1 vs 22.9。论文自陈未测 few-shot prompting 等补救——本项目正处于它建议的「hard-enforced open harness」空白。
- arXiv:2608.11386《The Devil Is in the Interface》（2026-08）：11,700 条 trajectory，"Python CodeAct-style interfaces achieve similar task performance with 41.6% fewer steps and 56.3% lower token usage"，但 "more structured low-level interfaces improve consistency across repeated attempts by up to 4.7×"——REPL-only 的代价可能落在稳定性。
- arXiv:2608.06370《The Bitter Lesson of Tool Calling》（2026-08）：BFCL v4 上 PTC 在 11/14 模型 ≥ JSON；context rot 条件下 PTC +5.5%、JSON −2.3%、**filesystem 方案 −32.0%**——本项目的 spill→locator 回流正是 filesystem 形态，提示「让模型绕道文件取回」有代价，应优先教模型走变量。
- Anthropic 官方：τ²-bench（每轮 1–2 次串行调用）分数不变、成本 +8%，"Sequential single-call workflows do not benefit"；75-tool benchmark 计费 input −38%。
- arXiv:2607.22585《The Scaffold Effect》（2026-07）："Harness choice induces up to a 40x difference in tokens per solved task, while paired within-model pass-rate differences remain 0-8 percentage points."
- arXiv:2607.03691《Don't Blame the Large Language Model》：35 个 scaffolding 版本 resolve rate 无显著提升而 token +70%+。
- arXiv:2608.08654《The Scaffolding Matters More Than the Interface》："Agents frequently ignored the interface they were assigned, so comparisons that do not verify actual behaviour measure an unknown mixture."——评测必须核实模型实际路径。
- arXiv:2510.20909（MIT，2025-10）CodeAdapt：CodeAct + 5-shot bootstrap，"10-81% more token efficient"。

**其他单一代码工具型 harness 的源码要点（D）**：

- smolagents 两级预算：print logs 走 `DEFAULT_MAX_LEN_OUTPUT = 50000`，最后一句表达式的值走 `MAX_LENGTH_TRUNCATE_CONTENT = 20000` 头尾对折——与本项目 logs / completion 两段结构同构。
- prime-agent：`DEFAULT_MAX_OUTPUT_CHARS = 65536` 对 stdout / stderr / result 三路各自砍尾并追加 `[... output truncated at 65536 chars ...]`；REPL 内 `await bash(...)` 拿到完整输出，截断只发生在 Python → 模型这一跳，是机制性倒逼「在 Python 里 filter 后再 print」。
- `alexzhang13/rlm` 提示词："Long REPL stdout pollutes history the same way raw `context` does: if you want a recap, ask `llm_query` for a 1–2 sentence summary and `print` only that."；`nano-rlm` `TOOL_OUTPUT_MAX_BYTES = 20_000` 中间挖空。
- freeact（`gradion-ai/freeact`）系统提示最凝练："Print only final results. Store intermediate values in variables." / "When a tool result says full content was saved to a file, avoid loading the entire file unless necessary."；`tool_result_inline_max_bytes = 32768`、preview 2048。
- Cloudflare `normalize.ts`（81 行 acorn）把 markdown fence / `export default` / 具名函数 / 裸语句序列机械改写成单个 async 函数并自动 splice `return`；snippets 把跑通的组合固化为可复用脚本。
- LangChain：`langgraph-codeact`、`langchain-sandbox` 均已归档；继任者 deepagents interpreter 用 QuickJS 跑 JS/TS，已放弃「模型写 Python」路线。CodeAct 论文原句是 "up to a 20% **absolute** improvement ... up to 30% fewer actions"。
- 反向对照：E2B 模板主动关闭 IPython 截断（`max_seq_length = 0`）并放行 "it's okay to multiple calls to execute_python"；Google ADK 显式多工具 + "Chain sequential, dependent commands with && in a single Execute call"、`MAX_OUTPUT_CHARS = 30_000`；mini-swe-agent 彻底无状态仍 >74%——持久变量的价值在省重复读取，不在能力上限。
- 收敛点：单条输出 10k–30k 字符 + 头尾对折；截断文案本身承担教学（Cloudflare "Narrow the request to reduce response size."、pydantic 的回读指令与 shape sketch）。

**OpenAI Codex CLI 的 code mode（`codex-rs/code-mode*`，rust-v0.153.2，D）**——与本项目最接近的对照物：

- feature flag `code_mode_only`（"Restrict model-visible tools to code mode entrypoints (`exec`, `wait`)"）就是本项目的形态，截至 0.153.2 仍 UnderDevelopment / 默认关。
- `exec` 是 freeform grammar 工具（lark），description 全文以 "Run JavaScript code to orchestrate/compose tool calls" 开头；每次 `exec` 是 fresh V8 isolate，跨 cell 只能靠 `store(key, value)` / `load(key)`；模型可用首行 pragma `// @exec: {"yield_time_ms": 10000, "max_output_tokens": 1000}` 自选输出预算（默认 10,000 tokens）；`yield_control()` / `notify()` 流式回传；`ALL_TOOLS` 元数据让工具搜索也在 cell 里用 `ALL_TOOLS.filter(...)` 完成；`get_context_remaining` 工具在 code mode 下暴露为 `{ tokens_left }`。
- 通用截断中间砍、首尾各半，标记 `…{N} tokens truncated…`，并前置 "Warning: truncated output (original token count: {N})\nTotal output lines: {N}"——告诉模型原始有多大。
- `code_mode_warning.rs`："Code Mode is enabled in configuration, but model `{model}` does not advertise Code Mode support. This may degrade model performance."——OpenAI 认为 code mode 需要模型侧训练支持（`model_info.tool_mode`）。prime-agent 源码注释同样称其 REPL 提示为 "the trained buildRlmPrompt prefix"。**DeepSeek 模型是否在 `repl` 这种接口上训练过，是本项目所有提示词调优的上界约束。**
- `gpt-5.2-codex_prompt.md`（7,563 字符）里没有任何批处理/并行指令，工具用法全部外包给工具描述。

**Anthropic 2026**：《The new rules of context engineering for Claude 5 generation models》（Thariq Shihipar，2026-07-24）：Then → Now 六组转变（Give Claude rules → Let Claude use judgement；Give Claude examples → Design interfaces；Put it all upfront → Use progressive disclosure；Repeat yourself → Simple tool descriptions）；"think more about the design of your tools, scripts and files- what parameters does Claude have and how can they be more expressive?"。Claude Code Workflows（2026 新增）："A workflow script holds the loop, the branching, and the intermediate results itself, so Claude's context holds only the final answer."；`agent(prompt, { schema })` 返回 schema 校验的 JSON；中间结果只在 script 变量里；16 并发 / 1,000 agents per run。

**本项目相对同行领先且不应改动的两点**：cell 内工具调用仍走 DSH approval/sandbox（Vercel 文档 "Do not expose tools that rely on user approval to code mode"、微软 "Approvals apply to the execute_code call as a whole"，全行业未解）；工具面收缩是硬的（Anthropic 明写 `allowed_callers` "is not a hard API-level block ... Do not rely on it as a security boundary"）。

**MCP 规范**：2026 唯一版本 `2026-07-28` 未纳入 code mode / 工具搜索 / 大结果引用；维护者定调 "Code execution is meta to MCP"。非规范文档 Client Best Practices（2026-04-22，https://modelcontextprotocol.io/docs/2026-07-28/develop/clients/client-best-practices）建议渐进披露的切换阈值为工具定义占上下文 1%–5%，并建议用稳定的 `call_tool` meta-tool 保护 prompt cache——本项目 SDK 约 14k token、且全量注入即稳定前缀，因此**不做动态工具发现**。

### 4.2 RLM 与「上下文作为变量」

**RLM 原论文**（Zhang, Kraska, Khattab，arXiv:2512.24601，v3 2026-05-11，https://arxiv.org/html/2512.24601v3；代码 https://github.com/alexzhang13/rlm；证据等级 A）

- 系统提示三件套：`context` 变量、`llm_query`（"can handle around 500K chars"）、`print()`；策略句："first look at the context and figure out a chunking strategy, then break up the context into smart chunks, and query an LLM per chunk with a particular question and save the answers to a buffer, then query an LLM with all the buffers to produce your final answer."
- 截断的因果句："You will only be able to see truncated outputs from the REPL environment, so you should use the query LLM function on variables you want to analyze. ... Use these variables as buffers to build up your final answer."
- 与 CodeAct 的第三条区别（§2）："code running inside [the LM] must be able to invoke [the LM] on programmatically constructed transformations of [the prompt] (e.g., inside arbitrarily large loops), storing intermediate results symbolically."
- Figure 4(a)："in-context RLM trajectories greatly improve both overall performance and the initial decomposition attempt made by the RLM, even if the example is unrelated to the actual task."
- Appendix B：跨模型 prompt 不可移植（Qwen3-Coder 需要加一句防过度子调用：aim ~200k chars per call）；"Models without sufficient coding capabilities struggle as RLMs"；"RLMs without asynchronous LM calls are slow"；FINAL/FINAL_VAR 协议脆（训练数据中 16%/13% 的 turn 误用）。
- 成本（Observation 4）：中位数比 base 便宜，均值更贵，长尾来自找不到答案的轨迹。
- 附录 C.3 `<env_tips>`（LongCoT-mini，GPT-5.2：base 38.7 → RLM 50.6 → RLM + decomposition hints 65.6；同样 hints 给无 REPL 的 base 反而降到 28.6）：红旗清单 "> 2 turns in, < 3 llm_batch calls -> you're solving it yourself. Reset." "Remembering a value not in answers -> re-dispatch; working memory isn't reliable."——**分解提示只有配上 REPL + 子调用原语才有效**。

**官方实现 `alexzhang13/rlm` 的 prompt**（`rlm/utils/prompts.py`，本人 fetch 核实）：

- "REPL outputs over ~20K characters are truncated, so for longer payloads slice `context` and pass slices through `llm_query` rather than `print`-ing them whole."
- ORCHESTRATOR_ADDENDUM："As an RLM, you should act as an orchestrator, not a solver." "Push every long-context operation that would not fit comfortably in your own working window ... into `llm_query` / `llm_query_batched` calls instead of pulling that text into your own message stream. (Conversely: if a Python keyword / regex search over `context` would already pin the answer, or if a single visible passage already contains it, just read it directly — sub-LMs are for when the raw text won't fit or the question needs semantic interpretation.)"
- 双轴预算："a useful rough ceiling is ~100K characters per prompt" "~20 prompts per batch. Tiny-prompt mega-batches ... are the anti-pattern; fat-prompt small batches are correct."
- `llm_query` vs `rlm_query`："Use `llm_query` for simple, one-shot tasks: extracting info from a chunk, summarizing text, answering a factual question, classifying content. ... Use `rlm_query` when the subtask itself requires deeper thinking".
- 四原语 `llm_query` / `llm_query_batched` / `rlm_query` / `rlm_query_batched`，`rlm_query` 达最大深度自动降级为 `llm_query`；每轮 user prompt 极简 `Turn {i}/{max}`；第 0 轮守卫 "Look at the context first; do not provide a final answer yet."

**`dspy.RLM`**（https://dspy.ai/api/modules/RLM/ ；源码 `dspy/predict/rlm.py`，D）：保留名 `llm_query` / `llm_query_batched` / `SUBMIT` / `print`；`max_iters=20, max_llm_calls=50, max_output_chars=10_000`。指令模板最凝练的两条："USE llm_query FOR SEMANTICS - String matching finds WHERE things are; llm_query understands WHAT things mean." "MINIMIZE RETYPING ... re-access them via variables and parse/compute in code instead of retyping."

**PrimeIntellect**：

- 博客《Recursive Language Models: the paradigm of 2026》（2026-01-01，https://www.primeintellect.ai/blog/rlm ，C）：GPT-5-mini on DeepDive "the RLM is worse than the LLM, except when it is told a strategy"，"a lot of performance is being left untapped due to poor usage of the scaffolding"；补救是每轮 REPL 输出硬上限 8192 字符 + 环境相关策略提示；"tools beyond the Python REPL can be used, but only by sub-LLMs"；math-python 上 RLM 反而更差，"true potential ... will be unleashed after being train via RL"。
- 论文《Prime Agent: A Self-Improving RLM Harness》（arXiv:2608.23552，2026-08）："A persistent IPython REPL follows the Recursive Language Model abstraction for programmatic context processing and test-time compute, while Continual Harness preserves histories, memories, skills, prompts, and subagent specifications across trajectories."；ARC-AGI-3 RHAE Best@1 30% → 95.5%。
- 上游 `prime-agent` 当前（2026-09-01 checkout）：`rlm()` admission 即返回；`DEFAULT_MAX_OUTPUT_CHARS = 65536`；无 `llm_query` 原语；"Do not invent non-native wrappers such as `call_skill(...)` or `run_subagent(...)`"；CHANGELOG 默认递归深度 1 → 2；`Compaction removes individual variables whose serialized form exceeds 16 MiB`。
- `PrimeIntellect-ai/rlm-harness`（论文 C.3 所用，README）：阻塞式 `await rlm(...)` 返回 `.answer`，`asyncio.gather` 并行；>20KB 工具结果 head+tail 截断并报原始大小；compaction 后 kernel 变量保留，"The model is told to mention important variable names in its summary so the resumed branch knows what is available."

**2026 后续与谱系**：

| 工作 | 要点 | 与本项目关系 |
| --- | --- | --- |
| Context as an Environment / Scroll（阿里，arXiv:2608.21690，2026-08，本人核实） | append-only Event Log + 持久 Python kernel + typed namespace + "only explicitly printed projections enter the model's working view" + eviction index（landmark 指向 Event Log 地址）；LOCA_256K 86.7%（+37.4）；消融去掉 Event Log 后 BEAM_10M 73.1 → 19.9 | 与本项目同构（DSH session log = Event Log，Realm = kernel）；差在「只有显式打印进视图」被提示词兑现 + 可回取驱逐索引 |
| VISTA（arXiv:2606.30005，2026-06，本人核实） | "proprioceptively blind to their own context"；每步渲染 per-block token/age/status dashboard；training-free，LOCA-Bench Gemini-3-Flash 22.7% → 50.7%；消融 "the dashboard matters beyond archive and recovery tools" | 支持第 13 条「预算可见 + 变量目录」 |
| Agents Learn Their Runtime（arXiv:2603.01209，2026-03，本人核实） | 2×2 交叉："a stateless-trained model in a persistent runtime redundantly re-derives retained state, using roughly 3.5x more tokens" | 直接解释本地 declare-and-forget；对策是提示词显式声明命名空间存活并回显当前绑定 |
| Think, But Don't Overthink（arXiv:2603.02615，课程复现，n=20） | S-NIAH 上 DeepSeek v3.2 base 100% → RLM depth=1 85% → depth=2 70%；OOLONG 0% → 42.1% | 弱证据，方向：O(1) 定位任务上 RLM 净亏，需反向条款 |
| λ-RLM（arXiv:2603.20105，华为） | 类型化组合子替代自由代码；小模型 +21.9pp，405B 仅 +2.6pp；CodeQA 上强模型的自由 code-gen 反胜 | 不采用 |
| Recursive Agent Harnesses（arXiv:2606.13643，PwC） | 递归单元是完整 harness；Oolong-Synthetic GPT-5 71.75% → 81.36% | 对应本项目 `agents.spawn` |
| Context-Folding（arXiv:2510.11967）、AgentFold（2510.24699）、MemAgent（2507.02259）、ReSum（2509.13313） | 折叠/摘要自身交互历史，多需 RL 训练 | 与 REPL 变量正交；ReSum 即 K2.5 报告中的 "Summary" |
| CodeDelegator（arXiv:2601.14914） | code-as-action 的 "context pollution from debugging traces"；persistent Delegator + clean-context Coder | 支持第 10 条 |
| PRO-LONG（arXiv:2607.20064，Duke） | 保留完整结构化日志靠搜索取回："+18.0 pp ... 4.2-5.8x fewer tokens" | 支持「变量/文件保真 + 按需取回」而非提前压缩 |
| 空白 | 无任何 2026 一手评测把 RLM 跑在 SWE-bench / Terminal-Bench | 本项目要自己测 |

### 4.3 上下文工程：整理、压缩、剪枝、掩蔽

**Anthropic（A/B）**：

- 《Effective context engineering for AI agents》（2025-09-29，https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents ）："Context ... must be treated as a finite resource with diminishing marginal returns."；五条机制 compaction / structured note-taking / sub-agent（"returns only a condensed, distilled summary of its work (often 1,000-2,000 tokens)"）/ just-in-time retrieval（"maintain lightweight identifiers (file paths, stored queries, web links, etc.)"）/ tool design。2026 年 Anthropic 未再发专门的 context engineering 博客，由 harness engineering 承接。
- Context editing（https://platform.claude.com/docs/en/build-with-claude/context-editing ）`clear_tool_uses_20250919` 参数形状可直接借用：`trigger` 默认 `input_tokens: 100000`，`keep` 默认 `tool_uses: 3`，`clear_at_least`（把缓存失效代价显式建模为配置），`exclude_tools`，`clear_tool_inputs` 默认 `false`（**只清结果、保留调用参数**——与 JetBrains observation masking 定义一致）。占位符字面量官方未给。
- 服务端 compaction `compact_20260112`：`trigger` 默认 150,000 input tokens；默认 prompt "Write down anything that would be helpful, including the state, next steps, learnings etc."
- Memory tool `memory_20250818` 的注入提示 "ASSUME INTERRUPTION: Your context window might be reset at any moment"——**与本项目 `refine` 职责冲突**（AGENTS.md 明令不得把任务材料写入 continual state），任务材料走普通文件即可。
- Claude Code 文档（code.claude.com/docs）：auto-compact "clears older tool outputs first, then summarizes the conversation if needed"；单个超大输出反复填满时停止 auto-compact 报错而不循环；压缩后重注入最多 5 个读过的文件（>5,000 token 的只给路径）、skill 正文单个 5,000 / 总 25,000 token；subagent "the subagent's tool calls stay out of your context"；deferred tools 默认开启、`auto` 阈值为窗口 10%、"Claude's ability to pick the right tool degrades once you exceed 30–50 available tools"。
- 《Harness design for long-running application development》（2026-03-24，https://www.anthropic.com/engineering/harness-design-long-running-apps ）：用 **context resets（整窗清空）而非 compaction**，agent 间通信全走文件。对本项目的含义：Realm 持久，变量在 compaction/重置后仍在，"清空历史不丢工作状态"是本项目独有的长期方向。
- 《Scaling Managed Agents》（2026-04-08）：harness 通过 `getEvents()` 取事件流切片并 "transformed in the harness before being passed to Claude's context window"——与 DSH 的 surface/log 分离 + `tools/ptc-dispatch-log` waterfall 同一模式。

**Manus / Cognition（C）**：

- Manus《Context Engineering for AI Agents》（2025-07）七条中与本项目最相关：Restorable Compression（"the content of a web page can be dropped from the context as long as the URL is preserved"）——本项目天然具备三条恢复路径（变量、spill 文件、`$_`），但提示词只做了被动澄清（"A shortened display does not shorten the value"），没有主动授权少打印；Keep the Wrong Stuff In（"without evidence, the model can't adapt"）——任何掩蔽都要豁免错误；Design Around the KV-Cache（append-only、稳定前缀）。
- Cognition《Multi-Agents: What's Actually Working》（2026-04-22，https://cognition.com/blog/multi-agents-working ）："multiple agents contribute intelligence to a task while writes stay single-threaded"；review agent 必须有 "completely clean context"——对 `refine` 的 review gate 同样适用。

**论文（A 级，摘要或原文核实）**：

- The Complexity Trap（JetBrains Research + TUM，arXiv:2508.21433，NeurIPS 2025 DL4Code）：SWE-agent × SWE-bench Verified 五种配置，"a simple environment observation masking strategy halves cost relative to the raw agent while matching, and sometimes slightly exceeding, the solve rate of LLM summarization"；混合方案再降 7% / 11%；"raise concerns regarding the trend towards pure LLM summarization"。
- Less Context, Better Agents（Microsoft，arXiv:2606.10209，2026-06）：50 任务，全量历史 71.0% / 1,480,996 token；只留最近 5 对 79.0% / 535,274；剪枝 + 摘要 91.6%。**保留全部观测直接损害成功率。**
- Token Reduction Is Not Cost Reduction（arXiv:2607.12161，2026-07）："The largest compression setup reduced delivered tool-output tokens by 38.4% but increased billed cost by 6.8%"，Pearson r = 0.15；"prompt-cache creation and reads dominate the measured input-side cost"。只追加不改写历史的方案缓存代价为零。
- ACON（Microsoft，arXiv:2510.00615，ICML 2026）：observations 与 history 分开压，峰值 token −26–54%；映射到本项目：observation ≈ cell 显示输出，history ≈ 跨 cell 轨迹，前者归 spill/掩蔽、后者归 DSH compaction。
- Squeez（arXiv:2604.04979）：抽取式（verbatim）剪枝，移除 92% token、recall 0.86——代码 agent 的语义归约必须抽取式，路径/错误码/哈希不能改写；短期等价物是让模型在 cell 里 `grep`/`filter`/`slice` 而非复述。
- SWE-Pruner（arXiv:2601.16746）：先声明目标再按目标剪枝，SWE-Bench Verified token −23–54% 且成功率提升；零成本等价物是让模型在发起大输出调用前想清楚要看什么并就地过滤。
- TACO（arXiv:2604.19572）：从轨迹自动发现并复用压缩规则——与 `refine` 定位重合。
- TRACE（arXiv:2608.06503）：递归压缩 "can weaken the influence of recent interactions, increasing blocked actions, repeated exploration, and instability across runs"——压缩方案必须多次重复测方差。
- AdaCoM（arXiv:2605.30785）：Fidelity-Reliability Trade-off，强模型受益于保留细节、弱模型需更激进压缩——DeepSeek 系的默认值必须实测。
- Chroma Context Rot（2025-07，18 模型）：拒答率 69/194,480 = 0.035%——模型几乎不会主动说上下文太长；Chroma Context-1（2026-03-26，https://www.trychroma.com/research/context-1 ）：continuous visibility（每轮追加 token 用量）+ soft threshold + hard cutoff（超阈值拒绝一切非剪枝工具），prune accuracy 0.824 → 0.941、平均轮数 6.7 → 5.2。
- ACE（arXiv:2510.04618，ICLR 2026）：evolving playbook，两种失效模式 brevity bias 与 context collapse（"iterative rewriting erodes details over time"）；防御是增量 delta 更新。需核查 `src/continual/store.ts` 是否增量、`maxEntryContentChars: 4000` 是否制造 brevity bias。
- 其他：SmoothAgent（arXiv:2607.00151，压缩变换可提前异步执行，TTFT 最多降 11.9×）；Classifier Context Rot（arXiv:2605.12366，800K token 后漏检 2–30×）。

**开源 harness（A+ 源码）**：

- LangChain deepagents v0.7.13：`tool_token_limit_before_evict = 20000`（×4 = 80,000 字符）落盘到 `large_tool_results/`，占位符含 tool_call_id、路径、分页读取示范（"to read the first 100 lines, you can use the read_file tool with offset=0 and limit=100"）、head 5 行 + tail 5 行预览；`TOOLS_EXCLUDED_FROM_EVICTION = (ls, glob, grep, read_file, edit_file, write_file, delete)`；SummarizationMiddleware `trigger 0.85 / keep 0.10`；顺序契约先 offload 后 summarize。
- OpenAI Codex CLI（`codex-rs`）：auto-compact 阈值 = min(配置, 窗口 × 90%)；本地 compaction 保留 initial_context + 最近 ≤20,000 token 的 user 消息 + 摘要；摘要 prompt 精简为 6 行 handoff；注回前缀明确告知模型 "Another language model started to solve this problem and produced a summary ... use the information in this summary to assist with your own analysis"；工具输出模型级 `truncation_policy`（fallback `Bytes(10_000)`，head/tail 各半，占位 `…{n} tokens truncated…`）；`compact_token_budget` "skips model/server summarization and installs a fresh context window instead"。
- Gemini CLI 压缩前先做 "Reverse Token Budget"（从最新往回累计 functionResponse，超 50,000 token 的更老输出落盘替换）；摘要后 Probe 自校验（"Did you omit any specific technical details, file paths, tool results, or user constraints ..."）；注回为 user 摘要 + model "Got it. Thanks for the additional context!"。

**OpenHands V1 SDK**（`OpenHands/software-agent-sdk`，2026-09-04 源码，D）：

- CodeAct 已解体：V1 无 CodeActAgent 实现，默认工具 `terminal` / `file_editor` / `task_tracker`（`sdk/tool/defaults.py`）。**OpenHands 是 code-as-action 普适性的反证，不应引用为支持。**
- 截断分层：终端 `MAX_CMD_OUTPUT_SIZE = 30000`；通用 `DEFAULT_TEXT_CONTENT_LIMIT = 50_000`，`maybe_truncate()` head + notice + tail，`save_dir` 存在时按 sha256 落盘并在 notice 回填路径与截断起始行（"The complete output has been saved to {file_path} ... truncated part starts around line {line_num}"）；file_editor `MAX_RESPONSE_LEN_CHAR = 16000`，四条分型 notice 各带具体下一步（文本文件 → "retry this tool after you have searched inside the file with `grep -n`"；目录 → `ls -la`）。
- Condenser V1 只剩 NoOp / Pipeline / LLMSummarizing；V0 的 ObservationMasking（`attention_window=5`，窗口外替换为 `<MASKED>`）、AmortizedForgetting、BrowserOutput 已删除。默认 `max_size=80, keep_first=4`；触发分 REQUEST/TOKENS（HARD）与 EVENTS（SOFT）；摘要 prompt 固定 schema（USER_CONTEXT / TASK_TRACKING / COMPLETED / PENDING / CURRENT_STATE / CODE_STATE / TESTS / CHANGES / DEPS / VERSION_CONTROL_STATUS）+ 两个 few-shot。README 的四点权衡："condensation destroys the prompt cache, but doing so regularly keeps the cost of rebuilding the prompt cache low".
- 子 agent Task 工具：描述含 "When NOT to use the task tool: A single grep, find, or cat command would answer your question — just run it yourself"；`bash-runner` 示例 prompt 明确让子 agent 做输出压缩（"Provide a summary including the total tests run ... do not include the full stack trace"）；回传只有 `task.result` 文本 + 状态三元组，"The agent's results are authoritative"。
- 系统提示词无通用「别打印大量输出」条款：分工是**提示词管省轮次（`<EFFICIENCY>`），运行时管省 token**。

**SWE-agent / mini-swe-agent**（D）：

- SWE-agent README 顶部 warning：mini-swe-agent "has superseded SWE-agent"；自评 "Back then, we placed a lot of emphasis on tools and special interfaces for the agent. However, one year later, as LMs have become more capable, a lot of this is not needed at all to build a useful agent!"——ACI 原作者放弃了专用界面。
- SWE-agent `max_observation_length = 100_000`（默认尾截）；`bash_only.yaml` 改 10_000 + head/tail 各半，warning 列出四种自救（head/tail/sed、更精确 grep、重定向到文件再搜）。history processor `last_n_observations`（n=5，替换文案 "Old environment output: ({n} lines omitted)"）docstring 自承 "will break prompt caching ... most SotA models can now fit a lot of context, so generally this history processor is not always needed anymore."
- mini-swe-agent（v2.4.6，SWE-bench verified >74%）：191 行、bash-only、线性 history、无 condenser；`observation_template` 阈值 10,000，超出 head 5,000 + tail 5,000 + 四种自救 warning。**截断本身就是给模型的教学信息**。

**Kimi / DeepSeek**（D + A）：

- Kimi CLI（Python/TS 两版逐字对齐）：`DEFAULT_MAX_CHARS = 50_000`、`DEFAULT_MAX_LINE_LENGTH = 2000`、marker `[...truncated]`，流式头部保留、无落盘；无 code mode；`SimpleCompaction` 保留最后 2 条消息（消息计数口径）。
- K2.5 技术报告第 5 节："an agent swarm is a kind of proactive and intelligent context management ... differs from test-time context truncation strategies such as Hide-Tool-Result [2], Summary [71], or Discard-all [14] ... Only task-relevant outputs—rather than full interaction traces—are selectively routed back to the orchestrator."；评测附录 HLE 用 Hide-Tool-Result（只留最近一轮工具消息、**保留全部推理链**），BrowseComp 用 DeepSeek 的 discard-all（60.6% → 74.9%）。[2] Kimi-Researcher，[5] Anthropic 多 agent 博客，[14] DeepSeek-V3.2 arXiv:2512.02556，[71] ReSum。
- K3 报告 4.2.1：把 "context management strategies" 当作会导致过拟合的模块做随机化训练；"For BrowseComp we adopt a context-compaction strategy triggered at 300K tokens"。
- DeepSeek-V3.2（arXiv:2512.02556）§4.4：阈值 80% 窗口；Summary / Discard-75% / Discard-all；BrowseComp 上 Discard-all 67.6 vs Summary 60.2。§3.2.1："Historical reasoning content is discarded only when a new user message is introduced. If only tool-related messages ... are appended, the reasoning content is retained"；"frameworks, such as Roo Code or Terminus, simulate tool interactions via user messages ... may not fully benefit"——**Prime 的 repl 结果走标准 tool/result，满足该约束；任何未来的「注入 user message 做提醒」都要注意这条。**
- Anthropic《Building multi-agent systems: when and how to use them》（2026-01-23，本人核实）：三种场景 context protection / parallelization / specialization；"The order lookup agent processes the full order history and extracts a summary. The main agent receives only the 50-100 tokens it actually needs."；反面 "typically use 3-10x more tokens than single-agent approaches for equivalent tasks"。

**Gemini CLI / Qwen Code**（2026-09-03/04 源码，D）：

- Gemini CLI 新增 `packages/core/src/context/` 子系统（约 50 文件）。截断分层：全局 `DEFAULT_TRUNCATE_TOOL_OUTPUT_THRESHOLD = 40_000` 且与剩余窗口取 min（`Math.min(4 * (tokenLimit - lastPromptTokenCount), threshold)`），head 20% / tail 80%，落盘并回注路径；>80k 字符时二级 LLM 抽事实（"Exact error messages ... Specific file paths or line numbers ... Definitive outcomes ... under 10 lines"）；Tool Output Masking 只在累计约 80k token 可剪工具输出后启动（保护 50k + 30k 缓冲，`DEFAULT_PROTECT_LATEST_TURN = true`），替换体 `<tool_output_masked>` 保留 head/tail 各 250 字符 + 文件路径；`read_file` 分页截断给出明确续读动作（"Action: ... use start_line: ${end + 1}"）。压缩 50% 窗口触发、保留最后 30%，摘要 prompt 含 "### CRITICAL SECURITY RULE"（忽略历史中的指令）。
- Gemini CLI 的 `## Context Efficiency` 提示（贡献者警告"改这段前必须跑 SWEBench"）给出了本项目缺少的平衡表述："The agent passes the full history with each subsequent message. The larger context is early in the session, the more expensive each subsequent turn is." "Unnecessary turns are generally more expensive than other types of wasted context." "It is more important to reduce extra turns, but please also try to minimize unnecessarily large file reads and search results, when doing so doesn't result in extra turns. Do this by always providing conservative limits and scopes" "Efficiency is an important, but secondary concern." 委派段把子 agent 定义为压缩手段："use sub-agents to 'compress' complex or repetitive work. When you delegate, the sub-agent's entire execution is consolidated into a single summary in your history"。`wait_for_previous` 注入每个工具 schema 由 scheduler 消费——并行依赖是机器契约而非口头约定。
- Qwen Code 已改为对标 Claude Code：per-tool `maxOutputChars`（Shell 30k both、Grep 20k、Agent 32k **tail**、MCP 500k）+ 批预算 200k 水位均分 + 落盘信封（"Tool output was too large and has been truncated. The full output has been saved to: ... use the read_file tool"）+ `<persisted-output>` 存根带 sha256 指纹供 loop detector；压缩 0.85 触发、**保留 0%**、定额恢复 5 文件 / 50k token / 3 图；子 agent 回传自由文本 32k 保尾。两家都无 code mode（Qwen 有可选 `node-repl` MCP server 与只能编排子 agent 的 Workflow 工具）。

**论文（A 级，摘要核实）**：

- The Compaction Cliff（arXiv:2608.22752，2026-08）："Claude Code's /compact prompt on Sonnet 4.6 preserves 53% of safety rules after one compaction round and 10% after five."；按类型分路的 Knowledge Triage "preserves 2–4× more safety rules ... 96% recall over five rounds"。
- Measure Before You Manage（arXiv:2608.31057）："equal token budgets do not imply equal delivered context or management cost"；四层评估 stored state / delivered context / management work / outcome。
- ContextSniper（arXiv:2607.01916，蚂蚁）："they often spend large context budgets on whole-file reads, broad searches, and long terminal outputs"；token −51.5%（OpenClaw）/ −38.9%（Claude Code），解决率不变。
- When and How Context Rot Appears（arXiv:2607.17937）：8/10 → 3/10（11k → 299k 字符，p = 0.0698）；无普适阈值。
- Copilot 生产 trace（arXiv:2608.00101，Microsoft）："KV cache hit rates averaging 90% within a turn, but falling to 55% across turn boundaries and drastically invalidated after events like model switches or context compaction."——任何按轮改写历史的剪枝都要和缓存成本合看。
- Is Progressive Disclosure All You Need（arXiv:2607.17598）："A second, deeper routing level never helps ... one level is enough." "Progressive disclosure buys context, not intelligence".
- DADL（arXiv:2605.05247）：Code Mode 把 1,833 个工具定义的广告成本 "from approximately 142,000 tokens to approximately 1,000"；"the per-call cost of search and execute invocations is additional".

### 4.4 前沿 harness 源码横向对照

| harness | 单次工具输出限额 | 截断形态 | 可回取 | 组合鼓励（提示词） | 会话压缩 |
| --- | --- | --- | --- | --- | --- |
| mini-swe-agent v2.4.6 | 10,000 字符 | head 5k + warning + tail 5k | 否 | "exactly ONE bash code block with ONE command (or commands connected with && or \|\|)" | 无 |
| SWE-agent | 100,000（bash_only 10,000） | 尾截 / head-tail | 否 | — | last_n_observations n=5（默认已不用） |
| OpenHands V1 | 16k（editor）/30k（终端）/50k（通用） | head + notice + tail | 是（落盘 + 路径 + 行号） | `<EFFICIENCY>` combine multiple actions | LLM 摘要 max_size 80 / keep_first 4，软硬触发 |
| Claude Code（官方文档） | Bash ~30,000 字符（`BASH_MAX_OUTPUT_LENGTH`，上限 150,000）；MCP 25,000 tokens（`MAX_MCP_OUTPUT_TOKENS`，单工具 `_meta["anthropic/maxResultSizeChars"]` 到 500,000）；API 层 `clear_tool_uses` trigger 100k / keep 3 | 成功：落盘 + 路径 + 开头预览；失败：~10k 字符首尾摘录不给路径 | 是（Read/Grep；压缩后重读 ≤5 文件） | 工具用法在 description；subagent "The parent doesn't see the subagent's intermediate tool calls or outputs, only that final result."；Workflows 中间结果在脚本变量 | 先清旧 tool output 再摘要；200K（Sonnet 5 约 967K，来自文档检索摘要，未逐字核对） |
| Codex CLI（codex-rs 0.153.2） | 模型级 `truncation_policy`，fallback 10,000 bytes；code mode `exec` 默认 10,000 tokens，pragma 可改 | head/tail 各半 `…{n} tokens truncated…` + "original token count / Total output lines" | 否（`wait` 可取增量） | `exec` description "Run JavaScript code to orchestrate/compose tool calls"；system prompt 无批处理指令 | min(配置, 窗口 90%)；保留最近 ≤20k token user 消息；摘要前缀告知模型 |
| LangChain deepagents 0.7.13 | 20,000 token（80k 字符） | head 5 行 + tail 5 行 + 路径 + 分页示范 | 是 | — | 0.85 触发 / keep 0.10；先 offload 后 summarize |
| Gemini CLI 0.60 nightly | 40,000 字符（与剩余窗口取 min） | head 20% + 说明 + tail 80%；>80k 二级 LLM 抽事实；旧输出 `<tool_output_masked>` 250/250 | 是（落盘 + 路径） | `## Context Efficiency`：先减往返，再在不增往返时限制输出；`wait_for_previous` 机器契约；子 agent = 压缩 | 50% 触发，保留 30%，七段 + 防注入 |
| Qwen Code 0.23 | per-tool：Shell 30k / Grep 20k / Agent 32k tail / MCP 500k；批预算 200k | head 1/5 + tail 4/5 + 落盘信封 + sha256 | 是 | "make all independent tool calls in parallel"（仅提示词） | 0.85 触发，保留 0%，定额恢复 5 文件 |
| Kimi CLI | 50,000 字符 | 头部保留 | 否 | — | 保留最后 2 条消息 |
| DSH base（native） | spill 50,000 字节 | 头尾各半 + locator | 是 | — | pruner 8192/4096/1024 → compaction 0.8/0.16 |
| DSH PTC | 同上，只有 curated 结果进历史 | — | 是 | "Only what you print or return is program output — curate it" | 同上 |
| PrimeIntellect prime-agent | `DEFAULT_MAX_OUTPUT_CHARS = 65536`，stdout / stderr / result 三路各自砍尾；REPL 内 `bash()` 零截断 | 砍尾 + `[... output truncated at 65536 chars ...]` | 变量仍在 kernel | "Python is the orchestration language"；"Always assign read/search results to named variables"；"Delegate parallel context-heavy research ...; do a single known lookup, edit, or command inline." | 摘要点名变量；>16 MiB 变量清理 |
| **dsh-prime-agent** | 12,000 字节 | 头尾各半 + locator | 是（变量 + 文件） | 无（policy 首句是刹车） | DSH 默认（DeepSeek 路由从未触发） |

## 5. 对照与可吸收清单（详细）

本节编号独立于第 1 节表格；对应关系：5.1 的 1–8 ≈ 表格 1–11，5.2 的 9–11 ≈ 表格 12–14，5.3 的 12–16 ≈ 表格 15–18。

### 5.1 Adopt：提示词改动（零 runtime 成本，一次做齐）

1. **`src/policy.ts:35-36`**。删除 "Keep a simple action simple; introduce loops, helpers, parallelism, agents, or jobs only when the task benefits."，改为编排语言定位；"Assign intermediate results you will reuse." 改为无条件。参考措辞（需按 AGENTS.md「模型可见文案」规则最终润色）：
   - "TypeScript is the orchestration language: use it for loops, conditionals, parsing, filtering, and state. Tool calls are ordinary `await` expressions whose typed results you can bind, slice, and combine in the same cell."
   - "Assign every read/search/command result to a named variable and continue from it in later cells; do not re-run a call whose result is already bound."
2. **`repl` tool description（`src/index.ts:255`）与 `REPL_AGENT_PROMPT`（`src/index.ts:79-105`）**：
   - description 从 "Execute a TypeScript REPL cell." 改为承担「这个工具是干嘛的」的判断，参考 Codex：`Run TypeScript to orchestrate and compose tool calls in a persistent REPL cell. Call tools as await tools.name(args), bind results to variables, filter or aggregate in code, and display only what the next decision needs; top-level bindings persist to later cells.`
   - 补回 DSH PTC 的经济学："Only the cell's completion value and `console.log` output enter the conversation; everything else stays in the REPL. Filter, slice, count, or aggregate before displaying, and display only what the next decision needs."（freeact 的极简版可作备选："Print only final results. Store intermediate values in variables."）
   - 事前预算："Model-visible output per cell is capped at about 12 KB; a larger display is spilled to a file and replaced by a preview. Treat the cap as a budget, not a safety net."
   - 串联许可："Tool results are typed values (see `ToolOutputMap`); chain calls and access fields directly in one cell without displaying intermediate results."
   - 红旗自检 + 反向条款："If a cell is a single `await tools.x(...)` whose raw result becomes the completion, you are using the REPL as tool-call syntax; bind the result and reduce it instead. When one grep or one ranged read already pins the answer, read it directly—do not build machinery for a one-line lookup."
   - 持久状态兑现（LangChain 措辞）："A value bound in an earlier cell does not need to be re-read, printed, or reconstructed before the next step."
   - 平衡句（Gemini CLI 措辞，防止过度优化换来额外往返）："Extra turns cost more than extra output. Reduce turns first; then keep displays small when doing so does not force another cell. Quality remains the primary goal."
   - 删除 `$_` 三段中的两段，只保留 "`$_` is the latest non-undefined completion; assign it to a name before running another value-producing cell." 一句。
3. **few-shot（放在 `REPL_AGENT_PROMPT` 之后、declarations 之前，每个 ≤6 行）**：
   ```ts
   // batch + reduce: one cell, many calls, small display
   let hits = await tools.grep({ pattern: 'TODO', path: 'src' })
   let byFile = Map.groupBy(hits.matches, m => m.path)
   ;[...byFile].map(([p, ms]) => `${p}: ${ms.length}`).join('\n')
   ```
   ```ts
   // locate before reading: grep for the anchor, then read only the relevant range
   let file = 'D:/work/app/src/server.ts'
   let anchor = (await tools.grep({ pattern: 'listen\\(', path: file })).matches[0]
   let slice = await tools.read({ file_path: file, offset: Math.max(1, anchor.lineNumber - 10), limit: 40 })
   slice.lines.map(l => `${l.number}: ${l.text}`).join('\n')
   ```
   ```ts
   // early termination across candidates
   let found
   for (const p of candidates) { const r = await tools.read({ file_path: p, limit: 5 }); if (r.lines.some(l => l.text.includes('#!/usr/bin/env node'))) { found = p; break } }
   found ?? 'none'
   ```
   RLM 论文 Figure 4(a) 表明示例即使与当前任务无关也有效；Anthropic 建议每工具 1–5 个示例。DSH 上游本来就有 `renderBashExample` 的样例机制（只在 bash schema 能接受示例字面量时渲染），本项目截取声明块时把它一并丢了；这里的样例应是归约型，不是单调用型。
4. **spill / preview 文案**（`src/index.ts` renderer 与 spill notice）：在 "The complete value remains in this REPL as `$_`" 之后加动作句："Continue from the variable: slice, filter, count, or grep it in the next cell; do not print it whole again."；retained preview 已带 Type / Serialized size / 结构 preview，即 pydantic 所说的 shape sketch，保持。
5. **工具 JSDoc 单点提示**（`TOOL_AGENT_GUIDANCE`）：`read`："For files over a few hundred lines, grep first and read only the relevant range; keep `lines` in a variable and display a slice."；`grep`："Aggregate `matches` (group by path, count, or filter) before displaying when there are more than a screenful."；`pwsh`："Bind `stdout.text` and display only the lines you need (for example the last 40 or lines matching an error pattern)."
6. **子 agent 定位**（`policy.ts` 与 `agents.spawn` 的 JSDoc）："Delegate parallel context-heavy research or independent implementation; do a single known lookup, edit, or command inline."（prime-agent 原句）+ "Delegate exploration that would flood this conversation with output (wide searches, long logs, many files) to an agent, and ask it to report only conclusions, counts, and paths—a few hundred words, not transcripts."（Anthropic 给出的量级是 1,000–2,000 token。）`agents.spawn` 的 `prompt` 参数 JSDoc 加：子 agent 的 prompt 应含 objective、output format、tool guidance、task boundaries（Anthropic 多 agent 研究系统），并要求 report 为结构化摘要 + 文件路径。
7. **compaction 与 restart 分开**（`policy.ts:46` 现在只有 "After a restart notice, rebuild from files and verify external state"）：加一句 "After a conversation summary (compaction), your REPL variables and functions are still alive; continue from them instead of re-reading or recomputing. Only a restart notice means the namespace was lost." 两个场景的正确动作相反，模型容易混淆并在 compaction 后重算。
8. **spill 占位符加纠正建议**（SWE-agent / mini-swe-agent 写法）：在 locator 之前加 "Next time filter or slice in the cell before displaying."。

### 5.2 Adapt：小 runtime / config 改动

9. **`llm(prompt, options?)` / `llm_batch(prompts, options?)` Realm 私有绑定**。实现路径与 `refine` 相同（`src/continual/plugin.ts` 的 `bindingFor` → `CodeBindingNamespace`；模型调用复用 `src/continual/command.ts` 的 `ctx.llm.stream()` + `modelTarget(agent)`），不注册 DSH tool、不进 `tools.*`，但**必须**写进生成的 `.d.ts`（上游明令 "Do not invent non-native wrappers"）。并发受现有 `maxParallelHostCallsPerRun: 16` / `maxHostCallsPerRun: 200` 约束，天然满足 "~20 prompts per batch"。提示词同时加 dspy 那句 "String matching finds WHERE things are; `llm` understands WHAT things mean" 与预算规则（~100K chars/prompt、fat-prompt small batches）。与 `agents.spawn` 分工按 `alexzhang13/rlm` 的 `llm_query` vs `rlm_query` 两句。前置核实：`ctx.llm.stream()` 在 cell 内并发调用是否触发审批或计费策略。
10. **预算可见 + 变量目录**：`renderReplResult` 已在拼装文本，在每个 `repl` 结果尾部追加一行会话级累计（例如 `REPL output so far: ~62k / 128k tokens`，数据源 `ctx.tokenMeter`，preset 注释说明它留在 host 层且 agent 行可解析到同一实例，需确认 Agent scope 可达）；在 spill notice / retained preview 后附一行 Worker 侧生成的变量目录（顶层变量名、类型、序列化大小上限估计），或提供 `vars()` helper。两者都是纯追加、不改写历史，KV cache 代价为零。VISTA 消融证明「让模型看见自己的状态」独立有效；Context-1 的 continuous visibility 同理。另一种形态是 Codex 的 `get_context_remaining`（code mode 下返回 `{ tokens_left }`）：提供一个 `contextRemaining()` 绑定让模型按需查询，比每个结果都追加更省，但依赖模型主动调用；两者可并存。变量目录需要 Worker 端改动，注意不调用用户 getter/Proxy（沿用现有分类器约束）。
11. **DeepSeek 路由 compaction 策略**：在 Prime preset `compaction-basic` 加 `modelPolicies: [{ provider: deepseek-official, model: deepseek-v4-flash, thresholdRatio: ..., retainTokens: ... }]`。默认值按上游比例拍（例如 K3 在 1M 窗口用 300K 触发 → thresholdRatio 0.3），评测后调整。这是纯配置。

### 5.3 Defer

12. **按轮的 `repl` 结果掩蔽**：保留最近 3–5 个 cell 的完整显示（对齐 Anthropic `keep: 3`、Microsoft last-5），更早 cell 的 logs 段替换为占位符 + locator；completion 段倾向保留；错误豁免（Manus）；占位符重申「值仍在变量里」并附纠正建议；一次掩够（`clear_at_least` 的道理）。证据强（JetBrains 成本减半、Microsoft 全量 71% < 最近 5 次 79%），但两点未定：DSH 是否允许 compaction 之外的 surface `replace`（`tool-result-pruner` 走的是 compaction backend 路径；若不允许则改做请求组装时的渲染层掩蔽，需确认 DSH seam），以及缓存代价（Copilot trace 跨轮命中 90% → 55%；arXiv:2607.12161 的 billed +6.8%）。OpenHands V1 删掉全部 masking condenser 是唯一反向信号（Gemini CLI 新增 masking、Claude Code 先清 tool output 是同向信号）。掩蔽/压缩按「消息类型」而非「位置」分路也未验证：Kimi K2.5 在 HLE 上丢工具结果、留完整推理链；The Compaction Cliff（arXiv:2608.22752）的 Knowledge Triage 按类型分路 "preserves 2–4× more safety rules"。
13. **hard cutoff**：超预算后 `repl` 结果只回 locator 不回内容，直到模型归约（Context-1）。依赖第 10 条先让预算可见。
14. **compaction 摘要点名 REPL 变量**：需要覆盖 `compaction-basic` 的 `summarize()` hook（DSH 声明为唯一子类 hook）或等 DSH 提供摘要提示扩展点；先看第 10 条的变量目录是否足够。
15. **`refine` 承载「输出归约模式」条目**（TACO、ACE）：如「`npm test` 结果只保留失败用例段」「grep 超 50 行先 `.length` 再抽样」，有明确成功判据（下次同类调用的输出体积）。归约模式是策略不是材料，应不违反 AGENTS.md 对 continual state 的限制，实现前明确边界；同时核查 store 是否增量更新、`maxEntryContentChars: 4000` 是否制造 ACE 所说的 brevity bias。
16. **环境/任务相关策略提示、`answer` 字典式输出通道**（PrimeIntellect）：改变输出契约，二期。`agents.spawn` 的可选 `schema`/`outputFormat`（Claude Code Workflows `agent(prompt, { schema })` 返回 schema 校验 JSON）同属此类：DSH Subagent 若原生支持结构化 report 再接。
17. **可协商输出预算与截断元信息**：Codex 让模型用 `// @exec: {"max_output_tokens": N}` 自选预算，既是控制也是每次写 cell 都看到的强提示；截断头报原始 token 数与总行数。本项目等价物是给 `repl` 加可选 `maxDisplayBytes` 参数或 cell 首行 pragma，以及在 spill notice 里报原始总字节/行数（后者在 DSH `spill-policy`，需上游改动或 Prime 侧包装）。等第 13 条预算可见上线后再评估。

### 5.4 Reject

- 动态工具发现 / 渐进披露：SDK ≈ 14k token，远低于 MCP Client Best Practices 的 1–5% 阈值；破坏稳定前缀（MCP 维护者因 cache 失效质疑 `tools/list_summary`）。
- 为「更 code mode」移除 `edit`/`apply_patch`/`write`：arXiv:2607.10569 的 edit friction 数据；本项目保留原子编辑是相对论文 code_only 臂的架构优势。
- 照搬 RLM `context` 变量、`FINAL`/`FINAL_VAR`：本项目无单条超长输入；协议脆。
- Kimi 式纯头部截断、无落盘：REPL 模式下 curate 失败即永久丢失（sub-kimi-dsh 判断，本文同意）。
- 把 DeepSeek 论文的 discard-all 搬到编码 harness：那是搜索任务结论，编码历史里有文件与错误信息。
- 用 user message 注入提醒/摘要：DeepSeek-V3.2 §3.2.1 说明新 user message 会丢弃历史推理内容。
- 把 Anthropic memory tool / Letta memory block 模式塞进 `refine`：定位是任务材料，与 AGENTS.md 对 continual state 的限制冲突；任务材料用 `tools.write`/`tools.read` 即可，缺的只是 "ASSUME INTERRUPTION" 式的紧迫感文案。
- 用 acorn 之类做 cell 归一化（Cloudflare `normalize.ts`：把 markdown fence / `export default` / 具名函数改写成单个 async 函数）：属自研变换代码，维护成本是一等约束（[[avoid-owned-transform-code]]）；DSH 已在执行前整体解析 cell 且本地 cell 错误率仅 4–7%，除非评测显示解析失败占主要份额，否则不做。
- 接管 DSH compaction 的摘要 prompt：短期不必；若将来接管，优先抄 Gemini CLI 的 Probe 自校验与 Codex 的 SUMMARY_PREFIX 告知，而不是自研摘要策略。

## 6. 评测方案

按 [[evidence-by-active-eval-not-usage-gates]] 与 [[lean-process-no-ceremony]]：便宜改动一次做齐，证据来自主动离线评测，只测会翻案的问题。

- **任务集**：10–15 个本仓库内可自动判分的任务，覆盖 fan-out/大结果型（全仓 grep 后分类计数、跨文件配对、大日志按错误类型统计、多文件 Add/Update）与串行推理型（单文件精确修改、单次命令诊断）各半。后者用于确认 τ²-bench 式「无收益也不变差」。
- **变体**：当前 prompt vs 第 5.1 节 prompt；（可选）+ `llm_batch`。每变体每任务 3 次。路由 `deepseek-v4-flash` 与 `gpt-5.6-sol` 各跑一遍（批量化是模型属性）。
- **过程指标**（先于结果指标）：每 cell 嵌套调用数分布；有调用 cell 的「可见/原始输出比」≤0.5 占比；声明变量的后续引用率；每 turn cell 数；每 turn 可见字符；spill 触发率；spill 后下一 cell 的动作类型（重打印 / grep / 归约）；同名同参重复调用率。这些指标 `scripts/eval/analyze-repl-usage.mjs` 已实现，对评测产生的会话目录直接运行即可。
- **结果指标**：通过率（必须同测）、**billed cost**（不是 token 数：arXiv:2607.12161 token −38.4% 对应 billed +6.8%）、cache read / cache write 分解（掩蔽类方案成败几乎完全取决于此）、成本中位数与 p90（RLM 论文 Observation 4：长尾在失败轨迹）、轮数与工具调用次数（Context-1 的收益体现在 6.7 → 5.2 轮）。
- **重复次数**：每格至少 3 次，报告方差（TRACE：压缩事件本身引入跨 run 不稳定性）。
- **翻案问题**：①新 prompt 是否把「可见/原始 ≤0.5」从 12–16% 提到 40% 以上且通过率不降；②`llm_batch` 在 deepseek-v4-flash 上是否被用、是否出现 tiny-prompt mega-batch；③DeepSeek 路由启用 compaction 后长会话通过率是否变化。
- **方法论警告**：核实模型实际走的路径（arXiv:2608.08654）；同预算不等于同交付上下文（arXiv:2608.31057）。

## 7. 未决问题与未能核实

- OpenAI GPT-5.6 GA 博客 403，流传的 24%/28%/38% 未核实；Cloudflare「81% token 削减」不在 2025-09 的 code-mode 博客里，而是 2026-03-24 dynamic-workers 博客的一句厂商断言（"simply converting an MCP server into a TypeScript API can cut token usage by 81%"），无基准细节，只作断言引用；Anthropic 的 150,000 → 2,000（98.7%）原文措辞为 "In this example"，是演示算术，实测数字以 PTC 文档（−38% / +8% / 20–40%）为准。
- RLM × SWE-bench / Terminal-Bench 无任何 2026 一手评测；本项目所在格子是空白。
- 没有论文直接把「code mode 下退化成一 cell 一调用」当研究对象；最接近的是 arXiv:2607.10569 的批量化副产物指标。本文第 2 节的指标是自定义的。
- `ctx.llm.stream()` 在 cell 内并发调用的审批/计费行为未验证（影响 `llm`/`llm_batch` 绑定，表格第 12 条）。
- Prime Intellect `rlm-harness` 的系统提示词未取到。
- GLM 无公开 harness；K2 Thinking 无独立报告；qwen-code 截断实现未深挖。
- 阻塞第 5.2/5.3 节落地的三个源码问题：Agent scope 能否读到 `ctx.tokenMeter`（preset 注释说它刻意留在 host 层）；DSH 是否允许 compaction 之外的 surface `replace`，或是否暴露请求组装时的历史变换 seam；`src/continual/store.ts` 是否增量更新。
- Anthropic `clear_tool_uses` 的占位符字面量、memory tool 临近清理时的 warning 措辞、Dynamic Cheatsheet 原文、Letta memory block 默认上限、TRACE/ACE/TACO 的具体数字：均未取得一手来源。
- Claude Code 的数字来自官方文档（Bash 30,000 字符、MCP 25,000 tokens、subagent 并发 20、嵌套 3 层），源码未直读。
- **上界约束**：Codex 的 code-mode 警告与 prime-agent 的 "trained buildRlmPrompt prefix" 注释都表明 code mode 效果依赖模型是否在该接口上训练过。DeepSeek 模型是否在 DSH `run_code`/`repl` 形态上训练过，无公开信息；这决定了提示词调优的天花板，也是评测必须用实际路由模型的原因。
- prime-agent 的截断已对账：`DEFAULT_MAX_OUTPUT_CHARS = 65536` 在 Python → 模型一跳对三路输出各自砍尾，REPL 内 `bash()` 不截断；此前一份报告称 execute 路径「无截断」是漏看了 kernel 层。

## 8. 来源索引

**本项目与 DSH 源码**：`src/index.ts`、`src/policy.ts`、`agent-presets/prime/agent.cordis.yml`；`D:/project/deepseek-harness/packages/core/tools/src/ptc.ts`、`ts-types.ts`、`packages/compaction/*`、`packages/spill/spill-policy`、`packages/guard/repeat-tool-reminder`、`packages/llm/llm-deepseek/src/adapter.ts`；`D:/project/prime-agent/packages/coding-agent/src/core/prompts/rlm.ts`。

**官方博客/文档**：Cloudflare code-mode（2025-09-26）、code-mode-mcp（2026-02-20）；Anthropic code-execution-with-mcp（2025-11-04）、programmatic-tool-calling 文档、advanced-tool-use（2025-11-24）、improved-web-search-with-dynamic-filtering（2026-02-17）、building-multi-agent-systems（2026-01-23）、new-rules-of-context-engineering（claude.com/blog，2026-07-24）、building-agents-with-the-claude-agent-sdk（2025-09-29）、how-we-built-our-multi-agent-research-system、effective-context-engineering-for-ai-agents（2025-09-29）、code.claude.com/docs（workflows、sub-agents、env-vars）、context-editing / compaction / memory-tool 文档、harness-design-long-running-apps（2026-03-24）、managed-agents（2026-04-08）、code.claude.com/docs（context-window、model-config）；Manus Context-Engineering-for-AI-Agents（2025-07）；Cognition dont-build-multi-agents（2025-06-12）、multi-agents-working（2026-04-22）；Chroma context-rot（2025-07-14）、context-1（2026-03-26）；LangChain context-management-for-deepagents（2026-01-28）；OpenAI tools-programmatic-tool-calling；Vercel code-mode；LangChain give-your-agents-an-interpreter（2026-05-20）；Pydantic harness code-mode；PrimeIntellect blog/rlm（2026-01-01）、blog/prime-agent（2026-08-05）；MCP client-best-practices（2026-04-22）、roadmap（2026-08-22）；dspy.ai RLM。

**开源仓库**：cloudflare/agents（`packages/codemode/src/{truncate,shared,proxy-tool,normalize,snippet,mcp}.ts`）、vercel/ai（`packages/code-mode/src/{tool-prompt,run-code-mode,utils/serialization}.ts`）、pydantic/pydantic-ai-harness（`code_mode/_toolset.py`、`tool_output_limits/`）、pydantic/monty、gradion-ai/freeact、PrimeIntellect-ai/nano-rlm、openai/codex（`codex-rs/code-mode*`、`code-mode-protocol/src/description.rs`、`core/src/tools/handlers/get_context_remaining.rs`、`utils/output-truncation`、`prompts/templates/compact/prompt.md`）、google-gemini/gemini-cli、QwenLM/qwen-code、langchain-ai/deepagents、alexzhang13/rlm、stanfordnlp/dspy、PrimeIntellect-ai/prime-agent、PrimeIntellect-ai/rlm-harness、huggingface/smolagents、OpenHands/software-agent-sdk、SWE-agent/SWE-agent、SWE-agent/mini-swe-agent、MoonshotAI/kimi-cli、MoonshotAI/kimi-code、deepseek-ai/deepseek-harness。

**版本锚点（2026-09-04）**：Codex `rust-v0.153.2` / main `8e6a44b428`；Gemini CLI `87a9c71d`（0.60.0-nightly）；Qwen Code `80497a74` / v0.23.0；OpenHands v1.16.0 + software-agent-sdk 无 release；SWE-agent v1.1.0（2025-05-22）；mini-swe-agent v2.4.6；kimi-cli / `@moonshot-ai/kimi-code@0.40.1`；DSH `dsh-v0.1.2-rc.1`（本机 `76fda72979`）；prime-agent v0.9.1（本机 `14e95fcf7`）；smolagents v1.26.0；`@cloudflare/codemode` 0.5.1；`@ai-sdk/code-mode` 1.0.49；alexzhang13/rlm v0.1.3。

**arXiv**：2512.24601（RLM）、2608.23552（Prime Agent）、2608.21690（Scroll）、2606.30005（VISTA）、2603.01209（Agents Learn Their Runtime）、2607.10569（execute_code 消融）、2608.11386（Devil in the Interface）、2608.06370（Bitter Lesson of Tool Calling）、2607.22585（Scaffold Effect）、2608.08654（Scaffolding Matters）、2607.03691、2608.01347、2609.00006、2604.03515、2608.23953、2510.20909、2601.14914、2605.05247、2608.23992、2607.15593、2607.17598、2608.22752、2608.31057、2607.01916、2607.20064、2511.22729、2607.17937、2608.09290、2608.00101、2603.02615、2603.15653、2603.20105、2606.13643、2510.11967、2510.24699、2507.02259、2509.13313、2512.02556（DeepSeek-V3.2）、2605.18747、2402.01030、2508.21433（Complexity Trap）、2510.00615（ACON）、2606.10209（Less Context, Better Agents）、2607.12161（Token Reduction Is Not Cost Reduction）、2604.04979（Squeez）、2601.16746（SWE-Pruner）、2604.19572（TACO）、2608.06503（TRACE）、2605.30785（AdaCoM）、2510.04618（ACE）、2605.12366、2607.00151。技术报告：MoonshotAI Kimi-K2 / K2.5 / K3 `tech_report.pdf`。
