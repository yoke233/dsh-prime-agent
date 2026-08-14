# Prime Agent 学习笔记

本文记录从 Prime Agent 基线 `7787f07415d843b9a800f6a4720e0c739bd608e5` 提炼出的设计经验。目标是持续学习其行为模型，而不是复制 Python、Jupyter、Daemon 或 TypeScript 文件结构。后续基线更新流程见 [上游同步与差异对照手册](upstream-sync.zh.md)。

## 核心判断

Prime Agent 把 Agent 视为长期运行的计算过程，而不是一次性聊天循环。Recursive Language Model（RLM）负责可编程执行、外部上下文和递归 Agent；Continual Harness 负责可编辑、可审计的行为经验。两者不能混为一个 memory 插件。

目前上游最重要的语义是：

- IPython 是持久控制环境，不是目标项目的运行环境。
- `rlm()` 在子任务被接收后立即返回 child handle，不等待最终答案。
- child 通过显式 `agent_message` 或文件稍后汇报，父 Agent 可以先结束当前 turn 或继续其他工作。
- TypeScript Host 拥有 child registry、消息、目标、取消、Session 与状态转换；Python 只提交 typed host request。
- Continual Harness 与 RLM runtime 明确分层，refinement 是小而有证据的状态改变。

## 可移植的不变量

### 上下文应当可寻址

模型上下文只保留当前决策需要的信息。大文件、搜索结果和中间数据留在模型请求之外，通过 catalog、范围读取、结构化选择或搜索窗口按需进入推理。

在 DSH 适配中，这一原则由持久 Realm 与程序内归约实现：大结果在 `run_code` 程序内过滤、聚合后留在 Realm `state`，需要跨重启存活的检查点写入持久任务文件；进入上下文的只有当前决策需要的摘要。

### 控制面应当可编程

Prime 用持久 IPython 组合变量、函数、skills 与子 Agent。可移植的核心不是 Python 语法，而是模型只面对一个代码控制面，并能在一个程序中选择数据、并发调用能力、持久化中间结果。

DSH 的对应物是 Code Mode。`run_code` 是模型唯一可见工具，普通工具成为 scoped SDK bindings。这样继续复用 DSH 的 schema、权限、日志、取消和输出处理。

### 子 Agent 是异步参与者

上游 `rlm()` 的返回值代表 admission，不代表完成。child answer 通过后续消息或文件到达。这避免父 Agent 把递归任务误当成普通同步函数，也让 parent/child 生命周期真正解耦。

DSH 适配保留的核心行为是：后台 Subagent admission 返回 Job handle，父 Agent 随即可继续，稍后通过 `job_output` 收集结果。DSH 目前的结果回收与上游显式 family message 并不完全相同；这是需要持续评估的语义差距，不应通过插件私建消息总线草率解决。

前台独立子任务仍可在 Code Mode 使用 `Promise.all`，但它表达的是“本轮需要 fan-in 的并发工作”，不是 admission-first 的长期 child 协作。

### 模型接口与权威状态必须分离

Prime 的 Python shim 表达意图，Host 验证并执行。凭据、Session、Agent family、消息队列和生命周期不由 Kernel 代码拥有。

DSH 插件遵循同一边界：

- 持久 Realm 拥有自己的身份、generation 与资源治理。
- Agent、Subagent、Jobs、Goal、Session 和 Code Runtime 继续拥有各自权威状态。
- 插件只组合公开服务，不复制 registry 或绕过权限。
- 模型可见工具调用与结果仍进入 DSH 日志路径。

### 长任务需要独立生命周期

Heartbeat、Schedule、Goal、compaction 与 daemon worker 都服务于“任务不能依赖一次终端连接”的目标。DSH 已有对应能力时，适配层的职责是提供正确路由和 RLM 工作区，不是再造主循环。

### 自我改进必须受限

Continual Harness 只修改补充状态，不能改写基础 system prompt。改进应当：

- 来自重复失败、用户纠正或稳定成功策略；
- 默认 local；
- 包含 trigger、具体 evidence 与可验证 expected outcome；
- 在提交时重新检查 revision；
- 记录 before/after 并支持冲突安全 rollback；
- 不保存任务过程数据和大上下文。

上游已经提供自动 refinement，但 DSH 适配不会仅因为上游默认开启就直接复制。自动模型写入需要先把 proposal、review、权限与效果观察设计完整。

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
- `agent_message` 的协议不能在没有 DSH 原生 family contract 时被表面仿造。
- Prime 针对 Python Kernel 的 system prompt 不能原样注入 TypeScript Code Mode。
- Prime Harness 文件格式不能冒充 DSH Session Event。
- TUI、ACP、模型 provider、计费和安装器通常不属于本插件范围。
- 进程隔离不是安全沙箱，持久运行也不代表权限隔离。

## 当前映射

| Prime Agent | dsh-prime-agent / DSH |
| --- | --- |
| 持久 IPython 控制面 | Code Mode + Persistent TypeScript Realm；IPython 仅作语义参考 |
| Python 变量/文件上下文 | manifest catalog + content-addressed blobs |
| `rlm()` admission handle | 后台 Subagent Job handle |
| foreground independent work | Code Mode `Promise.all` 调用真实工具/Subagent |
| child 显式 reply | 当前主要是 completion delivery / `job_output`；保留语义差距 |
| list/delete child | DSH 可见 Job/Subagent 观察与取消工具 |
| `rlm.harness` | `prime_refine` |
| `/refine` / auto-refine | 显式 inspect/apply/rollback；自动 proposal 尚未实现 |
| Persistent Goal | DSH Goal 与 round driver |
| Heartbeat / Schedule | DSH Jobs 与 Schedule |
| compaction | DSH Compaction |
| Host bridge | Cordis 服务、tool runtime 与 typed schemas |

## 当前结论

好的适配不是让 DSH 看起来像在运行 Prime 的 Python，而是让它拥有同一种工作感觉：模型用代码协调能力，把上下文当作可寻址状态，让 child 独立运行，并把稳定经验与过程数据分开。

当前已交付 PTC/Code Mode + Persistent Realm + Subagent/Jobs + `prime_refine` 闭环。DSH PTC 提供 Prime 式的可编程工具与递归 Agent 编排；持久 Realm 让函数、对象、索引与工具编排代码跨 run 延续，对应 Prime 的持久计算 namespace。

我们学习这一不变量，而不绑定其实现语言。v0.3 保留 DSH 原生 Code Mode bridge，通过带 challenge proof 的 `prime_realm_identity` binding handshake 取得不透明 Session Realm 身份；hybrid Runtime 只让 Prime Session 进入 Persistent TypeScript Worker，其他请求继续委托官方 one-shot Worker。跨重启的可靠数据层是持久任务文件，IPython 只用于参考 cell 连续性、中断、snapshot 限制与恢复语义。Context Capsule 与 Agent family 顺延到 v0.4，自动学习顺延到 v0.5。具体边界见 [v0.3 路线](v0.3-roadmap.md)。

Agent family 的学习同样关注控制语义而不是 API 名称：child 的中间发现应尽可能进入 parent 当前计算的最近 step，而不是无条件积压成多个独立后续轮次。DSH 当前默认 report 路由与此仍有差距；插件先记录并推动宿主提供调度扩展点，不直接修改宿主实现。
