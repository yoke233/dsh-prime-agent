# Prime Agent Tool 失败恢复方案

## 状态

提案 v2(按对抗审查修订并瘦身)。定义失败分类、恢复规则与测试顺序,不表示实现已完成。

大型内容的 retention、spill 与 output budget 由 [大型 Tool 输出治理方案](./large-tool-output-optimization.md) 负责;本文只定义失败发生后是否继续、是否重试、状态是否可信,以及如何向下一轮暴露事实。

前置条件已满足:`prime-preset-mount.e2e` 与 `prime-compose.e2e` 已修绿(compose 曾靠删断言变绿,真断言已恢复)。

## 目标

1. 一个 Tool 失败时,尽量保留同一 `run_code` 中已得到的独立结果。
2. 不因"自动恢复"重复执行有副作用、需审批或身份敏感的操作。
3. 明确区分普通 Tool failure、程序 failure、generation 丢失和身份完整性失败。
4. Agent 依据稳定事实行动,不解析偶然错误文案。
5. 重要进度在 Worker 丢失后可从持久任务文件的 checkpoint 恢复。
6. 保持 Harness ToolRuntime、审批、沙箱、Jobs 和 CodeRuntime seam 的所有权,不在 Prime 复制通用 retry runtime。

## 非目标

- 不保证 Tool 幂等,不回滚已发生的外部副作用,不把错误转成成功值。
- 不绕过 guard、approval、sandbox 或 Harness policy。
- 不靠匹配自然语言错误字符串自动重试。
- 不把 stack trace、完整 Tool 输出或敏感路径写入 continual learning。
- 不自动记录每次调用;可靠 checkpoint 由程序显式写入持久任务文件。

## 已核实的运行时事实

- **`ToolCallError` 是 worker 注入的 binding exception**:host 侧只声明 `errorClass` 配置,真实构造器由 worker `makeBindingErrorClass` 现场生成并经执行环境参数注入(`code-runtime-worker-thread/src/bootstrap.ts:245-412`);无可 import 的运行时导出。公开 interface 仅 `toolName` + `message`,程序只能在 **Realm 内** `instanceof` 判断;测试进程不能 import 后比较实例。无法凭公开 interface 可靠判断错误是否 transient。
- Tool side effect 不随程序失败回滚;`tool/code-dispatch` 日志按 Harness 纪律保留。"重跑整个程序"可能重复副作用,不是默认恢复动作。
- 并行失败语义由程序组合方式决定:裸 `Promise.all` fail-fast 不回滚已启动调用;`Promise.allSettled` 保留逐项结果;per-call `try/catch` 可返回精简诊断继续。Harness 仍按 concurrency classification 调度。
- 普通程序错误(绑定拒绝、抛错、invalid completion)通常只结束当前 run,generation 保留;`state` 无事务回滚。
- 丢 generation 的路径:active abort、wall/compute timeout、worker exit、log output overflow;queued abort 不丢;oversized completion 返回 `output-limit` 但保留 heap。下一次路由到新 Worker 时必须出现 generation-loss notice。
- Handshake failure 必须 fail-closed,不降级到官方 one-shot runtime。
- ToolRuntime 已有通用 around seam(`tools/pre-execute`/`tools/execute`/`tools/post-execute`);部署级 timeout/retry/metrics 属于该层。**`sandbox_permissions` + `justification` 不是 pipeline 通用能力**,而是 bash、pwsh、write/edit 等具体 Tool 的 args 协议,由共享库 `sandbox/escalation.ts` 校验;synthetic Tool 不自动拥有 escalation。

## 失败分类

失败先分类再恢复。v1 用下表作为 Agent policy 和测试词汇,不新增公开 runtime error union。

| 类别 | 例子 | 默认重试 | Realm 影响 | 默认动作 |
| --- | --- | --- | --- | --- |
| Caller misuse | 参数缺失、非法 regex、未知 Tool | 否 | retained | 修正输入后重调 |
| Policy denial | guard deny、approval 拒绝 | 否 | retained | 停止并报告 |
| Sandbox denial | 文件访问拒绝、`spawn EPERM` | 仅按权限流程一次 | retained 或当前 run 失败 | 同一操作申请最小权限;拒绝后停止 |
| Tool execution failure | ENOENT、网络错误、远端 5xx | 默认否 | retained | 按 Tool 语义决定 |
| Optimistic conflict | `expected_revision` 不匹配 | 不能原样重试 | retained | 重读最新 revision 重算 mutation |
| Program failure | 未捕获异常、非法 completion | 否 | 通常 retained | 读 captured logs,写更小修复程序 |
| Active cancellation | 用户取消、外层 signal | 否 | generation lost | 尊重取消;从 durable checkpoint 恢复 |
| Runtime timeout | wall/compute budget | 原样否 | generation lost | 缩小工作、分页或拆 run |
| Worker failure | worker exit、运行外故障 | 恢复性重建,不重放副作用 | generation lost | 查 notice,从持久检查点重建 |
| Output limit | logs/completion 超限 | 原样否 | 依 overflow 路径 | 按大型输出方案归约;先确认 generation |
| Identity/integrity failure | forged、stale、malformed、storage corrupt | 绝不 | 未进入可信 Realm | fail-closed,报告部署/存储问题 |
| Background job failure | job failed/killed | 默认否 | 与 Realm 分离 | 读一次 final output,按 job 语义决定 |

## 设计决策

- **D1 默认不自动重试**:`ToolCallError` 无稳定 retryable code,schema 无幂等声明。默认捕获失败、保留事实、不无限重试、不重放整个 `run_code`;只有已知只读/幂等且错误确属短暂条件时才有限重试。
- **D2 并行组合三类**:原子依赖组用 `Promise.all`(接受已启动副作用不回滚);best-effort 独立探针用逐项捕获或 `Promise.allSettled`,只返回 `{ ok: false, toolName, message }` 级诊断;有序 mutation 链顺序执行,不用 `allSettled` 把部分提交伪装成整体成功。
- **D3 不提供通用 `safeCall` wrapper**:v1 只在 prompt 给局部模式;出现两个共享稳定 retryability interface 的真实 adapter 后再考虑抽取。
- **D4 retry 前置条件**(全部满足才允许):操作只读/幂等或带服务端 idempotency key;失败不是 misuse/policy denial/approval reject/integrity failure/unchanged output-limit;上限明确(默认最多 1 次补偿);未收到 cancellation;backoff 由 Tool/deployment adapter 拥有,禁止 `run_code` 内 detached timer;每次尝试可观察。
- **D5 revision conflict 必须重读**:重新 catalog/inspect → 读新 revision → 重验意图 → 以新 revision 提交一次;不在 catch 中盲改 `expected_revision` 重放旧 mutation。
- **D6 sandbox 升级策略——一次、同操作、最小权限**:识别到真实 denial 后保留原命令/参数/工作目录,选最小足够权限,经 Harness approval 对同一操作重试一次;拒绝或仍失败即终止;禁止换命令、换 Tool 或临时脚本绕过。**定位:这是 prompt policy + pipeline 验收,不是 runtime 强制不变量。** Prime runtime 不重试(正确),但无法机械禁止模型另发一条操作;确定性测试只能证明 policy 文本明确、每次真实调用仍过 guard/approval、Prime runtime 不绕过 pipeline。"模型确实不绕行"只能由可选 real-model smoke 佐证,不写成无模型 CI 的强保证。
- **D7 generation loss 后不信任 live-only state**:不读旧闭包/Map/client;从持久检查点与任务文件按需读取;重建派生索引;对可能已发生的外部副作用先查真实外部状态;recovery 结果保持精简。
- **D8 身份失败不可降级**:不自制 token、不关校验、不切 one-shot;恢复只能来自部署/存储修复或新 Session/Realm。
- **D9 background jobs 所有权协议**:记录 job id;完成后读 final output,不 sleep/busy-poll;relevant 则 `job_output` 收集,不再 relevant 则 `job_kill`;failed/killed 不自动重启,重启前先判断副作用和 durable output。(harness `JobStatus` 的终态词汇是 completed/killed/failed,无 `expired`。)

## 推荐的程序模式

局部捕获(只在 Realm 内 `instanceof`,只返回决策所需字段):

```ts
try {
  return { ok: true as const, value: await tools.read({ file_path: path }) }
} catch (error) {
  if (error instanceof ToolCallError) {
    return { ok: false as const, toolName: error.toolName, message: error.message }
  }
  throw error
}
```

独立探针批次:`Promise.allSettled` 后逐项映射为 `{ index, ok, ... }`;需要 `toolName` 时应在每个调用内部捕获(`PromiseRejectedResult.reason` 是 `unknown`)。

有序 mutation:先 `catalog` 取 revision,再带 `expected_revision` 提交;冲突时重读重算,不盲目递增。

## 分阶段实施

### Phase 1:Prompt policy 与确定性单元测试(与大型输出方案共享,一次完成)

`src/policy.ts` 的 `orchestrationPolicy()` 与 `tests/code-mode.spec.ts` 同时被两份方案修改,合并为一次改动。本方案贡献的规则:裸 `Promise.all` 只用于真正共同成功的 foreground 组;best-effort 逐项捕获或 `allSettled`;mutation 顺序执行;失败不盲目重试;sandbox denial 只允许一次同操作最小权限升级;generation loss 后从持久检查点恢复。

测试断言:policy 含 fail-fast 与 best-effort 的区别;自定义 context Tool 名称正确插入 recovery 文案;policy 不承诺自动 rollback 或 automatic retry;SDK 类型声明仍含 `ToolCallError`。

### Phase 2:真实 `run_code` failure E2E

新增 `tests/tool-failure-recovery.e2e.spec.ts`,复用真实 ToolRuntime、Prime runtime、身份工具和固定 Agent。场景:

1. 一个成功读 + 一个失败读并行,逐项捕获后成功结果仍返回;程序内 `instanceof ToolCallError` 且 `toolName` 正确。
2. 裸 `Promise.all` 成员失败导致 outer run failure,但同一 Agent 下一 run generation retained。
3. 程序未捕获异常时外层为 structured `isError`,captured logs 可见且有界。
4. 一个 mutation 成功、后续程序失败:外部副作用不被声称已回滚。
5. generation loss(timeout 或 active abort 任选一条路径)后,下一 run 收到 loss notice 并从持久任务文件 checkpoint 重建 state。
6. handshake fail-closed 只补一条**自动 binding path** 的 E2E;完整篡改矩阵已由 `tests/prime-runtime.spec.ts` 低层覆盖,不复制。

queued/active abort、worker exit、output-limit 的低层语义已由 `tests/realm-worker.spec.ts` 覆盖,E2E 不重复;output-limit 的 heap 保留/丢失差异归大型输出方案的 differential tests。

### Phase 2.5:Jobs 验收

扩展 `tests/orchestration.spec.ts`(fake jobs),补齐 D9 与测试矩阵已承诺但此前无阶段承接的场景:relevant job 最终 `job_output` collect;obsolete job `job_kill`;failed/killed 不自动重启;整个流程无 sleep/busy-poll。现有文件只覆盖成功 collect。

### Phase 3:权限与审批集成验收

**选一个真实支持 escalation 的 Tool**(bash、pwsh 或 write 之一,它们的 args 协议含 `sandbox_permissions` + `justification`),注入 fake sandbox/approval backend;不用通用 synthetic Tool 宣称验证了 sandbox 契约。覆盖:

- 无真实 denial 时不请求高权限;
- denial 后只对**同一操作**(原命令、参数、工作目录不变)申请一次最小权限;
- approval reject 后 Tool body 未执行;
- approval 不可用时 fail closed;
- 升级后的第二次失败不触发第三种绕行。

本阶段测试 policy 与 ToolRuntime pipeline,不在 Prime worker 内模拟操作系统沙箱。"模型不换命令绕过"由可选 real-model smoke 佐证(见 D6)。

### Phase 4:Retryability interface 上游评估(暂缓)

只有两个以上 Tool/deployment adapter 需共享自动 retry 时启动,优先在 Harness around seam 设计。候选 interface 必须回答:retryability 由谁声明;idempotency key 如何表达;approval 是否每次重新请求;attempt 如何进 durable log 与 UI;cancellation/deadline/backoff 归属;Code Mode 是否公开稳定 failure code;哪些内部 code 因安全不能暴露。获批前 Prime 不解析 `ToolCallError.message` 实现自动 retry。

## 测试矩阵

| 层 | 断言 | 是否进 CI |
| --- | --- | --- |
| Policy unit | 并行分类、mutation 顺序、无盲重试、一次升级文案 | 是 |
| Failure E2E(场景 1–4) | 局部捕获、`toolName`、structured isError、副作用不回滚、Realm retained | 是 |
| Durable recovery(场景 5) | generation notice + 持久 checkpoint 重建 | 是 |
| Identity(场景 6) | 自动 binding path fail-closed;篡改矩阵已有低层覆盖 | 是 |
| Jobs(Phase 2.5) | collect relevant、kill obsolete、不自动重启、无 busy-poll | 是,fake jobs |
| Approval/sandbox(Phase 3) | 真实 escalation Tool、一次最小升级、拒绝后停止 | 是,fake adapter |
| Real-model smoke | 模型遵守一次升级/不绕行 | 可选,`skipIf(!DEEPSEEK_API_KEY)` |
| Retry adapter | idempotency、attempt log、cancel/deadline | 仅 Phase 4 获批后 |

## 可观察性

v1 不新增持久 failure database,使用现有事件:outer `tool/call`/`tool/result`、nested dispatch 事件、`CodeRunFailedError` 的 kind 与 captured logs、generation notice、job status。

失败摘要至少说明:哪层失败、哪个操作、是否发生副作用、generation 是否可信、是否重试及次数、下一步(修输入 / 用户授权 / 部署修复 / durable recovery)。不返回完整 stack、token、proof、存储路径或大型 payload。

## 安全与完整性

- Policy denial、approval reject 和 handshake failure 是最终拒绝,不能换 Tool 绕过;用户取消后不启动新恢复调用。
- 不信任 hostile error 的 `toString`/getter,沿用 runtime bounded rendering。
- 失败文案不写入 `prime_refine`;只有重复出现并经验证的稳定经验才可提炼。
- recovery checkpoint 用 optimistic revision,不覆盖并发 Agent 更新。
- hard-kill 后先查外部事实再决定补偿,不假定外部操作未发生。

## 发布与回滚

Phase 1 只改 policy 文案与测试。Phase 2/2.5 增加集成测试,预期不改生产语义;暴露契约差异时先记录、单独批准修复。Phase 3 只验证 Harness 已有 seam,不在 Prime 新增权限能力。Phase 4 属上游 interface,独立设计发布。所有阶段不改 Realm identity 或 continual state 格式。

## 完成标准(v1 = Phase 1–3)

1. Policy 明确区分 atomic fail-fast、best-effort probes 和 ordered mutations。
2. 普通 Tool failure 可局部捕获,不丢失其他独立成功结果。
3. 无默认 mutation replay 或 message-based automatic retry。
4. 真实 `run_code` E2E 固定 ordinary failure、program failure 和 generation-loss 语义。
5. generation loss 后可从持久任务文件 checkpoint 重建,并先核验外部副作用。
6. 一次同操作最小权限升级作为 policy 文本 + pipeline 验收成立:每次调用过 guard/approval,reject 后 Tool body 未执行;不声称 runtime 机械禁止二次操作。
7. handshake/integrity failure 保持 fail-closed(低层矩阵 + 一条自动 binding path E2E)。
8. background jobs 在最终回答前被收集或取消:collect/kill/不自动重启/无 busy-poll 均有 CI 测试。
9. 与大型输出方案无冲突的预算或恢复承诺;共享的 Phase 1 policy 改动一次完成。
