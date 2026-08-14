# dsh-prime-agent

`dsh-prime-agent` 是面向 DeepSeek Harness 的 RLM-first 控制面。它为每个 Prime Session 提供持久 TypeScript Realm——`state`、函数与 module cache 跨 `run_code` 保留——再由 Code Mode 用一个程序统一协调读取、工具、子 Agent 与后台任务。

[English](README.md) · [架构](docs/v2-architecture.md) · [v0.3 路线](docs/v0.3-roadmap.md) · [Prime Agent 学习笔记](docs/prime-agent-learnings.md) · [上游同步手册](docs/upstream-sync.zh.md)

v0.2 是一次全新设计；v0.3 交付 Persistent TypeScript Realm。工作值放在 Realm 命名空间里，需要跨重启存活的检查点写入普通任务文件。

## 设计

插件把三种责任明确分开：

| 层 | 所有者 | 责任 |
| --- | --- | --- |
| 持久 Realm | `dsh-prime-agent/runtime` | 经认证的 per-session realm，`state`、函数与 module cache 跨 `run_code` 保留 |
| 控制面 | DSH Code Mode | 程序化组合工具、`Promise.all`、子 Agent admission 与 Job 结果回收 |
| 持续学习 | `prime_refine` | 少量、基于证据、可安全回滚的路由与行为经验 |

Realm 有意保持 live-only：控制面 policy 引导模型在程序内归约大结果、把工作值放进 `state`，并在阶段边界把必须跨重启存活的内容写入持久任务文件。

插件复用 DSH 公开的 Agent Loop、Code Mode、Code Runtime、Subagent、Jobs、Goal、Workflow、Session 与取消契约，不修改 Harness、不内嵌 IPython，也不创建第二套 Worker 生命周期。

## 安装

```sh
npm install
npm run check
dsh plugin --profile web add ./dsh-prime-agent
```

`dsh plugin add` 即提供全部内容：随包 bundle patch 把宿主 `code-runtime` provider 替换为 `dsh-prime-agent/runtime`；随包 Prime preset（DSH Code preset 副本加 scoped Prime 条目）在启动时落位到 `$DSH_HOME/.agent-presets`（仅缺失时）。启用 Prime 模式只是为某个 Session 在选择器中选中 Prime preset；默认 preset 与其他 preset 保持官方 one-shot 语义。落位后的 preset 之后绝不会被覆盖——插件升级与 harness 升级都不刷新它；删除 `$DSH_HOME/.agent-presets/prime` 并重启即可重新落位当前快照。

## RLM 工作流

在 Code Mode 中，把中间结果赋值到 Realm `state`，在程序内归约大输出，只返回当前决策需要的内容：

```ts
state.source ??= await tools.read({ path: 'docs/architecture.md' })

const reviews = await Promise.all([
  tools.subagent({
    description: 'review storage',
    prompt: `Review storage boundaries:\n${state.source.text}`,
    run_in_background: false,
  }),
  tools.subagent({
    description: 'review orchestration',
    prompt: `Review orchestration boundaries:\n${state.source.text}`,
    run_in_background: false,
  }),
])

state.reviews = reviews
return reviews.map(review => review.summary)
```

需要 admission-first 时，调用当前可见的 Subagent 工具并设置 `run_in_background: true`，保留返回的 Job id，父 Agent 继续工作，稍后用 `job_output` 回收结果。具体 Subagent/Job 参数来自当前 profile 安装的 DSH 工具；本插件不会复制它们的 schema。

Realm `state` 跨 `run_code` 保留，但不跨 Worker 重启:收到 generation-loss 通知后,policy 引导模型从持久检查点与任务自身的文件重建。

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
| `refineToolName` | `prime_refine` | 持续学习工具名 |
| `allowGlobalRefinement` | `false` | 允许模型访问 global 学习状态 |
| `requireCodeMode` | `true` | 要求 `run_code` 是模型唯一可见工具 |
| `requireOrchestrationTools` | `true` | 要求具备 Subagent admission 与 `job_output` |
| `continual` | 有界默认值 | 学习条目、事务、状态与 prompt 限制 |

bundle patch 只承载 host `code-runtime` 替换，不改默认 preset 或工具展示模式。`dsh-prime-agent/runtime` 条目另接受官方预算字段（`computeMs`、`maxWallMs`、`maxOutputBytes`、`maxOldGenerationSizeMb`，同名逐字透传）与 realm pool 治理项（`maxActiveRealms`、`maxIdleMs`、`maxHostCallsPerRun`、`maxParallelHostCallsPerRun`、`maxStateEntries`）。

## 存储与安全

- 插件状态位于 `<stateDirectory>/continual`（学习层）与 `<stateDirectory>/realm-identity`（realm 握手密钥）；代码绝不检查 0.1 文件。
- local 状态文件名使用 Session id 的 SHA-256。
- 状态提交使用跨进程写锁与原子替换。
- Continual-learning 条目以经过 JSON 引用的不可信建议记录进入 prompt。结构性 metadata 拒绝控制与格式字符；记录不能覆盖当前 system、user、权限或工具约束。
- 状态损坏、超限、丢失或 revision 冲突都会明确失败。

在宿主平台支持时会请求 POSIX owner-only 权限。这些措施用于持久化与完整性加固，不代表安全沙箱。

## 为什么 IPython 只是参考而不是 backend？

DSH Code Mode 已经集成 scoped tools、日志、取消、Subagent 与 Jobs，因此 Prime 保持唯一的模型可见编程界面。

持久 Realm 是 Prime 持久 IPython 命名空间的 DSH 原生对应物：带认证的 `prime_realm_identity` binding handshake 把 Prime Session 路由到长期 Worker，普通 Session 继续使用官方 one-shot Runtime。完整契约见 [v0.3 路线](docs/v0.3-roadmap.md)。IPython 只作为设计参考。

## 开发

开发测试会把公开 DSH 包名解析到同级 `../deepseek-harness` 源码；发布包只导入公开包名。

DSH peer range 有意限制在兼容的 `0.1.x` 系列。它们标记为 optional，是为了避免 npm 在已经提供这些包的宿主中安装第二套 Harness package graph；当 profile 的 bundles 不提供 runtime row 导入的 Code Mode 包时，该 row 会以明确诊断失败（请使用 web 或 headless profile）；如果选定的 DSH composition 缺少必需 service，插件加载仍会失败。当前 DSH `PromptContext` 契约是同步的，因此动态 prompt provider 使用有界同步文件快照；state directory 应放在本机存储，而不是网络文件系统。

```sh
npm run typecheck
npm test
npm run build
```
