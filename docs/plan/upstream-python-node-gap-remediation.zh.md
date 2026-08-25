# 上游 Python / Node 适配差距修复计划

## 1. 目标

以 Prime Agent Python RLM 的可观察行为为参照，在不复制 DSH 已拥有的 Agent Loop、Session、Subagent、Jobs、Goal、Compaction、Schedule 或 MCP runtime 的前提下，修正本插件已经承诺但没有正确验证或覆盖的行为，并缩小 Persistent TypeScript Realm 与 IPython REPL 的关键语义差距。

完成标准：

1. Prime 编排能力在 system-prompt assembly 时按真实能力集合 fail-fast。
2. shipped preset 的 continuable child 路径有行为级回归测试，而不是只验证 policy 文本或 one-shot Job。
3. 非 lossless-JSON 的成功 completion 不再被误报为 cell 失败；活对象可通过 generation-local handle 继续寻址。
4. handoff policy 只对大材料、结构化快照或需要耐久性的材料要求文件，不强迫小型委派写 JSON 文件。
5. 文档准确区分已交付能力、DSH-owned 能力和仍待上游支持的能力差距。
6. src/ 与生成的 lib/ 同步，npm run check 通过，最终 diff 无无关改动。

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

## 3. 所有权边界

### 本仓库直接实现

- policy 生成与能力校验。
- Persistent Realm completion history 与 wire projection。
- 本插件的单元、集成、preset 和 packaging 测试。
- README、architecture、policy 与 upstream decision log 的准确说明。

### 必须复用 DSH

- continuable child registry、inbox、report、cancel、cold resume。
- Jobs registry 与 one-shot background provider。
- Goal continuation、Compaction、Schedule、MCP、Session event log。

### 本轮不在插件内复制

- sibling/broadcast 消息总线和跨 Session transcript reader。
- recurring heartbeat scheduler。
- compaction engine 或 context token accounting。
- child delete/tombstone、per-child reasoning、自动 refinement。

这些能力只记录为 DSH-native follow-up；除非 DSH 已有正式工具并能通过 profile 组合，否则不在插件中伪造适配层。

## 4. 实施工作包

### WP-A：编排能力校验与 handoff policy

文件范围：src/policy.ts、tests/code-mode.spec.ts。

任务：

1. 将 required orchestration capability 拆为 continuable child controls 与 Job controls。
2. Prime shipped 模式至少要求 subagent/subagent_fork、list_agents、send_message、interrupt_agent、job_output；错误信息列出精确缺失项。
3. 增加逐项缺失的 negative assembly tests。
4. handoff 文案改为：小型、自包含上下文可直接放 prompt；大材料、结构化快照、二进制或耐久数据走文件；使用文件时继续保持 snapshot/immutable 约定。
5. 更新相应 policy 文本断言。

验收：不完整部署在 assembly 时失败；完整 fixture 正常生成 Code Mode SDK。

### WP-B：continuable child 行为级测试

文件范围：新建 tests/continuable-orchestration.spec.ts，避免与现有 one-shot Job 测试冲突。若测试暴露真实组合 bug，必须先报告，不得私建 child registry。

覆盖：

1. background admission 返回 continuable id，而非 Job id。
2. list_agents 可见 direct child。
3. send_message 延续同一 child conversation。
4. interrupt_agent 只中断当前 turn，child 仍可后续恢复。
5. continuable id 不能当作 Job id 使用。
6. child report/settlement 继续使用官方 DSH row；测试基建允许时验证 report-before-settlement 和 next-step。

验收：测试使用与 shipped preset 相同的 continuable provider/config，不以 one-shot Job 代替。

### WP-C：opaque completion history

主要文件：src/realm/realm-worker.ts、tests/realm-worker.spec.ts、tests/completion-history.spec.ts、tests/completion-contracts.spec.ts；必要时修改 protocol.ts 或 realm.ts。

设计要求：

1. 成功 completion 无论是否 JSON-compatible，都先按有界规则考虑 generation-local retention。
2. lossless JSON 小值维持原样返回；大 JSON 维持现有 projection。
3. 非 JSON 活对象若可纳入有界 history，返回固定 lossless envelope，例如 { retained: true, id, type, opaque: true }；不得调用用户 toJSON/toString/inspect。
4. $_ 与 $out(id) 返回原始对象身份；Map、Set、函数、BigInt、循环对象和 class instance 均覆盖。
5. opaque slot 使用保守且可解释的预算，不允许借 opaque 绕过 entries/nodes/bytes 上限。若无法安全估算，先引入独立的有界 opaque-entry 配额。
6. exception、abort、timeout、hard-kill 不创建 slot；generation fencing 和 expired handle 语义不变。
7. throwing getter/proxy 等对抗对象不得转成程序异常或触发用户代码。

验收：原先的 non-JSON invalid-output 契约被显式改写；成功 cell 不再出现假失败。

### WP-D：文档与决策日志

文件：README.md、docs/architecture.md、docs/prime-agent-learnings.md、docs/upstream-sync.zh.md、docs/upstream-sync.md 和本计划状态区。

任务：

1. 记录 opaque completion 对上游 IPython Out 的 Adapt 决策。
2. 将 Heartbeat/Schedule、主动 Compaction、family observation 标为未交付的 DSH-native follow-up。
3. 不把 DSH 自动 compaction、Jobs 或 slash command描述成完整等价物。
4. 同步 handoff policy 和编排 fail-fast 行为。

## 5. 多 Agent 执行策略

1. 多个只读审阅 Agent 分别核对 WP-A、WP-B、WP-C 的 DSH API 和测试可行性。
2. 实现 Agent 按不重叠文件范围工作：WP-A、WP-B、WP-C 可并行；跨范围修改先报告，不直接争抢文件。
3. WP-D 在代码工作包落定后串行执行，依据真实 diff 更新文档。
4. 独立验证 Agent 审阅所有权边界、测试真实性和遗漏；主 Agent 运行完整验证并处理集成问题。

## 6. 验证矩阵

迭代验证：

- npx vitest run tests/code-mode.spec.ts
- npx vitest run tests/continuable-orchestration.spec.ts
- npx vitest run tests/realm-worker.spec.ts tests/completion-history.spec.ts tests/completion-contracts.spec.ts

最终验证：

- npm run check
- preset/组合相关变化时额外运行 packaging-boundary、preset-install、loader-composition、prime-preset-mount.e2e 和 prime-compose.e2e 测试。

最终检查：git diff --check、git status --short、src/ 与 lib/ 构建产物同步，无临时 handoff/result 文件、凭据或本机路径进入提交。

## 7. 风险与回滚

- opaque completion 可能扩大 Realm 引用保留：必须有独立硬预算和 FIFO 淘汰，禁止无界 fallback。
- continuable 测试可能依赖 DSH 内部时序：优先断言公开状态和事件顺序，不依赖 sleep。
- 能力校验收紧可能影响自定义 profile：错误信息必须列出迁移所需工具；若需要兼容，新增显式配置而不是静默降级。
- 文档不得先于代码宣称完成；每个工作包只在对应测试通过后更新状态。

## 8. 执行状态

- [x] 完成上游 Python / Node 差距审计。
- [x] 保存实施计划。
- [ ] 完成 WP-A。
- [ ] 完成 WP-B。
- [ ] 完成 WP-C。
- [ ] 完成 WP-D。
- [ ] 完整验证通过并审阅最终 diff。
