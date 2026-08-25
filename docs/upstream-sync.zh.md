# Prime Agent 上游同步与差异对照手册

[English](upstream-sync.md)

本手册用于让 `dsh-prime-agent` 持续跟进 Prime Agent 的设计，同时避免把适配层变成源码 fork。机器可读基线记录在 [upstream-baseline.json](upstream-baseline.json)。

## 基线规则

当前已审阅的 Prime Agent 基线是：

```text
aacf04b4678fd02cf46b69ab0bdcbc5d29baab45
2026-08-21T21:55:49+08:00
Merge remote-tracking branch 'origin/main' into pr-1053
```

只有完整审阅旧基线到新基线的全部变化、记录设计判断、通过适配层验证并完成 review 后，才能推进这个标记。即使结论是“不改适配层”，也要推进基线，否则下次会重复审阅同一批提交。

## 同步什么

同步行为契约与架构，不同步实现语言和文件形状。

| Prime Agent 概念 | DSH 适配层对应物 | 同步策略 |
| --- | --- | --- |
| 持久 IPython 控制环境 | 唯一 `repl` 工具 + Persistent TypeScript Realm | IPython 只作行为参考；不采用其 runtime 技术栈，也不规划为 backend |
| Python 变量与文件形式的外部上下文 | Realm live namespace + 工作区 handoff/result files | 适配检索、预算、快照交接和恢复行为 |
| `rlm()` admission handle | DSH continuable Subagent id | 用 DSH inbox admission 与 Session persistence 保留 admission-first 语义 |
| `agent_message` 回复与 family roster | `report`、`send_message`、`list_agents` 与 DSH Agent/Subagent 服务 | 复用 DSH 直接父子授权和消息队列，不另建消息总线 |
| `rlm.list_subagents()` / `delete_subagent()` | `list_agents` / 当前无 delete | 复用现有目录与权限检查，不把 interrupt 冒充 delete |
| Continual Harness | `refine` | 适配证据、scope、并发和回滚规则 |
| 手动 `/refine` | DSH 斜杠命令 + 独立有界 LLM proposal + 现有事务 store | 复用接收 Agent 路由，以 maintenance 串行，并在 store apply 前 fail closed |
| Auto-refine 与独立 refine review | 当前未适配 | 必须先重新审阅上游真实契约，不能从手动 `/refine` 反推实现 |
| Goal、compaction、heartbeat、daemon 生命周期 | DSH Goal、Compaction、Jobs、Schedule、Session | 组合，不重复实现 |
| Python/kernel-owned MCP programs | DSH Host MCP 工具注册表 + repl cell bindings | 复用 Host 的连接、认证、工具代际和清理；不在 Realm 内创建第二套 MCP runtime |
| TUI、ACP、provider、计费、安装器 | 不属于本插件 | 除非改变模型可见 RLM 契约，否则忽略 |

兼容目标是用户体验与安全不变量，而不是 API 名称一致。

## 上游重点观察路径

每次基线变化至少审阅：

- `packages/coding-agent/CHANGELOG.md`
- `packages/coding-agent/docs/rlm.md`
- `packages/coding-agent/docs/rlm-runtime.md`
- `packages/coding-agent/docs/long-running-agents.md`
- `packages/coding-agent/src/core/prompts/rlm.ts`
- `packages/coding-agent/src/core/agent-session.ts`
- `packages/coding-agent/src/core/agent-messages.ts`
- `packages/coding-agent/src/core/refinement/`
- `packages/coding-agent/src/core/kernel/`
- `packages/coding-agent/skills/refine/`
- `packages/coding-agent/skills/agent-message/`
- `prime-agent-runtime/src/rlm/`

同时检查新增文件名中包含 `rlm`、`harness`、`subagent`、`agent-message`、`goal`、`compact`、`heartbeat` 或 `schedule` 的文件。

## 更新流程

从 `dsh-prime-agent` 目录运行以下命令。它们只更新远端引用，不改变 Prime Agent 当前检出的分支：

```powershell
$baseline = (Get-Content -Raw docs/upstream-baseline.json | ConvertFrom-Json).baselineCommit
git -C ../prime-agent status --short
git -C ../prime-agent fetch origin
git -C ../prime-agent log --reverse --format='%H %cI %s' "$baseline..origin/main"
git -C ../prime-agent diff --stat "$baseline..origin/main"
git -C ../prime-agent diff "$baseline..origin/main" -- packages/coding-agent/CHANGELOG.md packages/coding-agent/docs packages/coding-agent/src/core prime-agent-runtime/src/rlm
```

如果上游 checkout 存在与审阅范围重叠的本地修改，应停止同步。不要把基线指向尚未审阅的动态 ref；先把 `origin/main` 解析为精确 commit。

每个有意义的上游变化都要在下面的决策日志增加一行，并使用四种结论之一：

- **采用（Adopt）**：DSH 中应有等价行为。
- **适配（Adapt）**：用 DSH 原生机制保持相同不变量。
- **暂缓（Defer）**：有价值，但依赖后续明确里程碑。
- **拒绝（Reject）**：属于上游实现细节，或与 DSH 的所有权/安全边界冲突。

改代码前先确认行为在 DSH 中由谁拥有。若 Agent、Jobs、Subagent、Goal、Session、Code Runtime 或 Compaction 已拥有该行为，只有确实缺少适配或 prompt 契约时才修改本插件。

## 必须完成的验证

每次同步后：

1. 心智模型变化时更新 `docs/prime-agent-learnings.md`。
2. 公共行为变化时更新 `docs/architecture.md`、README 与工具 policy。
3. 审阅随包 Prime preset（`agent-presets/prime/`）与上游 shipped `code` preset 的差异，移植仍然成立的模型面变化；Prime preset 是独立的 agent-plane 组合，不是 shipped preset 的整份快照。
4. 每个采用或适配的契约都增加回归测试。
5. 运行 `npm run check`。
6. 运行覆盖 repl、Subagent 与 Jobs 的真实 DSH 组合测试。
7. 审阅配额、权限、取消、耐久性、重放可见性和失败行为。
8. 审阅最终 diff，排除对 Prime 实现细节的意外耦合。
9. 把 `upstream-baseline.json` 更新到精确已审阅 commit 与日期。

## 决策日志

| 已审阅基线 | 上游变化 | 判断 | 适配结果 |
| --- | --- | --- | --- |
| `7787f074` | admission-first `rlm()`、子 Agent 显式汇报、可恢复 child handle | 适配 | continuable Subagent 返回持久 child id；DSH Session 负责恢复，child 通过 report 汇报 |
| `7787f074` | 持久 IPython 是模型唯一可见控制面 | 适配 | `repl` 是唯一界面；Agent scope 用可信 `exec.agent.id` 解析 Realm identity，host `primeRealmRuntime` 服务把 Prime Session 准入 Persistent TypeScript Realm，普通 Session 保持官方 one-shot Runtime |
| `7787f074` | local/global Continual Harness 与 refine/rollback | 适配 | `refine` 降为次级，基于证据、乐观并发、有界且冲突安全 |
| `7787f074` | Host 拥有 Agent 生命周期、消息、Goal 和取消 | 采用 | 插件组合 DSH 服务，不创建 Worker registry 或第二套 Agent Loop |
| `7787f074` | 默认开启自动 refinement | 暂缓 | 在自动模型写入前先设计明确 proposal/review/outcome 机制 |
| `aacf04b4` | 长任务使用非阻塞控制循环、独立 worker 并行、root 主动汇报进度 | 适配 | policy 要求用 continuable child 或 Job 保存 id/结果位置，禁止 sleep 轮询和长阻塞 await；仅直接面向用户的 root 获得里程碑进度规则 |
| `aacf04b4` | child 可显式选择并校验 reasoning level | 暂缓 | DSH 0.1.1-rc.2 的 Subagent 调用未公开 per-spawn reasoning 参数；等待 DSH 原生继承、模型校验、持久化与冷恢复契约，不包装第二套工具 |
| `aacf04b4` | IPython 快照按变量限额，并在 compaction 时清理超大 live state | 适配 | TypeScript Realm 不做 heap snapshot 或 compaction GC；大材料走任务文件，projection 使用 12KB best-effort spill 阈值，Realm 只保留紧凑索引/摘要且不隐式删除用户 binding |
| `aacf04b4` | 自动 compaction 后恢复未完成工作与 Goal continuation | 采用 | DSH Compaction/Agent Loop 已拥有继续与 overflow 重试；插件只组合，不注入第二条 continuation |
| `aacf04b4` | daemon-owned family ledger 与 child delete/tombstone | 采用 | DSH Agent/Subagent/Session 继续拥有 family 权威状态；插件不创建 ledger，也不把 interrupt 冒充 delete |
| `aacf04b4` | generic kernel-owned MCP 与 ACP MCP programs | 适配 | profile 可用 DSH Host MCP client 把工具注册进统一 catalog，repl 单元自动获得 `tools.*` 绑定；拒绝 Python/kernel 与 ACP 专用实现 |
| `aacf04b4` | Kernel cold boot、owner-death 与 Windows 清理加固 | 适配 | Realm 复用 Worker generation fencing、父进程监控、quiescent dispose 与跨进程 lease；Jupyter、ZMQ、forkserver 和 named-pipe 细节不移植 |

## 本地破坏性切换记录

以下记录不是上游基线变化，而是本仓库对已交付形态的一次破坏性替换；重新审阅上游时按现状理解，不再回退到旧双轨设计。

- **替换（Replace）**：模型可见入口从 `run_code`（Code Mode SDK）换成唯一 `repl` 工具；`run_code`、Code Mode SDK assembly、hybrid 路由与模型可见 `prime_realm_identity` handshake 一并删除。`repl` 的参数只有 `{ code }`。
- **可信路由（Trusted routing）**：身份不再经过模型或握手；Agent scope 用可信 `exec.agent.id` 解析稳定 Realm identity，host `primeRealmRuntime` 服务按该 id 准入。缺少可信执行上下文时 fail closed。
- **并存（Coexist）**：官方 `code-runtime` row 未改动，非 Prime 会话继续官方 one-shot 语义，无 fallback。
- **升级说明**：旧 `run_code` 调用、旧 Code Mode 组合与旧 live namespace 不迁移；不提供 alias、feature flag 或静默降级，回滚只能整体回退版本。

## 每次都要复查的语义差距

- Prime 的 child answer 可以进入 parent 仍在进行的计算。DSH 0.1.1-rc.2 已原生实现该不变量：官方 `tool-subagent-report` 默认使用 `next-step`，由 continuation manager 调用 `parent.steer()`，让运行中的 parent 在最近 step 消费并唤醒空闲 parent，同时维护唤醒记账以及 report-before-settlement FIFO。本插件直接组合该能力，不再替换 report row 或维护私有 adapter。
- Prime 的 Python heap 能保存活对象和函数；当前适配用可信 `exec.agent.id` 解析的 Realm identity 选择 Persistent TypeScript Realm，在同一 Worker generation 中保留 TypeScript live objects。IPython 只用于参考行为与失败语义，不是产品 backend。
- 当前跨 Agent 上下文使用共享工作区 handoff file。写后不改是 policy 约定，不存在独立 Capsule store、`share`/`mount` 或文件访问授权。
- 手动 `/refine` 会生成有界 edits proposal，并通过现有 revision 检查 store 提交；它不会观察效果或自动触发。
- Prime 可以为单个 child 选择 reasoning level；DSH 0.1.1-rc.2 的 Subagent 调用当前没有对应的 per-spawn 参数。
- Prime compaction 会清理无法纳入有界快照的超大 Python 变量；DSH compaction 不遍历、快照或清理 Realm heap。spill 只在 backend 可用时 best-effort 约束模型 projection 与日志，失败时保留 inline 结果，其 artifact 生命周期由 DSH store/部署层负责。
- Prime 的 MCP program 运行在 Kernel/ACP runtime；DSH 的对应能力属于 Host 工具注册表，只有 profile 显式安装的 MCP client/tools 才会进入 repl 单元的绑定。

这些差距是有意保留的；只有明确产品需求且存在 DSH 原生所有权路径时才应关闭。
