# Prime Agent 学习笔记

本文记录从 Prime Agent 基线 `aacf04b4678fd02cf46b69ab0bdcbc5d29baab45` 提炼出的设计经验。目标是持续学习其行为模型，而不是复制 Python、Jupyter、Daemon 或 TypeScript 文件结构。后续基线更新流程见 [上游同步与差异对照手册](upstream-sync.zh.md)。

## 核心判断

Prime Agent 把 Agent 视为长期运行的计算过程，而不是一次性聊天循环。Recursive Language Model（RLM）负责可编程执行、外部上下文和递归 Agent；Continual Harness 负责可编辑、可审计的行为经验。两者不能混为一个 memory 插件。

目前上游最重要的语义是：

- IPython 是持久控制环境，不是目标项目的运行环境。
- `rlm()` 在子任务被接收后立即返回 child handle，不等待最终答案。
- child 通过显式 `agent_message` 或文件稍后汇报，父 Agent 可以先结束当前 turn 或继续其他工作。
- TypeScript Host 拥有 child registry、消息、目标、取消、Session 与状态转换；Python 只提交 typed host request。
- 慢任务采用非阻塞控制循环：保存 handle 或输出位置后继续独立工作或结束当前 turn，不用 sleep 轮询或长阻塞 await 占住交互。
- 持久 namespace 是紧凑工作集，不是大对象仓库；上游对 Python 快照设单变量限额，DSH 则把大材料留在文件/spill artifact，并明确 live Realm 不由 compaction 清理。
- Continual Harness 与 RLM runtime 明确分层，refinement 是小而有证据的状态改变。

## 可移植的不变量

### 上下文应当可寻址

模型上下文只保留当前决策需要的信息。大文件、搜索结果和中间数据留在模型请求之外，通过 catalog、范围读取、结构化选择或搜索窗口按需进入推理。

在 DSH 适配中，这一原则由持久 Realm 与程序内归约实现：大结果在 `repl` 程序内过滤、聚合后留在 live namespace，需要跨重启存活的检查点写入持久任务文件；进入上下文的只有当前决策需要的摘要。

### 控制面应当可编程

Prime 用持久 IPython 组合变量、函数、skills 与子 Agent。可移植的核心不是 Python 语法，而是模型只面对一个代码控制面，并能在一个程序中选择数据、并发调用能力、持久化中间结果。

DSH 的对应物是 `repl`：它是模型唯一可见工具，普通 DSH 工具不进入模型 schema，而是成为 cell 内预加载的 `tools`/`agents`/`jobs` bindings。这样继续复用 DSH 的 schema、权限、日志、取消和输出处理。

### 子 Agent 是异步参与者

上游 `rlm()` 的返回值代表 admission，不代表完成。child answer 通过后续消息或文件到达。这避免父 Agent 把递归任务误当成普通同步函数，也让 parent/child 生命周期真正解耦。

DSH 适配保留的核心行为是：continuable Subagent 在 child inbox 接受初始消息后返回持久 child id，父 Agent 随即可继续；后续通过 `send_message`、`list_agents`、`interrupt_agent` 和 child `report` 协作。child 详细过程保存在自己的 Session，不被包装成 Job result。Jobs 只承载 one-shot background provider 和其他通用后台任务。

前台并发子任务仍可在 repl 程序内 fan-in：只有任一失败会让全部成功结果都失去用途时使用 `Promise.all`；相互独立的读取、搜索和探测使用 `Promise.allSettled` 或逐项捕获失败。两者都不同于 admission-first 的长期 child 协作。

### 模型接口与权威状态必须分离

Prime 的 Python shim 表达意图，Host 验证并执行。凭据、Session、Agent family、消息队列和生命周期不由 Kernel 代码拥有。

DSH 插件遵循同一边界：

- 持久 Realm 拥有自己的身份、live namespace 与资源治理。
- Agent、Subagent、Jobs、Goal、Session 和 Code Runtime 继续拥有各自权威状态。
- 插件只组合公开服务，不复制 registry 或绕过权限。
- 模型可见工具调用与结果仍进入 DSH 日志路径。

### 长任务需要独立生命周期

Heartbeat、Schedule、Goal、compaction 与 daemon worker 都服务于“任务不能依赖一次终端连接”的目标。DSH 已有对应能力时，适配层的职责是提供正确路由和 RLM 工作区，不是再造主循环。

慢任务或独立任务应先进入 managed Job 或 continuable child，保存 id、输出位置和恢复检查点，再继续不依赖其结果的工作；如果没有独立工作可做，就结束当前 turn，等待 report、settlement notice 或后续调度。用 `sleep`/`setTimeout` 轮询，或改成一个长阻塞 `await`，都只是把轮询换了写法。直接面向用户的 root 在多回合或多 child 工作中应按有意义的里程碑简洁汇报结果、阻塞和下一步；child 仍通过 `report` 面向 parent，不制造重复的用户进度噪声。

### 持久工作集必须有边界

上游现在把 Python snapshot 限制为有界总量和单变量大小，并在 compaction 时清理无法纳入快照的超大变量。这证明可移植目标是“后续 turn 不应反复搬运大状态”，而不是照搬 16 MiB 阈值或 pickle 清理。

DSH Realm 不做 heap snapshot，compaction 也不会遍历或删除 live bindings。对应策略是：工具的完整 canonical value 可在当前程序内归约；模型 projection 与 durable dispatch log 使用 12KB best-effort spill 阈值，backend 不可用时保留 inline 成功结果；大源数据和结果写入任务文件或使用现有 spill locator；Realm 长期只保留路径、紧凑索引、函数和摘要。任何未来的 binding 级清理都必须显式、可观察、失败原子，不能静默破坏用户状态。spill artifact 的配额、保留期和清理由 DSH store/部署层拥有，不属于本插件。

### 自我改进必须受限

Continual Harness 只修改补充状态，不能改写基础 system prompt。改进应当：

- 来自重复失败、用户纠正或稳定成功策略；
- 默认 local；
- 包含 trigger、具体 evidence 与可验证 expected outcome；
- 在提交时重新检查 revision；
- 记录 before/after 并支持冲突安全 rollback；
- 不保存任务过程数据和大上下文。

上游已经提供自动 refinement；当前 DSH 适配实现显式 inspect/apply/rollback 和人类触发的 `/refine` 有界 proposal，但不实现 auto-refine、独立人工 review 或效果观察。没有完成新的上游行为审阅前，不从本地路线名称反推自动触发与批准契约。

## Continual Harness 数据分类

| 类型 | 责任 | 不应承载 |
| --- | --- | --- |
| `prompt` | 狭窄、补充性的行为规则 | 基础 system prompt 的替代品 |
| `memory` | 稳定事实、决策、偏好和已验证经验 | 临时输出或未经验证的猜测 |
| `skill` | 真实可执行能力的调用说明与参数约束 | 没有实现的虚构工具 |
| `subagent` | 可复用委派角色、条件与汇报约定 | 正在运行的 child 或 Job 状态 |

安装在磁盘上的 Skill 与 Continual Harness 中的 Skill 说明不是同一个对象。Refinement 可以改善调用经验，但不能替代插件安装、代码审查和依赖验证。

## 不直接复制的 Prime 实现

- Jupyter ZeroMQ、Control Channel 与 IPython Kernel 是技术选择，不是 RLM 唯一路径。
- Prime Daemon、Worker、Session JSONL 与 child registry 在 DSH 已有不同所有者。
- `agent_message` 适配必须继续走 DSH 原生 continuable child、inbox 与 `reportFrom` 所有权检查，不能另建消息总线。
- Prime 针对 Python Kernel 的 system prompt 不能原样注入 TypeScript `repl` 模式。
- Prime Harness 文件格式不能冒充 DSH Session Event。
- TUI、ACP、模型 provider、计费和安装器通常不属于本插件范围。
- 进程隔离不是安全沙箱，持久运行也不代表权限隔离。

## 当前映射

| Prime Agent | dsh-prime-agent / DSH |
| --- | --- |
| 持久 IPython 控制面 | 唯一 `repl` 工具 + Persistent TypeScript Realm；IPython 仅作语义参考 |
| Python 变量/文件上下文 | Realm live namespace + 共享工作区 handoff/result files |
| `rlm()` admission handle | continuable Subagent id；inbox acceptance 后立即返回 |
| foreground concurrent work | repl 程序内按失败语义选择 `Promise.all` 或 `Promise.allSettled` 调用真实工具/Subagent |
| child 显式 reply | child `report`；DSH 0.1.2-alpha.2 官方 next-step 调度在父忙时进入最近 step、父闲时唤醒 |
| list/follow-up/cancel child | `list_agents` / `send_message` / `interrupt_agent` |
| delete child | 当前无对应操作；持久 child Session 不由插件删除 |
| `rlm.harness` | `refine` |
| `/refine` / auto-refine | 手动 `/refine` 独立生成有界 proposal 并复用事务 store；auto-refine 未实现 |
| per-child `thinking` | 官方 `reasoning_effort` 参数；先用 `list_subagent_models` 核对目标模型公开的 effort |
| kernel-owned MCP programs | DSH Host MCP client 注册统一 tools；repl 单元从 catalog 生成 `tools.*` bindings |
| IPython snapshot pruning | Realm 不 snapshot/GC；任务文件 + spill artifact + 紧凑 live 工作集 |
| Persistent Goal | DSH Goal 与 round driver |
| Heartbeat / Schedule | DSH Jobs 与 Schedule |
| compaction | DSH Compaction |
| Host bridge | Cordis 服务、tool runtime 与 typed schemas |

## 当前结论

好的适配不是让 DSH 看起来像在运行 Prime 的 Python，而是让它拥有同一种工作感觉：模型用代码协调能力，把上下文当作可寻址状态，让 child 独立运行，并把稳定经验与过程数据分开。

当前已交付唯一模型可见的 `repl` 工具 + 持久 Realm + continuable Subagent/Jobs + 显式 `refine`。`repl` 提供 Prime 式的可编程工具与递归 Agent 编排：模型只调用一个入口，`tools`/`agents`/`jobs` 是 cell 内预加载绑定；持久 Realm 让函数、对象、索引与工具编排代码跨 run 延续，对应 Prime 的持久计算 namespace。新基线补充了非阻塞长任务、root 进度、受限大状态和 Host-owned MCP 的边界；它们通过 DSH 原生生命周期、policy、文件/spill 预算与统一工具注册表适配。

我们学习这一不变量，而不绑定其实现语言。当前 DSH 适配是破坏性的：模型可见入口从 `run_code`/Code Mode SDK 换成唯一 `repl` 工具，身份路由不再经过握手——Agent scope 用可信 `exec.agent.id` 解析不透明 Realm identity，host `primeRealmRuntime` 服务与未被改动的官方 code runtime 并存，非 Prime 会话继续官方 one-shot 语义。旧 `run_code` 入口、旧 Code Mode 组合与旧 live namespace 不迁移：没有 alias、feature flag 或静默降级。跨重启的可靠数据层是工作区文件，跨 Agent 的材料通过只写一次的 handoff file 交接。完整当前边界见 [当前架构](architecture.md)。

child 的中间发现应尽可能进入 parent 当前计算的最近 step，而不是无条件积压成多个独立后续轮次。DSH 已把这一行为收归官方实现：0.1.2-rc.1 撤下 child 专用的 `tool-subagent-report`，改由 `tool-subagent-control` 对两个方向统一暴露 `send_message({ agent_id, message })`，每条消息都走 `Agent.steer()`，忙碌目标在最近 step 消费、空闲目标开启新一轮；continuation manager 维护唤醒记账和 next-step FIFO。本插件因此删除了本地 report adapter，不再复制 DSH 已拥有的消息调度。
