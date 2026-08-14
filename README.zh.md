# dsh-prime-agent

`dsh-prime-agent` 是面向 DeepSeek Harness 的 RLM-first 控制面。它把大上下文和中间结果变成可持久化、可寻址的工作区，再由 Code Mode 用一个程序统一协调读取、工具、子 Agent 与后台任务。

[English](README.md) · [架构](docs/v2-architecture.md) · [v0.3 路线](docs/v0.3-roadmap.md) · [Prime Agent 学习笔记](docs/prime-agent-learnings.md) · [上游同步手册](docs/upstream-sync.zh.md)

v0.2 是一次全新设计：不读取 0.1 状态、不保留旧 `prime_harness` API，也不提供迁移路径。v0.3 交付 Persistent TypeScript Realm：经认证的 per-session realm，`state`、函数与 module cache 跨 `run_code` 保留。

## 设计

插件把三种责任明确分开：

| 层 | 所有者 | 责任 |
| --- | --- | --- |
| RLM 工作区 | `prime_context` | 持久变量、元数据 catalog、有界读取、字面搜索与乐观并发写入 |
| 控制面 | DSH Code Mode | 程序化组合工具、`Promise.all`、子 Agent admission 与 Job 结果回收 |
| 持续学习 | `prime_refine` | 少量、基于证据、可安全回滚的路由与行为经验 |

动态 prompt 只注入工作区元数据。完整值保留在内容寻址 blob 中，直到模型显式调用 `get` 或 `search`。因此 prompt 成本取决于当前决策读取了多少内容，而不是一共存了多少上下文。

v0.2 复用 DSH 公开的 Agent Loop、Code Mode、Code Runtime、Subagent、Jobs、Goal、Workflow、Session 与取消契约，不修改 Harness、不内嵌 IPython，也不创建第二套 Worker 生命周期。

## 安装

```sh
npm install
npm run check
dsh plugin --profile web add ./dsh-prime-agent
```

`dsh plugin add` 即提供全部内容：随包 bundle patch 把宿主 `code-runtime` provider 替换为 `dsh-prime-agent/runtime`；随包 Prime preset（DSH Code preset 副本加 scoped Prime 条目）在启动时落位到 `$DSH_HOME/.agent-presets`（仅缺失时）。启用 Prime 模式只是为某个 Session 在选择器中选中 Prime preset；默认 preset 与其他 preset 保持官方 one-shot 语义。落位后的 preset 之后绝不会被覆盖——插件升级与 harness 升级都不刷新它；删除 `$DSH_HOME/.agent-presets/prime` 并重启即可重新落位当前快照。

## RLM 工作流

在 Code Mode 中，先查看元数据，只取所需片段，再持久化可复用结果：

```ts
const catalog = await tools.prime_context({ operation: 'catalog' })
const source = await tools.prime_context({
  operation: 'get',
  key: 'repository-map',
  offset: 0,
  limit: 12000,
})

const reviews = await Promise.all([
  tools.subagent({
    description: 'review storage',
    prompt: `Review storage boundaries:\n${source.content}`,
    run_in_background: false,
  }),
  tools.subagent({
    description: 'review orchestration',
    prompt: `Review orchestration boundaries:\n${source.content}`,
    run_in_background: false,
  }),
])

return await tools.prime_context({
  operation: 'put',
  expected_revision: catalog.revision,
  key: 'review-results',
  kind: 'json',
  summary: 'Independent storage and orchestration reviews',
  value: reviews,
})
```

需要 admission-first 时，调用当前可见的 Subagent 工具并设置 `run_in_background: true`，保留返回的 Job id，父 Agent 继续工作，稍后用 `job_output` 回收结果。具体 Subagent/Job 参数来自当前 profile 安装的 DSH 工具；本插件不会复制它们的 schema。

## `prime_context`

所有操作默认使用 `scope: "local"`。local 状态属于发起调用的 Agent Session；global 默认关闭。

| 操作 | 必需输入 | 结果 |
| --- | --- | --- |
| `catalog` | 无 | 分页条目、总字节数与当前 revision；绝不返回值内容 |
| `put` | `expected_revision`、`key`、`kind`、`summary`、`value` | 创建或替换值并推进 manifest revision |
| `get` | `key` | 有界文本/序列化 JSON 范围、JSON Pointer 选择或 artifact reference |
| `search` | `query` | 有界字面匹配以及前后窗口 |
| `delete` | `expected_revision`、`key` | 删除 catalog 条目并推进 revision |

值类型：

- `text`：精确字符串。
- `json`：无损 JSON；使用 RFC 6901 `pointer` 做结构化选择。
- `artifact`：`{ uri, mediaType?, description? }`；外部子系统仍然拥有真实 artifact。

`put` 与 `delete` 使用乐观并发。先通过 `catalog` 读取当前 revision，再把它作为 `expected_revision`；过期写入会得到明确冲突，不会覆盖更新结果。

## `prime_refine`

持续学习刻意放在次要位置。不要存研究资料、任务状态、工具输出或大上下文；只有出现重复失败、用户纠正或稳定可复用策略后才使用它。

- `inspect` 返回当前 revision、条目和近期事务。
- `apply` 需要 inspect 得到的 revision、trigger、具体 evidence、可验证的 expected outcome，以及最小 create/update/delete edits。
- `rollback` 需要当前 revision 和目标 transaction id，且只有相关条目没有发生漂移时才成功。

条目类型包括 `prompt`、`memory`、`skill` 与 `subagent`。skill/subagent 只能引用真实可见的工具；它们记录路由，不会创建能力或扩大权限。

## 配置

`stateDirectory` 必填。未配置选项时使用下列默认值。

| 选项 | 默认值 | 含义 |
| --- | --- | --- |
| `contextToolName` | `prime_context` | RLM 工作区工具名 |
| `refineToolName` | `prime_refine` | 持续学习工具名 |
| `allowGlobalContext` | `false` | 允许模型访问 global 工作区 |
| `allowGlobalRefinement` | `false` | 允许模型访问 global 学习状态 |
| `requireCodeMode` | `true` | 要求 `run_code` 是模型唯一可见工具 |
| `requireOrchestrationTools` | `true` | 要求具备 Subagent admission 与 `job_output` |
| `context` | 有界默认值 | 工作区配额、读/搜索限制和 catalog prompt 预算 |
| `continual` | 有界默认值 | 学习条目、事务、状态与 prompt 限制 |

bundle patch 只承载 host `code-runtime` 替换，不改默认 preset 或工具展示模式。`dsh-prime-agent/runtime` 条目另接受官方预算字段（`computeMs`、`maxWallMs`、`maxOutputBytes`、`maxOldGenerationSizeMb`，同名逐字透传）与 realm pool 治理项（`maxActiveRealms`、`maxIdleMs`、`maxHostCallsPerRun`、`maxParallelHostCallsPerRun`、`maxStateEntries`）。

## 存储与安全

- 新状态位于 `<stateDirectory>/rlm` 与 `<stateDirectory>/continual`；代码绝不检查 0.1 文件。
- local manifest 文件名使用 Session id 的 SHA-256。
- RLM 值存储为不可变 SHA-256 内容寻址 blob；manifest 只保存元数据与 hash。
- manifest 提交使用跨进程写锁与原子替换；读取 blob 时校验 hash 与字节数。
- catalog、单值、scope、manifest、读取和搜索预算都由部署配置控制。
- Continual-learning 条目以经过 JSON 引用的不可信建议记录进入 prompt。结构性 metadata 拒绝控制与格式字符；记录不能覆盖当前 system、user、权限或工具约束。
- 状态损坏、超限、丢失或 revision 冲突都会明确失败。
- delete 只移除 manifest 引用，目前仍保留不可变 blob。Capsule 分享与 blob 保留/回收策略推迟到后续版本。

在宿主平台支持时会请求 POSIX owner-only 权限。这些措施用于持久化与完整性加固，不代表安全沙箱。

## 为什么 IPython 只是参考而不是 backend？

DSH Code Mode 已经集成 scoped tools、日志、取消、Subagent 与 Jobs，因此 Prime 保持唯一的模型可见编程界面，并通过 `prime_context` 显式持久化数据。

这里提供的是持久 RLM 工作区，不是持久 JavaScript heap。当前公开的 `CodeRunRequest` 只有 program、bindings 和 abort signal，没有所属 Session 身份或 release 生命周期；标准 Worker Runtime 也刻意采用单次执行。插件因此不会宣称函数、import、对象、索引或 client 能跨 `run_code` 保留，也不会通过重放可能有副作用的代码、monkey patch Harness 或嵌套第二个代码执行器来伪造这种保证。

已批准的 [v0.3 路线](docs/v0.3-roadmap.md) 保留原生 Code Mode bridge，通过带认证的 `prime_realm_identity` binding handshake 把 Prime Session 路由到长期 Worker，普通 Session 继续使用官方 one-shot Runtime。`prime_context` 仍承担显式可靠状态；IPython 只作为设计参考。

## 开发

开发测试会把公开 DSH 包名解析到同级 `../deepseek-harness` 源码；发布包只导入公开包名。

DSH peer range 有意限制在兼容的 `0.1.x` 系列。它们标记为 optional，是为了避免 npm 在已经提供这些包的宿主中安装第二套 Harness package graph；当 profile 的 bundles 不提供 runtime row 导入的 Code Mode 包时，该 row 会以明确诊断失败（请使用 web 或 headless profile）；如果选定的 DSH composition 缺少必需 service，插件加载仍会失败。当前 DSH `PromptContext` 契约是同步的，因此动态 prompt provider 使用有界同步文件快照；state directory 应放在本机存储，而不是网络文件系统。

```sh
npm run typecheck
npm test
npm run build
```
