<p align="center">
  <img src="./assets/readme/hero.svg" width="100%" alt="dsh-prime-agent —— 为 DeepSeek Harness Code Mode 提供持久 TypeScript Realm:一次 run_code 写入的 state,在下一次调用里仍然存活">
</p>

<p align="center">
  <a href="docs/v2-architecture.md">架构</a> ·
  <a href="docs/v0.3-roadmap.md">Realm 契约</a> ·
  <a href="docs/prime-agent-learnings.md">Prime Agent 学习笔记</a> ·
  <a href="docs/upstream-sync.zh.md">上游同步手册</a>
</p>

`dsh-prime-agent` 是面向 DeepSeek Harness 的 RLM-first 控制面。选中 Prime preset 的会话,其 `run_code` 程序运行在一个经认证的长期 TypeScript Realm 里:一个程序赋给 `state` 的值、函数和模块缓存,下一个程序还能直接用。

```ts
// 第 1 次 run_code
state.lookup = new Map(records.map(item => [item.id, item]))
state.review = async (id) => tools.review_item({ item: state.lookup.get(id) })
return state.lookup.size

// 第 2 次 run_code —— 同一会话的新调用
return await state.review('a') // Map 和函数都还活着
```

普通会话完全不受影响,继续使用官方 one-shot 语义。

## 工作原理

<p align="center">
  <img src="./assets/readme/architecture.svg" width="100%" alt="混合运行时路由:run_code 经 DSH Code Mode bridge 进入 PrimeCodeRuntime,握手认证通过的会话路由到持久 Realm Worker,其余请求走官方 one-shot Worker">
</p>

- 插件注册固定名称的 `prime_realm_identity` bootstrap binding。`PrimeCodeRuntime` 在执行程序前以 32 字节 CSPRNG challenge 调用它,验证带 session binding 的 HMAC proof 后,才把请求路由到该会话的持久 Realm Worker。
- 没有该 binding 的请求原样委托官方 one-shot Worker;binding 存在但握手失败时明确报错,绝不静默降级。
- Realm 内的工具经跨 run 稳定的 Proxy 与 per-run binding lease 调用:schema、审批、沙箱、日志、并发和取消仍由 DSH 执行,run 结束立即撤销授权。
- Realm 是 live-only 的:abort、timeout、OOM 会 hard-kill Worker 并丢失 heap,下一次 run 收到明确的 generation 通知。跨重启的检查点由程序显式写入持久任务文件。

完整身份协议、generation 语义与资源治理见 [Realm 契约](docs/v0.3-roadmap.md)。

## 三层状态

| 状态层 | 责任 | 保证 |
| --- | --- | --- |
| Realm `state` | 函数、对象、Map、索引等活计算状态 | 同一 Worker generation 的 run 间保留;hard kill 后丢失 |
| 持久任务文件 | 大型输入、重要结果与跨重启检查点 | 由文件系统承载,进程重启后仍可恢复 |
| `prime_refine` | 稳定路由与行为经验 | 证据化、乐观并发、事务历史和安全回滚 |

## 安装与启用

```sh
npm install
npm run check
dsh plugin --profile web add ./dsh-prime-agent
```

`dsh plugin add` 即提供全部内容:随包 bundle patch 把宿主 `code-runtime` provider 替换为 `dsh-prime-agent/runtime`;随包 Prime preset 在启动时落位到 `$DSH_HOME/.agent-presets`(仅缺失时)。启用 Prime 模式只是为某个会话选中 Prime preset;默认 preset 与其他 preset 保持官方 one-shot 语义。落位后的 preset 不会被覆盖,删除 `$DSH_HOME/.agent-presets/prime` 并重启即可重新落位当前快照。

## 编排工作流

控制面 policy 引导模型在一个程序里组合读取、工具与子 Agent:中间值赋给 `state`,大结果在程序内归约后只返回摘要;独立前台工作用 `Promise.all`,best-effort 探测逐项捕获,副作用型 mutation 顺序执行。

需要 admission-first 时,调用可见的 Subagent 工具并设置 `run_in_background: true`,保留返回的 Job id,父 Agent 继续工作,稍后用 `job_output` 回收结果。具体 Subagent/Job 参数来自当前 profile 安装的 DSH 工具,本插件不复制它们的 schema。

## prime_refine

持续学习刻意放在次要位置。不要存研究资料、任务状态、工具输出或大上下文;只有出现重复失败、用户纠正或稳定可复用策略后才使用它。

- `inspect` 返回当前 revision、条目和近期事务。
- `apply` 需要 inspect 得到的 revision、trigger、具体 evidence、可验证的 expected outcome,以及最小 create/update/delete edits。
- `rollback` 需要当前 revision 和目标 transaction id,可附带 trigger 记录回滚动机,且只有相关条目没有发生漂移时才成功。

条目类型包括 `prompt`、`memory`、`skill` 与 `subagent`。skill/subagent 只能引用真实可见的工具;它们记录路由,不会创建能力或扩大权限。

## 配置

`stateDirectory` 必填。未配置选项时使用下列默认值。

| 选项 | 默认值 | 含义 |
| --- | --- | --- |
| `refineToolName` | `prime_refine` | 持续学习工具名 |
| `allowGlobalRefinement` | `false` | 允许模型访问 global 学习状态 |
| `requireCodeMode` | `true` | 要求 `run_code` 是模型唯一可见工具 |
| `requireOrchestrationTools` | `true` | 要求具备 Subagent admission 与 `job_output` |
| `continual` | 有界默认值 | 学习条目、事务、状态与 prompt 限制 |

`dsh-prime-agent/runtime` 条目另接受官方预算字段(`computeMs`、`maxWallMs`、`maxOutputBytes`、`maxOldGenerationSizeMb`,同名逐字透传)与 realm pool 治理项(`maxActiveRealms`、`maxIdleMs`、`maxHostCallsPerRun`、`maxParallelHostCallsPerRun`、`maxStateEntries`)。

## 存储与安全

- 插件状态位于 `<stateDirectory>/continual`(学习层)与 `<stateDirectory>/realm-identity`(握手密钥);文件名使用 Session id 的散列。
- 状态提交使用跨进程写锁与原子替换;损坏、超限、丢失或 revision 冲突都会明确失败。
- Continual-learning 条目以 JSON 引用的不可信建议记录进入 prompt,不能覆盖当前 system、user、权限或工具约束。
- 在宿主平台支持时请求 POSIX owner-only 权限。这些措施用于持久化与完整性加固,不代表安全沙箱。

## 开发

开发测试把公开 DSH 包名解析到同级 `../deepseek-harness` 源码;发布包只导入公开包名。DSH peer range 限制在兼容的 `0.1.x` 系列并标记为 optional,避免在已提供这些包的宿主中安装第二套 package graph。

```sh
npm run typecheck
npm test
npm run build
```
