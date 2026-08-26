# AGENTS.md

## 项目目标

本仓库为 DeepSeek Harness 提供 RLM-first 控制面：Prime Session 通过唯一模型可见的 `repl` 使用持久 TypeScript Realm，非 Prime Session 保持 DSH 官方 one-shot 语义。Realm 身份由可信执行上下文中的 `exec.agent.id` 解析；缺少 owning Agent/Session 时必须 fail closed。

## 仓库边界

- `src/index.ts` 是 Agent-scope 入口；`src/runtime.ts` 是 Host-scope runtime 入口。Realm 实现位于 `src/realm/`，受限的 continual-learning 状态位于 `src/continual/`。
- `lib/` 是由 TypeScript 构建生成且随包发布的受版本控制产物。修改 `src/` 后运行构建并提交对应 `lib/` 变化；不要手工编辑 `lib/`。
- `cordis.patch.yml` 纯插入 Host runtime row，`agent-presets/prime/agent.cordis.yml` 提供 Prime Agent scope。两处 `stateDirectory` 表达式必须保持一致，否则 Prime 身份解析会全部失败。
- `agent-presets/prime/agent.cordis.yml` 是 DSH shipped `code` preset 的独立完整快照，不存在 preset inheritance，并保留 `docs/upstream-sync.zh.md` 记录的 Prime 差异。修改 Prime preset 或同步上游基线时，必须审阅 shipped preset 的逐行差异并运行组合与打包边界测试。
- 同级 `../deepseek-harness` checkout 只用于只读 diff、preset 审阅和事实核对，任何任务不得修改。新能力必须在本仓库通过 DSH 公开 seam 组合；不得旁路或复制 DSH 的安全策略、权限检查、Session 身份与生命周期所有权。
- `scripts/eval/prime-headless-shim/` 仅用于当前 headless 评测缺口，不是通用 runtime；修改前先阅读其 `README.md`。

## 上游 Prime Agent 参考

- Prime Agent 上游仓库为 `https://github.com/PrimeIntellect-ai/prime-agent.git`，本机只读参考 checkout 为 `../prime-agent`；精确审阅基线以 `docs/upstream-baseline.json` 为准。不得在本仓库任务中修改该 checkout，也不得把上游源码 alias 进本项目的类型检查或测试。
- 所谓“上游 Python 版”并非所有逻辑都在 Python：模型的 IPython 控制面提示位于 `../prime-agent/packages/coding-agent/src/core/prompts/rlm.ts`，continual harness 的组装、refinement planner、自动 review gate 与状态应用位于 `../prime-agent/packages/coding-agent/src/core/refinement/refinement.ts`，自动调度与 turn/compaction checkpoint 位于 `../prime-agent/packages/coding-agent/src/core/agent-session.ts`，默认开关、turn interval、compaction trigger 和 cooldown 位于 `../prime-agent/packages/coding-agent/src/core/settings-manager.ts`。
- Agent 主动学习入口是 `../prime-agent/packages/coding-agent/skills/refine/SKILL.md`；真正的 Python shim 位于 `../prime-agent/packages/coding-agent/skills/refine/src/refine/__init__.py`，通过 `rlm.host_request("refine.status")` 与 `rlm.host_request("refine.run", ...)` 调用 Host。它只负责安排 refinement，不直接在 Python 中实现 store 或 planner。
- 上游提醒模型学习有三层：system prompt 说明 continual harness 的可用性；动态 harness overview 明确提示在重复失败、可复用策略、用户纠正或条目错误时调用 `await refine.run()`，并要求修改小而有证据；Host auto-refine 在 turn interval 或 compaction checkpoint 运行独立 review gate。关闭 auto-refine 只关闭第三层，不会自动移除 agent-callable `refine.run()` 或相应提示。
- 本项目的安全等价适配不能动态导入 Skill 模块：Prime Realm 刻意不配置通用 dynamic-import callback。随包 `skills/refine/SKILL.md` 因此说明 Realm 预加载的 leased `refine.status()/run()` 客户端；该客户端走私有 Host binding，不得注册为 DSH tool、出现在 `tools.*`/生成 SDK 或制造 `tool/code-dispatch` 记录。
- 修改本项目 refine 设计前必须核对上述真实路径和当前基线，不得把 `/refine`、agent-callable refine 与 auto-refine 混为一条路径：人类 command、模型主动安排和 Host 自动检查是三个独立入口。

## 环境与命令

本项目是 npm 管理的 Node.js ESM/TypeScript 单包，锁文件为 `package-lock.json`。类型检查和测试只解析 npm 安装包，不得 alias 到同级 DSH 源码。

```powershell
npm ci
npm run typecheck
npm run build
npm test
npm run check
npm run test:integration
npm run check:all
npm run test:model
```

`npm test` 与 `npm run check` 运行快速单元测试；`npm run check`（typecheck + build + unit）是代码变更的默认最终验证。迭代和局部测试清理优先运行覆盖变更的 focused test；需要 Realm/Worker、组合服务或多进程行为时，运行对应 integration 文件，例如 `npx vitest run --config vitest.integration.config.ts tests/<name>.spec.ts`。`npm run test:integration` 运行完整 integration suite；`npm run check:all`（typecheck + unit + integration）只用于发布、跨多个 integration 领域的广泛变更或用户明确要求。`npm run test:model` 设置 `DSH_RUN_MODEL_E2E=1`，且还需要 `DEEPSEEK_API_KEY`。

## 模型可见文案

### 操作事实

模型可见文案从执行任务的视角写，不从本项目实现者的视角解释系统。每句话都应帮助模型决定下一步：调用什么、参数怎么写、结果怎么用，或失败后怎么恢复。若理解一句话需要先知道本仓库的架构、模块名称、内部生命周期或兼容来源，把它移到 `README.md` 或 `docs/`。

这不是禁词穷举。用“不了解本项目源码的模型能否直接照做”判断文案是否自然；优先使用模型实际可见的工具名、字段名、返回值和错误动作。

### 归位

- 所有能力共享的调用方式只在入口说明一次。
- 某个工具独有的约束放在该工具或参数的 description 旁。
- 只在运行时成立的状态和恢复动作由当次结果或错误说明。
- declaration 已表达的参数与返回类型不再用 prose 重复。
- 仓库设计、实现理由、安全证明和上游差异只写开发文档。

### 写作与审阅

1. 先确定文案实际进入哪个模型可见 surface：system prompt、policy、动态 context、Skill、工具/参数 description 或生成声明注释。
2. 写最短的正向操作说明；使用该 surface 中已经出现的概念，不另造层级或角色名称。
3. 通过真实 prompt dump 审阅最终组装结果，而不是只读源码常量。
4. 把 dump 分成项目固定文案、动态上下文、仓库 Agent 指令、工具 catalog 和第三方贡献；只在正确来源修复问题。
5. 以不了解实现的模型视角逐句阅读；删除重复内容，把内部解释迁回开发文档。

完成标准：项目生成的每段模型可见文案都能在没有架构背景的情况下直接执行；同一规则只有一个权威位置；验证覆盖结构化行为，不用精确文本、substring 或 snapshot 单测固化自然语言。

## 变更规则

- 修改 Realm 路由、身份、lease、Worker 生命周期、预算、取消或错误语义时，按 `docs/architecture.md` 保持 Session 隔离、同 Realm 串行、binding lease 按 run 撤销、hard-kill 后显式 namespace-loss notice 等现有不变量。
- 修改公开行为、配置或模型 policy 时，同步更新 `README.md`、`docs/architecture.md` 和 `src/policy.ts` 中受影响的说明，并增加验证可观察行为的回归测试。
- 修改 `refine` 时，保持默认 local、显式 inspect/apply/rollback、revision 检查、有界历史和冲突安全回滚；不得把任务材料、运行状态或大上下文写入 continual state。
- 修改 Prime Agent 上游基线时，完整执行 `docs/upstream-sync.zh.md`；只有审阅完精确 commit 并记录 Adopt/Adapt/Defer/Reject 结论后，才能更新 `docs/upstream-baseline.json`。
- Runtime 状态属于 `DSH_HOME`，不得写入源码仓库。不要提交凭据、本机绝对路径、临时评测 profile 或 `prime-agent-v2/` 状态。
- 版本递增不自动创建或推送 tag；只有用户明确要求发布时才处理 tag。

## 验证与完成标准

- 纯文档修改核对文档中的路径、命令和跨文件契约；局部测试清理运行对应 focused test；一般代码或配置修改运行 `npm run check`，并按受影响行为补充 focused integration test。只有发布、同时影响多个 integration 领域的广泛变更或用户明确要求时运行 `npm run check:all`。
- preset、bundle patch 或打包边界变化时，重点覆盖 `tests/packaging-boundary.spec.ts`、`tests/preset-install.spec.ts`、`tests/loader-composition.spec.ts`、`tests/prime-preset-mount.e2e.spec.ts` 和真实 Prime 组合测试。
- 最终检查 `git diff`：`src/` 与 `lib/` 同步，文档与当前行为一致，没有意外修改用户文件或生成无关产物；报告任何未通过的验证，并区分本次变更导致的问题与既有失败。
