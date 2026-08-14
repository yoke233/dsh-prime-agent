# Prime Agent 大型 Tool 输出治理方案

## 状态

提案 v2(按对抗审查修订并瘦身)。只定义实现顺序、模块责任与验收标准,不表示改动已完成。

前置条件:`prime-preset-mount.e2e` 与 `prime-compose.e2e` 当前失败。实施本方案前必须先修绿并冻结测试基线,否则后续 E2E 与 differential 验收没有可信参照。

## 目标

1. 模型上下文和 Session 日志保持有界。精确承诺:对**成功完成 spill 的纯文本投影**保证有界;best-effort 降级(保持 inline)必须可观察告警,不得伪装成上限仍然成立。
2. `run_code` 程序仍拿到 Tool 声明的完整结构化 `value`,不破坏 SDK 类型和程序语义。
3. 完整内容通过 spill locator 恢复,而不是静默截断。恢复目标是 **Tool renderer 生成的最终格式化文本**,不是 canonical DTO 的某种默认 JSON 序列化。
4. Persistent Realm 不因一次普通大结果被无提示重启;真正越过安全预算时明确失败。
5. 复用 Harness 已有的 retention、spill 和 Code Mode seam,不在本仓库复制第二套输出系统。

## 非目标

- 不修改任何 Tool 的 canonical output schema。
- 不把大型 Tool 输出写入 `prime_refine`、system prompt 或 continual-learning state。
- 不让 Prime runtime 直接写 spill 文件,不新增第二个 `SpillStore`。
- 不把 spill 当持久业务存储;需要跨进程可靠恢复的结果仍进 `prime_context` 或外部 artifact 系统。
- 不在未获得实际数据前公开细碎的 head/tail 配置项。

## 已核实的现状

- Harness 分层:`dsh-output-retention`(机械保留)、`ctx.spillStore`(保存 + opaque locator)、`dsh-spill-policy`(何时 spill)。base composition 配 `maxInlineBytes: 50000`,覆盖 `tools/post-execute`(模型可见投影)与 `tools/code-dispatch-log`(nested 调用的耐久日志副本)两条路径;后者不改变程序已收到的结构化 `value`。
- Spill policy 是 best-effort 且只处理纯文本投影(`packages/spill/spill-policy/src/index.ts:138-231`):任意非文本 content block 不 spill;outer `read` 特意跳过(防 read→spill→read 循环),nested `read` 的 dispatch log 照 spill;无 owning Session、无 backend、`saveText` 失败、notice 自身超 cap 时保持 inline。spill 失败绝不把成功 Tool 调用变成 `isError`。
- Prime `maxOutputBytes` 是安全硬上限(`src/realm/protocol.ts` `OutputLedger`),只核算 logs/completion/失败消息,越界返回明确 `output-limit`。它与 `maxInlineBytes`(软投影预算)用途不同,不可合并。
- Binding 参数和返回值不入 outer ledger。通用 spill 只能收缩模型/日志投影,不能在不破坏 schema 的前提下替换程序收到的值。
- `prime_context`/`prime_refine` 自有输出已有界(catalog、offset/limit、pointer、search window、各类配额)。
- Hard cap 发生在 spill 之前:超过 `maxOutputBytes` 的字节到不了 `tools/post-execute`。现存不对称:log overflow 丢 generation,oversized completion 返回 `output-limit` 但保留 heap。spill 解决"已结算结果污染上下文",不解决"越过安全边界后的数据恢复",两者分开设计与测试。
- 与官方 one-shot runtime 的已知 ledger 差异:官方最小预算 4(`MIN_OUTPUT_BYTES`,code-runtime-worker-thread),Prime 最小预算 256 + generation notice reserve 160(`src/realm/protocol.ts:25`、`src/realm/runtime.ts:46`);官方 completion 走 stack-safe flat wire(`worker-json.ts`/`output-json.ts` 迭代编码),Prime 为递归校验 + `JSON.stringify` + JSON string wire 三层递归/字符串路径(`src/realm/realm-worker.ts:509-574` 及 done 消息)。
- `state` 只有 Worker heap 硬边界;`maxStateEntries` 不度量字节。policy 必须禁止把大型原始 Tool 结果长期塞进 `state`。

## 设计决策

- **D1 复用 seam**:Prime 不新增生产期 SpillStore/preview formatter/GC;删除 Harness spill policy 后 Prime 不伪装仍有该能力。
- **D2 完整 value 只在程序数据面**:程序收到完整 canonical value;Session dispatch 日志只存有界预览 + locator;模型不直接收到 nested value;禁止把 `string[]`/DTO 替换成 `{ spillPath }`。
- **D3 spill 后五断言**:预览 + notice 合计 ≤ `maxInlineBytes`;notice 说明遗漏量、locator、恢复方法;artifact 保存完整 UTF-8 文本且与 renderer 输出逐字节一致;UTF-8 裁切无替换字符;Session 日志不持久化完整大文本。
- **D4 spill 失败保持 best-effort**:不把成功调用改成失败,不隐藏 inline 内容;测试与诊断必须能区分"成功 spill"与"保持 inline 的降级"。
- **D5 程序内归约 policy**:不直接 return/print 大型中间结果;先过滤、聚合、计数、哈希或抽取;优先用分页/range/pointer/search window;可复用中间结果归约后写 `prime_context`,只返回 key、摘要和定位信息;已有 locator 时定点恢复,不整段灌回上下文。**大型原始结果不长期放入 `state`。**
- **D6 v1 不自动恢复 hard-cap 之外的输出**:`CodeRunRequest` 无 owning Session,spill store 要求 Session-scoped owner。v1 保持 `output-limit` fail-closed;自动恢复需求先在 Harness 建立 owner-aware `CodeOutputSink` seam(Phase 4),不在 Prime 私建 overflow 文件。

## 分阶段实施

### Phase 1:锁定现有 Harness 输出治理链

#### 1.1 Policy 文案(与失败恢复方案共享,一次完成)

`src/rlm/plugin.ts` 的 `orchestrationPolicy()` 与 `tests/code-mode.spec.ts` 同时被本方案和 [Tool 失败恢复方案](./tool-failure-recovery.md) Phase 1 修改。两份规则**合并为一次改动**:本方案贡献 D5 的归约规则,失败恢复方案贡献并行/重试/恢复规则。保持动态 Tool 名称解析,不硬编码自定义后的 `prime_context` 名称。测试断言 policy 含"先归约、后返回"且引用实际配置的 context Tool 名称。

#### 1.2 Fixture 与依赖

新增 `tests/large-tool-output.e2e.spec.ts`。Fixture:`SystemPrompt`、`ToolRuntime({ mode: 'code' })`、temp-root `LocalSpillStore`、`SpillPolicy({ maxInlineBytes: 1024 })`、Prime runtime + 真实 `registerRealmIdentity`、返回确定性大文本/大 JSON 的 synthetic Tool、带 `session.header.id`/`cwd`/可记录 `append()` 的固定 Agent。

补充 devDependencies 与 Vitest alias:`dsh-spill`、`dsh-spill-local`、`dsh-spill-policy`(peer 链含 `dsh-output-retention` 等,现有 alias 表已覆盖大部分)。禁止从全局安装目录导入。

#### 1.3 验收场景(合并后)

**场景 1(nested 完整 value + 日志 spill + Realm 保留)**:程序调用大输出 Tool,在 Realm 内用完整 value 计算确定性摘要(length、哈希、首尾标记),**只把归约结果写入 `state`**,completion 返回小对象。断言:程序计算确实使用了完整 value;`tool/code-dispatch` 内容 ≤ 1024 bytes、含 locator、不含完整文本;locator 文件与 Tool renderer 的完整文本逐字节一致;下一次 run 读取归约状态成功且 generation retained。

**场景 2(外层大结果)**:程序直接返回超阈值结果。断言:`tools.execute` 的 execution-local canonical `value.result` 完整;model-facing `content` 为有界预览 + locator;locator 可恢复完整格式化文本。耐久外层 `tool/result` 有界性属于 agent-loop/composition E2E(1.4),本 fixture 不伪造 agent-loop 的日志提交。

**场景 3(硬上限不变)**:completion 超过 Prime `maxOutputBytes` 仍得 `output-limit`;spill 不能把 runtime 安全失败伪装成成功。

**场景 4(UTF-8 与 cap 边界)**:2/3/4 字节 Unicode;notice 恰等于 cap;cap 小于完整 notice 时保持 inline 并 warning;空文本与恰不超 cap 时不建 artifact。

**场景 5(backend 失败)**:注入 `saveText()` 拒绝的 adapter。断言 Tool 仍成功、content 保持 inline、warning 可观察、无假 locator。

Harness 已完整覆盖的 retention/spill unit cases 不在本仓库复制。

#### 1.4 组合验收

在 Prime compose E2E 中增加一项行为断言:真实 profile 选择 Prime preset 后,大型 Tool 结果走现有 spill chain,且耐久外层 `tool/result` 不含完整结果。不满足于静态断言 base YAML 存在 `spill-policy`。

### Phase 2:收敛 Prime 与官方 output contract

范围声明:递归问题不止 `snapshotJson()`——`realm-worker.ts` 的递归遍历、随后的 `JSON.stringify`、以及 host 经 JSON string wire 接收共三层;官方 runtime 已是 stack-safe flat wire。因此 **优先向 Harness 请求导出稳定的 JSON boundary/flat-wire helper**;上游没有稳定 interface 前,本仓库只实现最小兼容算法并用 differential tests 固定行为,不复制 `worker-json.ts`/`output-json.ts`,更不复制整份 worker runtime。

Differential tests 以同一 `maxOutputBytes`、同一程序对比官方 one-shot 与 Prime persistent:上限边界 completion、单条超大 log 与累计 overflow、2/3/4 字节 UTF-8 裁切、error message 与 captured logs、空输出与最小预算(官方 4 vs Prime 256+160)、深层合法 JSON 与循环/非 JSON completion、generation notice 前后的总字节。每个差异标记为:官方契约应对齐 / persistent Realm 必需差异 / 未决阻止发布。

单独决策项(未决策不改现状):首条超大日志是否保留 code-point-safe prefix;log overflow 是否必须 hard-kill;最小预算 256 与 reserve 160 是否保留。

验收:所有差异有分类和测试名;无意 drift 已修复;有意差异写入 README 与 runtime docs;变更不削弱 `maxOutputBytes` 的完整 envelope 上限。

### Phase 3:Binding 数据面预算(数据驱动,暂缓)

Phase 1 完成后采集:单次与累计 binding bytes、Session JSONL 增长、heap 峰值与 hard-kill 次数、哪些 Tool 合法依赖超大 structured value。只有数据证明独立风险时才实施。

候选:可选 `maxHostBindingBytesPerRun`,按 UTF-8 精确累计双向 binding JSON;越界不发送超限 reply,返回短小确定性 rejection(程序可捕获 `ToolCallError` 降级),Realm 不 hard-kill,不计入 outer ledger;默认省略保持官方语义。改动集中在 `src/runtime.ts`、`src/realm/realm.ts`、`tests/prime-runtime.spec.ts` 与 README。已知限制:无法消除 host 侧生成 canonical value 的内存成本;Session nested dispatch 可能记录成功而程序收到 rejection——实施前必须确认 UI/日志能表达该差异,否则先向 Harness 增加 binding-transport failure seam。

### Phase 4:上游 owner-aware recoverable output seam(仅产品明确要求时)

在 Harness 侧设计,不在 Prime 实现。候选 interface 必须:Code Mode bridge 持有 owning Agent/Session 并连接 `ctx.spillStore`;可在 hard-cap 结算前流式提交 oversized 输出;不伪装成普通 Tool binding、不生成含整段 payload 的 dispatch 日志;返回通用 artifact result;one-shot 与 Prime 共用同一 seam;abort/save failure/部分写入/GC/fork 所有权有明确契约;无 sink 时维持 `output-limit`。获批前 Prime 不实现私有 output journal,不把 realm id 冒充 Session owner。

## 测试矩阵

| 层 | 断言 | 是否进 CI |
| --- | --- | --- |
| Retention/spill unit | head/tail、UTF-8、omitted count | Harness 已覆盖;不复制 |
| Spill 集成(场景 1–5) | full value、bounded projection、locator 恢复、降级可区分、generation retained | 是 |
| Composition E2E | Prime preset + host spill chain 行为生效、耐久 `tool/result` 有界 | 是,无模型 |
| Differential output contract | cap、UTF-8、overflow、深层 JSON 差异已分类 | 是 |
| Real-model smoke | 模型在程序内归约,不直接返回大型中间值 | 可选,`skipIf(!DEEPSEEK_API_KEY)` |
| Binding byte budget | 超限拒绝、可捕获、run 间清零 | 仅 Phase 3 获批后 |
| Recoverable hard-cap output | owner、stream、abort、fallback、GC | 仅 Phase 4 上游获批后 |

## 安全与生命周期

- Locator 是 opaque handle;local backend 路径必须在 private root、Session-scoped 目录,文件 owner-only;suggested name 只是提示,单路径段编码 + exclusive create。
- Spill 文件保留与 GC 由 Harness/backend 管理;Prime 不因 Realm 回收、Session clear 或 context delete 删除 artifact。
- Fork 继承旧 locator,新 spill 归 child Session;不复制 artifact、不改所有权。
- 保存失败不得输出不存在的 locator。

## 发布与回滚

Phase 1 不增加生产配置或状态格式,policy 文案可独立回滚,无迁移。Phase 2 每项契约变化必须有 differential test 和发布说明,不动 Realm identity、`prime_context` manifest 或 continual state。Phase 3 只加默认关闭的可选预算,回滚配置即恢复。Phase 4 属上游 interface,独立设计评审发布。

## 完成标准(Phase 1)

1. Policy 明确要求在 `run_code` 内归约大型中间结果,且不把大型原始结果长期放入 `state`。
2. 无模型 CI 证明 nested value 完整、dispatch log 有界且可经 locator 逐字节恢复 renderer 文本。
3. 无模型 CI 证明大型 outer completion 的 model-facing content 有界且完整 artifact 可恢复。
4. Spill 之后同一 Agent 的 generation retained,归约后的 `state` 可读。
5. Backend 失败不把成功 Tool 变成失败、无假 locator,且降级与成功 spill 在测试中可区分。
6. `maxOutputBytes` 硬失败语义不变。
7. Prime package 未复制 Harness retention/spill 实现,未新增第二个 storage seam。

Phase 2 须先完成差异分类;Phase 3 须先完成数据采集与日志语义评审;Phase 4 须有明确产品需求并获上游批准。
