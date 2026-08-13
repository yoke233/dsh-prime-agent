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
| 持久 IPython 控制环境 | v0.2 临时 Code Mode + 持久数据；v0.3 Persistent TypeScript Realm | IPython 只作行为参考；不采用其 runtime 技术栈，也不规划为 backend |
| Python 变量与文件形式的外部上下文 | manifest catalog 与内容寻址 blob | 适配检索、预算和恢复行为 |
| `rlm()` admission handle | DSH Subagent 后台 admission 与 Job id | 用 DSH 生命周期所有权保留 admission-first 语义 |
| `agent_message` 回复与 family roster | DSH completion delivery、`job_output` 和已有 Agent/Subagent 服务 | 持续检查语义差距，不轻易另建消息总线 |
| `rlm.list_subagents()` / `delete_subagent()` | DSH Job/Subagent 观察和取消工具 | 复用已安装工具及其权限检查 |
| Continual Harness | `prime_refine` | 适配证据、scope、并发和回滚规则 |
| Auto-refine 与 refine review | 未来学习闭环 | proposal、审批和效果观察明确前暂缓 |
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
2. 公共行为变化时更新 `docs/v2-architecture.md`、两份 README 与工具 policy。
3. 每个采用或适配的契约都增加回归测试。
4. 运行 `npm run check`。
5. 运行覆盖 Code Mode、Subagent 与 Jobs 的真实 DSH 组合测试。
6. 审阅配额、权限、取消、耐久性、重放可见性和失败行为。
7. 审阅最终 diff，排除对 Prime 实现细节的意外耦合。
8. 把 `upstream-baseline.json` 更新到精确已审阅 commit 与日期。

## 决策日志

| 已审阅基线 | 上游变化 | 判断 | 适配结果 |
| --- | --- | --- | --- |
| `7787f074` | admission-first `rlm()`、子 Agent 显式汇报、可恢复 child handle | 适配 | DSH 后台 Subagent 返回 Job id；父 Agent 继续，稍后通过 `job_output` 回收 |
| `7787f074` | 持久 IPython 是模型唯一可见控制面 | 适配 | Code Mode 仍是唯一界面；v0.3 增加 Session-scoped Persistent TypeScript Realm，可靠数据继续由 `prime_context` 拥有 |
| `7787f074` | local/global Continual Harness 与 refine/rollback | 适配 | `prime_refine` 降为次级，基于证据、乐观并发、有界且冲突安全 |
| `7787f074` | Host 拥有 Agent 生命周期、消息、Goal 和取消 | 采用 | 插件组合 DSH 服务，不创建 Worker registry 或第二套 Agent Loop |
| `7787f074` | 默认开启自动 refinement | 暂缓 | 在自动模型写入前先设计明确 proposal/review/outcome 机制 |

## 每次都要复查的语义差距

- Prime 的 child answer 可以进入 parent 仍在进行的计算。DSH 当前默认用 `followup` 调度 `subagent-report`，因此会排成普通后续轮次。v0.4 应推动 DSH 提供其原生拥有的 steer-first 调度选项——运行中的 parent 走 steer，空闲 parent 被唤醒——而不是修改 DSH 源码或在插件里建立私有 inbox。
- Prime 的 Python heap 能保存活对象和函数；v0.2 只持久化 JSON、文本和 artifact reference。[v0.3 P0](v0.3-roadmap.md) 用 Persistent TypeScript Realm 关闭跨 turn 计算差距。IPython 只用于参考行为与失败语义，不是产品 backend。
- v0.2 尚无不可变 Context Capsule `share`/`mount` 契约，也没有 blob 垃圾回收；这些工作顺延到 v0.4。
- `prime_refine` 目前需要显式调用，不会自动观察效果或生成 proposal。

这些差距是有意保留的；只有明确产品需求且存在 DSH 原生所有权路径时才应关闭。
