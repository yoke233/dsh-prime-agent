# Prime 上下文工程任务评测

这套评测先回答两个问题：任务是否正确完成，以及完成它实际用了多少次模型调用和多少 provider 报告的 token。它不以 REPL 输出字符数、工具调用次数或变量复用率代替任务质量，也不把 token 数换算成账单。

## 冻结实验格

每轮只改变一个待验证因素。开始运行前，为每个实验格记录：

- 仓库 revision、未提交 diff，以及 Prime 包版本；
- provider、精确 model id、reasoning effort 和其余采样参数；
- Agent preset、system prompt/policy revision、上下文窗口与 compaction 配置；
- 任务 fixture revision、任务变体 id、初始文件和外部状态；
- 是否启用 query/child、并发度、超时与重试配置；
- 每格重复次数和预先约定的评分规则。

基线和候选使用相同任务顺序；若任务顺序可能造成缓存或学习效应，则交叉或随机化顺序并保存顺序。每格重复运行，报告成功次数、失败类型和分布，不用一次成功或一次零失败下结论。continual state 会影响结果时，为每个格冻结其 revision；比较学习前后时分别运行固定旧 revision 与固定新 revision，不能让同一格在执行中悄悄变化。

## 最小任务集

四类任务都检查最终环境状态和关键证据，而不只检查最终文字答案：

1. **stale 证据**：模型读取文件或约束后改变源状态，再要求它完成依赖新状态的编辑。检查它是否刷新来源并重新判断旧计划。
2. **关键否定条件**：把少见但决定答案的否定条件放在长材料中。检查模型是否取得、实际看到并正确使用该证据，同时保存可回取的来源位置。
3. **query 失败或截断**：让批内某个 query 失败，或让回复到达 `maxTokens`。检查任务是否识别不完整结果，失败尝试及重跑是否全部计入成本。
4. **context/restart 恢复**：同一任务分别触发 context 切换和 Worker 重启。检查目标、证据位置与未决项能否恢复，以及恢复过程是否重复产生副作用。两种情形分开评分，因为 context 切换保留 Realm heap，Worker 重启不保留。

每个任务至少保存：成功/失败、最终状态检查、关键证据命中与来源、旧状态误用、重复副作用、墙钟时间、所有模型调用记录。质量至少维持后，才比较总模型用量和完成时间是否下降。

## 采集调用用量

任务级模型测试在 DSH 公开的 `llm/stream(options, next)` middleware 处为每次进入该边界的请求生成唯一 `callId`，记录 terminal outcome 与 provider 返回的 usage。失败后重新进入该边界的重试使用不同 `callId`；adapter 内部未暴露的传输重试不能从这层独立计数。记录形状可直接交给：

```js
import { aggregateModelUsage } from '../scripts/eval/model-usage.mjs'

const report = aggregateModelUsage(records)
```

每条记录包含：

```js
{
  callId,
  attribution: 'main' | 'query' | 'child' | 'unknown',
  outcome: 'success' | 'failure' | 'aborted' | 'unknown',
  provider,
  model,
  usage,       // provider 实际返回时才写
  billing,     // provider 提供账单事实时可原样保留
}
```

归因必须来自调用点或可信 Session 身份，不能按时间邻近、消息内容或 model id 猜测。在仅包含 Agent Loop 和本项目 Prime query 的封闭测试组合里，可以用 DSH 的 `isAgentLoopRequest(options)` 识别 main，并由 query 调用点显式标记 query；这个二分结论不能推广到还包含 compaction、title 或其他 LLM consumer 的组合。child 应由其 Session header 的 `origin: "subagent"` 与 `parentSession` 归属。

聚合结果分别列出全部、失败/中止，以及 main/query/child/unknown。每个 usage 字段同时报告已知调用数、未知调用数和已知值之和。缺 usage 的失败不能记为零；`totalTokens` 缺少时也不从其他字段自行补造。缓存只使用 DSH `TokenUsage` 中 provider 实际报告的 `cacheReadTokens` 和 `cacheWriteTokens`。脚本不内置价格，也不把 token 当账单；没有 provider 账单事实时，billing 是 `unknown`。

## 从显式 Session 日志补做离线统计

CLI 只读取命令行明确给出的 `.jsonl` 或 `.jsonl.zstd`，不会扫描 `DSH_HOME`：

```powershell
node scripts/eval/model-usage.mjs --input D:\eval\main\session.jsonl.zstd --input D:\eval\child\session.jsonl.zstd > D:\eval\usage.json
```

也可以直接给位置参数：

```powershell
node scripts/eval/model-usage.mjs D:\eval\main\session.jsonl.zstd D:\eval\child\session.jsonl.zstd
```

DSH 将已结算模型尝试的流保存在 `assistant/message.stream` 或 `assistant/attempt.stream`，usage 可同时出现在消息字段中。脚本每个持久尝试只计一次，并通过官方 `expandAssistantStream` 提取末次 usage 和 finish；无 finish 且未产生消息的尝试保持 unknown。child 继承前缀按官方格式解码器返回的 `inheritedEventCount` 跳过。相同来源与 seq 的重复事件只读一次，相同 `callId` 的完全重复记录只聚合一次；冲突记录降为 unknown 并写入 diagnostics。

离线日志有明确边界：Prime `agents.query/queryMany` 直接调用 `ctx.llm.stream()`，只传同一个 `sessionId`，不会写 `assistant/message` 或独立工具日志；因此现有 Session JSONL 既看不到这些 query，也无法区分它与 main。脚本不会据此生成 query 或把缺失成本算成零。要比较完整任务成本，必须使用上一节的 middleware 采集；离线 CLI 用来复核已持久化的 main/child 调用及失败流。一次调用若在写出任何 `assistant/message` 或 `assistant/attempt` 前失败，Session 日志只有 turn 失败而没有可识别的物理调用，脚本不会凭 turn 边界虚造调用；这部分仍须由 middleware 采集。compaction 只有 `llmStreamCall: true` 时才能确认发生模型调用，但它不属于四种任务调用归因，脚本保守放入 unknown。session title 等未持久化 usage 的 consumer 同样只能由 middleware 捕获。

## 与任务级模型评测搭配

任务级测试负责准备固定 fixture、执行一个实验格、检查最终状态和证据；usage 模块只负责记录去重与聚合。每次重复运行保存任务结果、冻结元数据和该次 `aggregateModelUsage()` JSON，最后再按实验格汇总成功率、失败构成、总调用、已知 token 分布、未知 usage 比例、缓存读写及延迟。只比较已知 token 总和会偏向 usage 缺失更多的一格，因此任何成本结论都必须同时展示未知调用数。

不为获得统计而新增模型调用，不把 prompt 或任务材料写入 continual state，也不在评测脚本里读取凭据或修改本机 profile。真实付费模型运行继续由显式 opt-in 的任务级模型测试负责。

## 已实现的真实模型任务套件

`tests/context-engineering-model.e2e.spec.ts` 已实现四个任务级场景：源状态变化后的刷新、长材料中的关键否定条件、注入 query 失败与截断后的恢复，以及 Host 主动切换窗口并提供过时 notes 后的恢复。每个场景检查最终业务提交和证据 ID，并输出 provider、model、耗时、故障注入数及全部可观察 usage 的聚合；评测自身限制为最多 12 次 main 调用、16 次全部模型调用和 120 秒 deadline。真实模型的 Worker restart 尚未覆盖，确定性 replay 测试已覆盖 restart 后的 notes 与历史恢复。

这些是有明确任务指令的小型行为评测，不是自然编码任务成功率基准。fixture 注入的失败与截断会单列数量，不冒充 provider 真实失败或补造用量；缺少计量时仍标 unknown。当前套件没有启动 child，聚合器支持 child 不代表已经验证多 Agent 任务成本。

默认测试不会调用模型。显式提供凭据后运行：

```powershell
$env:DSH_RUN_MODEL_E2E = '1'
$env:DEEPSEEK_API_KEY = '<key>'
npm run test:model
```

该套件尚未产生模型 A/B 结果；运行前仍需按“冻结实验格”记录配置，并保存每次输出的 JSON 报告。
