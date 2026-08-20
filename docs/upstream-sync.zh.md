# Prime Agent 上游同步与差异对照手册

[English](upstream-sync.md)

本手册用于让 `dsh-prime-agent` 持续跟进 Prime Agent 的设计，同时避免把适配层变成源码 fork。机器可读基线记录在 [upstream-baseline.json](upstream-baseline.json)。

## 基线规则

当前已审阅的 Prime Agent 基线是：

```text
7787f07415d843b9a800f6a4720e0c739bd608e5
2026-08-12T21:01:27-07:00
fix(coding-agent): retain root kill cleanup ownership (#1240)
```

只有完整审阅旧基线到新基线的全部变化、记录设计判断、通过适配层验证并完成 review 后，才能推进这个标记。即使结论是“不改适配层”，也要推进基线，否则下次会重复审阅同一批提交。

## 同步什么

同步行为契约与架构，不同步实现语言和文件形状。

| Prime Agent 概念 | DSH 适配层对应物 | 同步策略 |
| --- | --- | --- |
| 持久 IPython 控制环境 | Code Mode + Persistent TypeScript Realm | IPython 只作行为参考；不采用其 runtime 技术栈，也不规划为 backend |
| Python 变量与文件形式的外部上下文 | Realm live namespace + 工作区 handoff/result files | 适配检索、预算、快照交接和恢复行为 |
| `rlm()` admission handle | DSH continuable Subagent id | 用 DSH inbox admission 与 Session persistence 保留 admission-first 语义 |
| `agent_message` 回复与 family roster | `report`、`send_message`、`list_agents` 与 DSH Agent/Subagent 服务 | 复用 DSH 直接父子授权和消息队列，不另建消息总线 |
| `rlm.list_subagents()` / `delete_subagent()` | `list_agents` / 当前无 delete | 复用现有目录与权限检查，不把 interrupt 冒充 delete |
| Continual Harness | `prime_refine` | 适配证据、scope、并发和回滚规则 |
| Auto-refine 与 refine review | 当前未适配 | 必须先重新审阅上游真实契约，不能从本地路线名称反推实现 |
| Goal、compaction、heartbeat、daemon 生命周期 | DSH Goal、Compaction、Jobs、Schedule、Session | 组合，不重复实现 |
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
3. 将随包 Prime preset（`agent-presets/prime/`，交付后）与上游 shipped `code` preset 逐行对照并移植变化；DSH 没有 preset inheritance，这份副本必须整份维护。
4. 每个采用或适配的契约都增加回归测试。
5. 运行 `npm run check`。
6. 运行覆盖 Code Mode、Subagent 与 Jobs 的真实 DSH 组合测试。
7. 审阅配额、权限、取消、耐久性、重放可见性和失败行为。
8. 审阅最终 diff，排除对 Prime 实现细节的意外耦合。
9. 把 `upstream-baseline.json` 更新到精确已审阅 commit 与日期。

## 决策日志

| 已审阅基线 | 上游变化 | 判断 | 适配结果 |
| --- | --- | --- | --- |
| `7787f074` | admission-first `rlm()`、子 Agent 显式汇报、可恢复 child handle | 适配 | continuable Subagent 返回持久 child id；DSH Session 负责恢复，child 通过 report 汇报 |
| `7787f074` | 持久 IPython 是模型唯一可见控制面 | 适配 | Code Mode 是唯一界面；认证的 `prime_realm_identity` handshake 把 Prime Session 路由到 Persistent TypeScript Realm，普通 Session 保持官方 one-shot Runtime |
| `7787f074` | local/global Continual Harness 与 refine/rollback | 适配 | `prime_refine` 降为次级，基于证据、乐观并发、有界且冲突安全 |
| `7787f074` | Host 拥有 Agent 生命周期、消息、Goal 和取消 | 采用 | 插件组合 DSH 服务，不创建 Worker registry 或第二套 Agent Loop |
| `7787f074` | 默认开启自动 refinement | 暂缓 | 在自动模型写入前先设计明确 proposal/review/outcome 机制 |

## 每次都要复查的语义差距

- Prime 的 child answer 可以进入 parent 仍在进行的计算。DSH rc.8 已原生实现该不变量：官方 `tool-subagent-report` 默认使用 `next-step`，由 continuation manager 调用 `parent.steer()`，让运行中的 parent 在最近 step 消费并唤醒空闲 parent，同时维护唤醒记账以及 report-before-settlement FIFO。本插件直接组合该能力，不再替换 report row 或维护私有 adapter。
- Prime 的 Python heap 能保存活对象和函数；当前适配由认证 binding handshake 选择 Persistent TypeScript Realm，在同一 Worker generation 中保留 TypeScript live objects。IPython 只用于参考行为与失败语义，不是产品 backend。
- 当前跨 Agent 上下文使用共享工作区 handoff file。写后不改是 policy 约定，不存在独立 Capsule store、`share`/`mount` 或文件访问授权。
- `prime_refine` 目前需要显式调用，不会自动观察效果或生成 proposal。

这些差距是有意保留的；只有明确产品需求且存在 DSH 原生所有权路径时才应关闭。
