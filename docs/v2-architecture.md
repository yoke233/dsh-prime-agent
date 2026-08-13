# dsh-prime-agent v2 架构：DSH 原生 RLM 控制面

## 状态

本文描述已经实现的 0.2 架构，不再是兼容 0.1 的演进提案。

- 0.2 使用全新配置、工具名、源码结构和状态目录。
- 不读取旧 `prime_harness` 状态，不提供迁移或兼容入口。
- `prime_context` 是主能力；`prime_refine` 是次级学习层。
- Code Mode 是唯一模型可见控制面。
- IPython、Context Capsule `share`/`mount`、blob GC 和自动 refinement 不属于 0.2。

## 核心判断

Prime Agent 最有辨识度的部分不是一组 memory 条目，而是 RLM 工作方式：上下文成为可寻址数据，推理成为对数据、工具和 Agent 的程序化调度。

在 DSH 中复制持久 IPython 会重新引入 Kernel、RPC、进程回收、scope 路由、取消和权限边界。更合适的做法是保留 RLM 不变量，同时复用 DSH 已拥有的运行时：

```text
用户任务
  → prime_context catalog（只看元数据）
  → get / search（按需取片段）
  → run_code（组合、过滤、并发）
  → subagent / jobs（独立执行与后台生命周期）
  → prime_context put（保存可复用中间结果）
  → 下一轮重新按 key 恢复
  → 反复验证后的经验才进入 prime_refine
```

因此 0.2 的设计顺序是：

1. RLM 工作区负责持久上下文。
2. DSH Code Mode 负责程序化控制。
3. DSH Subagent/Jobs 负责执行生命周期。
4. Continual Harness 只负责稳定经验。

## 组件边界

### `rlm/`：持久上下文工作区

`prime_context` 支持五个操作：

| 操作 | 契约 |
| --- | --- |
| `catalog` | 返回 key、kind、summary、hash、大小、版本与 revision；不返回内容 |
| `put` | 通过 `expected_revision` 原子创建或替换 text、JSON、artifact reference |
| `get` | 有界字符范围、RFC 6901 JSON Pointer 或有界 artifact reference |
| `search` | 在 text/序列化 JSON 中做有界字面搜索，返回上下文窗口 |
| `delete` | 通过 `expected_revision` 删除 manifest 引用 |

每个 local Session 或 global scope 有一个原子 manifest：

```ts
interface ContextManifest {
  schemaVersion: 1
  scope: 'local' | 'global'
  owner: string
  revision: number
  totalBytes: number
  entries: ContextEntry[]
}
```

值先序列化，再以 SHA-256 内容寻址写入共享 `blobs/`。manifest 只保存元数据、hash 和字节数。local manifest 文件名使用 Session id 的 SHA-256，不把原始 id 暴露到文件名。

写入顺序是 blob 后 manifest。manifest 更新在跨进程锁内检查 revision，并通过原子替换提交。读取时校验 blob 的 hash 与字节数。并发写不会静默覆盖，损坏或超限状态不会静默降级。

### Code Mode：唯一模型控制面

当存在 owning Agent 时，system prompt assembly 必须只向模型暴露 `run_code`。`prime_context`、`prime_refine`、Subagent 和 Jobs 作为 Code Mode SDK 成员被程序调用。

RLM policy 明确要求：

- 先 catalog，后按需 get/search。
- 独立前台工作用 `Promise.all`。
- 后台工作通过 DSH Subagent admission 与 Job handle 继续。
- 中间数据写入 `prime_context`，不塞进 prompt 或 continual state。
- summary 只是元数据，不能当作真实内容使用。

插件在 assembly 阶段检查 Subagent 与 `job_output` 是否真实可见。缺少必需编排能力时明确失败，不假装具备 Prime 式体验。

### DSH Subagent/Jobs：生命周期所有者

插件不创建 Worker registry、消息总线或 Agent Loop。

- 前台并发：Code Mode 中对真实 Subagent 工具使用 `Promise.all`。
- 后台 admission-first：使用工具的 `run_in_background: true`，保留返回的 Job id。
- 稍后回收：使用 `job_output`。
- 取消、观察、持久化和 completion delivery：由 DSH Jobs/Subagent 拥有。
- Goal、Workflow、Compaction、Schedule：继续使用 DSH 原生能力。

Prime 上游现在强调 child answer 通过后续 `agent_message` 或文件返回，而不是由 `rlm()` fan-in。0.2 保留“父 Agent admission 后继续”的核心不变量，但主要通过 DSH Job 拉取结果；这是已记录的语义差距，不通过另建消息系统强行抹平。

### `continual/`：次级学习层

`prime_refine` 保留 inspect/apply/rollback，但不再承担工作区责任：

- 禁止存任务数据、研究笔记、中间结果和大上下文。
- apply 必须有 trigger、具体 evidence、可验证 expected outcome 与最小 edits。
- apply/rollback 使用 optimistic revision。
- rollback 只在目标事务输出未被后续修改时成功。
- skill/subagent 条目必须引用真实可见工具，不能引用 `run_code` transport。
- local/global 默认都由部署策略控制，global 默认关闭。

continual prompt snapshot 只包含有界的稳定经验。基础 system prompt 不可由 refinement 修改。

## Prompt 与 token 边界

每轮动态 prompt 包含：

1. RLM orchestration policy。
2. local（以及显式允许时的 global）workspace catalog 元数据。
3. 有界 continual learning snapshot。

完整 workspace 值绝不自动注入。catalog 受 `maxCatalogEntries` 和 `maxCatalogChars` 限制；读取、搜索窗口、扫描总量、单值、scope 总量与 manifest 大小分别受限。

目标是让 token 消耗近似：

```text
固定 policy + 有界元数据 + 当前显式读取量
```

而不是：

```text
所有历史上下文与中间结果之和
```

## 状态布局

```text
<stateDirectory>/
  rlm/
    global.json
    sessions/<sha256-session-id>.json
    blobs/<sha256-content>.blob
  continual/
    global.json
    sessions/<sha256-session-id>.json
```

这是 0.2 独有布局。旧文件不在读取路径中。

delete 目前只删除 manifest 引用，保留不可变 blob，便于去重且避免并发删除竞态。0.3 在引入 immutable capsule 后再统一设计引用、保留期和 GC。

## 为什么 0.2 不使用 IPython

持久 IPython 的优势是保留活 Python 对象、函数和 Kernel 命名空间；代价是另一套进程、Comm/RPC、资源配额、崩溃恢复、安全和 Agent scope 绑定。

DSH TypeScript Code Runtime 已提供：

- 唯一模型可见 `run_code` 界面；
- scoped tool SDK；
- 并发组合；
- 日志、取消和输出约束；
- 与 Subagent/Jobs 的原生集成。

所以 0.2 持久化的是数据命名空间，不是 JavaScript heap。只有当产品明确需要 Python 对象身份、Notebook 兼容或 Python-only 控制库时，才评估新的 Python Code Runtime；它不应作为 `prime_context` 旁边的第二套临时工具偷偷引入。

## 配置与部署不变量

- `stateDirectory` 必填。
- `requireCodeMode` 默认 true。
- `requireOrchestrationTools` 默认 true。
- global context 与 global refinement 默认 false。
- 工具名必须匹配小写字母、数字和下划线规则，且两者不能相同。
- 所有 limit 必须为正整数；Schemastery 还对 manifest/catalog/state 的最低安全值做约束。
- bundle 显式把 DSH tools mode 设置为 `code`，并使用 `$DSH_HOME/prime-agent-v2` 新目录。

## 0.2 验收结果

- 大值完整存储，动态 prompt 只出现有界 catalog 元数据。
- 支持跨 `ContextStore` 实例/跨 turn 按 key 恢复。
- 支持字符切片、JSON Pointer 和有界字面搜索。
- revision 冲突、scope 配额、manifest 配额与 blob 完整性明确失败。
- 真实 DSH Code Mode SDK 包含 `prime_context`、`prime_refine` 与 Subagent/Jobs。
- 一个真实 `run_code` 调用可通过 `Promise.all` 并发启动多个 Subagent。
- 后台 Subagent admission 后，父 Agent 能先写入工作结果，再在 child 完成后通过 `job_output` 回收并持久化结果。
- Continual Harness 的历史回滚、极小 evidence 限制与 tool reference normalization 已有回归覆盖。
- 不修改 DSH Agent Loop，不复制 Subagent/Jobs 生命周期。

## 后续边界

### 0.3：Context Capsule

- 不可变 `share`/`mount`。
- 显式父子上下文授权。
- capsule 生命周期、引用或 TTL，以及 blob GC。
- 评估 DSH family messaging 是否能更接近 Prime 的显式 child reply。

完整任务分解、契约和验收标准见 [v0.3 路线：Context Capsule 与 Agent Family](v0.3-roadmap.md)。

### 0.4：学习闭环

- 从失败、纠正与稳定成功生成 proposal。
- proposal、review、apply 分离。
- global 修改默认需要明确批准。
- 观察效果并提出回滚建议，不自动扩大权限。

## 上游同步

Prime Agent 会继续变化。每次更新都应比较行为不变量，而不是机械复制代码。基线、观察路径、判断矩阵和验证步骤见 [上游同步与差异对照手册](upstream-sync.zh.md)。
