# Context Capsule 交接设计方案(v0.4)

## 状态

提案 v2。v1 从 `6dcb551` 的原始设计继承了完整机制面(高熵 id、授权、配额、专用状态根),复查发现其中大半在防守一个当前部署形态下不存在的边界;v2 改为三级阶梯:L1 是零 runtime 代码的交接配方,机制只在被真实数据或真实信任边界触发时逐级引入。原 v1 的机制设计整体降级为 L3 附录。

本方案只覆盖 0.4 的 capsule 半边。Agent Family(spawn/list/send/collect/cancel/delete 与 DSH 能力盘点)另行设计;本方案只定义与它的接缝。

## 背景与判断

- 上游 Prime Agent(基线 `7787f074`)**没有 capsule 概念,也没有访问控制**:kernel 以 worker 的 OS 权限执行,child 有独立 session_dir 但读得到文件系统。*children receive only the context needed for their subtasks* 是**上下文纪律**,不是授权机制。可移植的不变量是纪律本身。
- DSH 的父子**本来就共享工作区**。已交付的 `src/subagent/report.ts` 提示词写明 "The agent that started you shares your workspace"、"reference relevant shared paths"。child 能直接读文件系统,任何 capsule id 授权都拦不住它声称要拦的访问——在这个边界上做授权是安全剧场。旧设计需要授权,是因为 `prime_context` blob store 让 capsule 穿越插件私有状态跨 Session 传递;那个底座已随 `ec4fccb` 移除。
- 交接的核心浪费在"复述":父模型把上下文重写进 child 任务提示,父输出付一遍 token 并丢保真度,child 整个生命周期背着这段内容。解法是把传输从模型上下文挪到程序平面——这只需要现有原语:Realm `state`、持久任务文件、`report`。
- 真实会话证据(61 个程序、`state.` 引用为 0,见 [implicit-state-repl-semantics.md](implicit-state-repl-semantics.md))表明机制存在不等于模型会用。交接是**两跳**惯用式(父要脱水,child 要按需读),采用率是第一风险;L1 配方恰好同时是采用率实验本身,失败无沉没成本。

## 目标

1. 交接只传**变量目录**:spawn 提示 = 任务说明 + 交接文件路径 + 每 key 一句 summary 的目录;完整值不进入任何一方的模型上下文。
2. child 在 `run_code` 程序内按需读取并归约,只让摘要进自己的推理上下文("先归约、后返回"在 child 侧自动生效)。
3. 回程对称:child 成果落文件,`report` 正文 = 摘要 + 路径(这正是 report 工具文案已经要求的形态)。
4. 每一级机制引入都有明确触发条件;没有触发就停在上一级,零成本。

## 非目标

- 不做访问控制:父子共享工作区是当前部署事实;真正的隔离需要沙箱,超出本插件范围。
- 不提供活引用或父子共享命名空间:交接文件写后不改,新数据写新文件;快照语义靠约定成立。
- 不做程序改写、不引入 parser:与 implicit-state 方案的第 4 级无关。
- 不重建 manifest/blob store,不做去重、引用计数或 quarantine GC。
- 不定义 Agent Family 的 spawn/消息/生命周期语义。

## L1:交接配方(零 runtime 代码,policy 交付)

```text
父: 选定 state 中的材料 keys → JSON.stringify 写入一个交接文件
    约定:写后不改;要给新数据就写新文件
    文件头部即目录:每 key 一句 summary + 大致规模
父: family spawn 提示 = 任务说明 + 文件路径 + 目录
    指令走 prompt,材料走文件:怎么做、约束、报告什么属于提示;数据属于文件
子: run_code 内读文件 → 程序内过滤、归约 → 只有摘要进推理上下文
子: 成果写自己的 state,结果落一个结果文件
子: report 正文 = 结论摘要 + 结果文件路径
父: 按需读结果文件;不把 child transcript 或完整结果注入自己的上下文
```

配方写进控制面 policy(`src/policy.ts`),要点:

- **快照语义讲给模型听**:交接文件是写入时刻的快照,父后续的 state 改动不会流过去;child 不等待"变量更新",父有新数据时写新文件并经 family 消息告知路径。
- **禁止把任务指令藏进数据文件**:指令与材料分家,保持提示的可审计性。
- **不可 JSON 化的值**(函数、Map/Set、实例)由父在脱水时显式转换——一行代码,变换归模型,与既有惯用式路线一致。

前置检查(能力盘点确认项,非设计工作):目标部署中 child 确实共享工作区并持有文件读工具。若某类部署不满足,该部署形态即 L3 的真实触发条件。

验收:配方是否被用、用得对不对,证据来自"启动条件与顺序"第 2 步的主动评测或使用中观察到的失败;发现不用或用错时先修配方与提示,不加机制。

## L2:`share` 糖(条件触发)

**触发条件**:真实会话显示 L1 的手写环节系统性掉链子——模型忘写目录、覆盖既有交接文件、格式随手不可读。

形态:一个几十行的 Code Mode SDK helper,`share(keys, summaries)` = 校验 summary、序列化、写唯一命名的新文件、返回路径与目录文本。无 id、无配额、无新状态根、无 delete;只固化易错的机械步骤,不引入任何授权或治理概念。

## L3:完整 capsule(条件触发,附录)

**触发条件**(任一,须有证据):

- 出现真正的信任边界:不可信 child、跨 Session 授予、沙箱化部署使工作区不再共享;
- L1/L2 采用率数据证明约定形态不可用,且失败模式确属机制缺失而非提示问题。

触发前本节只是记录,不投入实现。要点(v1 方案压缩):

- capsule = 对选定 state keys 的脱水快照,目录与值自包含单文件,落 `<stateDirectory>/capsules/`,写入走既有原子替换与跨进程锁;share 原子,失败不产生半个 capsule。
- 高熵随机 id 即授权凭证(不可用内容 hash);id 与磁盘文件名是否分离过安全审查;未持有 id 不能枚举或读取;错误与日志不泄露 Session id、宿主路径或其他 capsule 存在性。
- 序列化边界 = JSON,拒绝时点名 key 与原因;不用 `v8.serialize`(跨 Node 版本兼容长尾、不可审计)也不自研 structuredClone 编解码(自研变换代码,违背维护成本一等约束)。
- 工具面 `prime_capsule`:`share`/`catalog`/`read`/`delete`;`read` 值进程序不进 prompt;delete = 删单文件,无引用计数;配额(单 capsule bytes、单 entry bytes、每 Session 活跃数)沿用既有 limit 家族规则。
- mount 不做 heap 注入(要求 child 是 Prime Session,且大值常驻 heap 违背按需读取);活引用/可变共享同样否决(跨 Agent 竞态与失效通知)。

## 维护成本评估

- L1:零代码,成本是 policy 文本与一次能力盘点确认;失败即证据,无沉没成本。
- L2:几十行、无状态 helper;边角(命名冲突、summary 缺失)有限且本地。
- L3:授权、配额、原子性、安全审查的完整持有成本——这正是 v1 的全部重量,现在只在真实触发条件下支付。
- 各级共同的最大风险仍是采用率,因此配方与提示是每级交付物的一部分,不是文档补丁。

## 启动条件与顺序(与 state 阶梯合并启动)

本方案与 [implicit-state-repl-semantics.md](implicit-state-repl-semantics.md) 是同一惯用式在两个作用域的应用:run 之间用 state,Agent 之间用交接文件,对模型是一条流水线 `工具结果 → 程序内归约 → state → 选键脱水 → 交接文件`。且 L1 隐含依赖 state 被使用(材料不在 state 里就无从脱水),D8 keys 回显同时是父的选键界面。因此两边**合并交付**;节奏由本节唯一定义,implicit-state 文档的阶梯引用本节。

交付原则(2026-08-14 定):**零/低成本的部分按设计判断一次做齐,不设采用率门槛**——被动实测被第 0 步证明既不可靠(长驻进程装旧 policy、负载混杂、会话不独立)又太慢。数据只在提示词措辞需要对比时通过主动评测产生(见下),升级到贵机制只由真实需求触发,不由指标触发。

**第 0 步(并行,互不阻塞)——已完成,2026-08-14:**

1. 复测 f8a2d62 之后真实会话的 state 采用率——state 阶梯级 2/3 自己的证据门槛,不跳过。
   **结论:post-f8a2d62 的有效数据为 0。** 65 个会话中所有时间戳晚于提交的转录装的仍是旧 policy 文本(DSH 长驻进程在提交前启动,policy 编译进插件 `lib/`,派生子代理全部继承)。级 1 尚未被测试,更未被证伪,故第 1 步不并入级 3。测量方法固化于 `scripts/measure-state-adoption.mjs`;方法要点:逐 zstd 帧解压(Node 一次性 API 只解第一帧)、**按转录内实际 policy 文本分组而非时间戳**、转录 header 的 `agentPreset` 字段不可靠。同一旧提示词下 `state.` 使用率 1.3%→5.1% 的波动归因任务负载差异,不构成任何级别的证据。采数前置:重启 DSH 进程并确认新会话转录含新 policy 句。
2. Agent Family 能力盘点(0.4 门槛)——**结论:配方全链路可落地,且是结构性保证。** `subagent`/`subagent_fork` 的 `prompt` 无长度限制、逐字送达;continuable 子代理必然 in-process 且复制父 cwd(能覆盖 cwd 的 out-of-process provider 都未实现 `prepareContinuable`);child 继承父完整工具目录,`read`/`glob`/`grep` 在 Code Mode 下自动成为 SDK bindings。**硬约束确认:前台 subagent 工具结果超 8192 字符被 Prime preset pruner 裁剪,而 `report` 是 user message、完全豁免——"大材料走文件、结论走 report"是机制约束,不只是最佳实践。** spawn 提示无注入 seam(参数 freeze,`PreToolDecision` 明文排除 input rewriting),零代码教配方的唯一通道即父的 policy 文本,反向确认 L1 形态;自动注入需自研 spawn 工具替换,列为 L2/L3 才可考虑的成本。清理:child scope 上的 contribution disposer 可靠(新建与冷恢复都覆盖);`subagent/end` 触发时 child ctx 已销毁,清理逻辑不得依赖它读 child 状态。

**第 1 步(一个 PR,按设计判断一次做齐):**

- policy 写**一节**统一的脱水/水合章节:run 间惯用式(implicit-state 级 3:开头解构水合、结尾 `Object.assign` 脱水、helper 构造一次放 state)与 Agent 间交接配方(本方案 L1)同一套动词贯穿,不做条件化拆分。
- D8 keys 回显(约 20 行,无 parser)进同一 PR——交接选键使它从可选变为必需。
- 本 PR 代码量上限即该 20 行,其余全是 policy 文本。

**第 2 步(主动评测,按需):** 提示词措辞需要对比证据时,不等真实使用积累——离线造数据:

- 固定任务集(设计成天然受益于跨 run 复用与交接的任务)× policy 变体,起真实 DSH 会话批量跑;
- 用 `scripts/measure-state-adoption.mjs` 的指标自动评分:`state.` 使用与跨 run 复用、重复 helper 样板计数、交接文件与目录质量、report 体积;
- 模型输出有随机性:每变体多次重复,比较变体间增量而非绝对值;
- 被动的真实会话统计只作诊断参考,永不作发布门槛。

**升级触发(需求触发,非指标触发):** L2(share 糖)由评测或使用中观察到的系统性机械失误触发;L3(完整 capsule)由真实信任边界触发;implicit-state 级 4(runtime 水合)由真实需求触发,并始终受维护成本一等约束压制。

## 首次实测记录(2026-08-15,交付当晚)

隔离 DSH_HOME + headless 一次性会话,gpt-5.6-sol,任务为 18 个合成服务日志的分析 + 委派子代理写报告,提示词不含任何 state/交接/文件字样。

- **采用率**:根会话 17 个 `run_code` 程序中 **15 个(88.2%)**使用水合/脱水惯用式,且形态与 policy 所教逐字一致(开头解构、结尾 `Object.assign`);子代理 3/5。旧提示词全部历史队列为 1.3–5.1%。
- **配方全环节自发走通**:归约统计入 `state.stats` → 脱水到 `.task-handoff-log-stats.json` → spawn 提示 = 任务说明 + 文件路径 + 带 summary 与"约 5KB"规模的目录,并向 child 转述了按需读取纪律 → `run_in_background: true` admission-first,job id 存入 state → child 有界读取(limit 400)后写 `report.md` → 根会话独立复核 19 项数字 → **主动删除交接文件**(配方第 7 条)。全部数字与日志真值精确一致。
- **D8 回显**:每次结算出现,命名空间演进清晰可读(`logFiles → stats → handoffPath → reportAgentId → validation → handoffIntegrity → expected → reportText/reportLines → audit`),key 命名全部有意义——目录质量担忧未成真。
- **评分工具盲点**:首版正则只抓 `state.` 属性访问,把 policy 所教的两种形态记为 0;已修(`scripts/measure-state-adoption.mjs` 现按 dot/hydrate/dehydrate 三形态计)。教什么就要测什么。
- **部署缺口(headless 跑 Prime 需两处补齐,应向上游反馈)**:`@deepseek-ai/dsh-headless` bundle 不含 `agent-presets` 行;且 shipped runner 的 `agents.create` setup 钩子从不调用 `agentPresets.mount`(该钩子恰是 mount 的唯一受支持调用点)。测试用的 runner shim(官方 runner + 一行 mount)固化于 `scripts/eval/prime-headless-shim/`。
- **结论**:L1 一次实测即验证;未观察到任何指向 L2 的机械失误。

## 参考

- `6dcb551:docs/v0.3-roadmap.md` — 原始 Capsule/Family 设计(L3 的需求底稿)
- 上游基线 `7787f074`:`packages/coding-agent/docs/rlm.md`、`docs/rlm-runtime.md`、`skills/agent-message/SKILL.md` — 上下文纪律、admission-first 与 family 消息契约
- `src/subagent/report.ts` — 已交付的共享工作区与"report 引用路径"文案
- [implicit-state-repl-semantics.md](implicit-state-repl-semantics.md) — 阶梯方法论、脱水/水合语义与采用率证据
- [v2-architecture.md](../v2-architecture.md) — 0.4 边界与状态布局
