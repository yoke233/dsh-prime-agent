# dsh-prime-agent

`dsh-prime-agent` 是面向 DeepSeek Harness 的 RLM-first 控制面。它把大上下文和中间结果变成可持久化、可寻址的工作区，再由 Code Mode 用一个程序统一协调读取、工具、子 Agent 与后台任务。

[English](README.md) · [架构](docs/v2-architecture.md) · [v0.3 路线](docs/v0.3-roadmap.md) · [Prime Agent 学习笔记](docs/prime-agent-learnings.md) · [上游同步手册](docs/upstream-sync.zh.md)

0.2 是一次全新设计：不读取 0.1 状态、不保留旧 `prime_harness` API，也不提供迁移路径。

## 设计

插件把三种责任明确分开：

| 层 | 所有者 | 责任 |
| --- | --- | --- |
| RLM 工作区 | `prime_context` | 持久变量、元数据 catalog、有界读取、字面搜索与乐观并发写入 |
| 控制面 | DSH Code Mode | 程序化组合工具、`Promise.all`、子 Agent admission 与 Job 结果回收 |
| 持续学习 | `prime_refine` | 少量、基于证据、可安全回滚的路由与行为经验 |

动态 prompt 只注入工作区元数据。完整值保留在内容寻址 blob 中，直到模型显式调用 `get` 或 `search`。因此 prompt 成本取决于当前决策读取了多少内容，而不是一共存了多少上下文。

插件复用 DSH 的 Agent Loop、TypeScript Code Runtime、Subagent、Jobs、Goal、Workflow、Session 与取消语义，不内嵌 IPython，也不创建第二套 Worker 生命周期。

## 安装

```sh
npm install
npm run check
dsh plugin --profile web add ./dsh-prime-agent
```

随包提供的 bundle patch 会选择 Code Mode，并把全新状态写入 `$DSH_HOME/prime-agent-v2`。需要无界面运行时可换成 `headless` 等其他 profile。

默认 bundle 要求当前 DSH preset 能看到 `subagent`（或 `subagent_fork`）和 `job_output`；如果没有组合这些工具，system prompt assembly 会明确失败。

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

`stateDirectory` 必填。下列默认值与随包 preset 一致。

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

所有具体限制见 [cordis.patch.yml](cordis.patch.yml)。

## 存储与安全

- 新状态位于 `<stateDirectory>/rlm` 与 `<stateDirectory>/continual`；代码绝不检查 0.1 文件。
- local manifest 文件名使用 Session id 的 SHA-256。
- RLM 值存储为不可变 SHA-256 内容寻址 blob；manifest 只保存元数据与 hash。
- manifest 提交使用跨进程写锁与原子替换；读取 blob 时校验 hash 与字节数。
- catalog、单值、scope、manifest、读取和搜索预算都由部署配置控制。
- 状态损坏、超限、丢失或 revision 冲突都会明确失败。
- delete 只移除 manifest 引用，目前仍保留不可变 blob。Capsule 分享与 blob 保留/回收策略推迟到后续版本。

在宿主平台支持时会请求 POSIX owner-only 权限。这些措施用于持久化与完整性加固，不代表安全沙箱。

## 为什么不使用 IPython？

Prime Agent 最重要的性质是：可编程控制面可以操作可寻址上下文与异步 Agent，而不是必须采用 Python 语法。DSH 已有 TypeScript Code Runtime，并已集成 scoped tools、日志、取消、Subagent 与 Jobs。嵌入持久 IPython kernel 会增加另一套 RPC、进程、恢复、隔离与所有权边界。

因此 0.2 只把数据持久化到 `prime_context`，每次 `run_code` 调用本身仍是临时执行。只有当 Python 对象身份和 kernel 兼容性成为明确产品需求时，才值得考虑 Python runtime。

## 开发

开发测试会把公开 DSH 包名解析到同级 `../deepseek-harness` 源码；发布包只导入公开包名。

```sh
npm run typecheck
npm test
npm run build
```
