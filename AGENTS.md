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

## 变更规则

- 修改 Realm 路由、身份、lease、Worker 生命周期、预算、取消或错误语义时，按 `docs/architecture.md` 保持 Session 隔离、同 Realm 串行、binding lease 按 run 撤销、hard-kill 后显式 namespace-loss notice 等现有不变量。
- 修改公开行为、配置或模型 policy 时，同步更新 `README.md`、`docs/architecture.md` 和 `src/policy.ts` 中受影响的说明，并增加验证可观察行为的回归测试。
- 模型可见文案（system prompt、policy、工具/参数 description、生成 SDK 注释）只写完成任务所需的操作事实。模块、接口、seam、adapter、control-plane、canonical、presentation、preflight、transactional、上游实现名和兼容来源等软件设计或内部实现语言只写在开发文档，不得泄露到模型提示词。
- 不为自然语言提示词添加精确文本、substring、关键词存在性或 snapshot 单测；这类测试会固化措辞而不验证行为。测试应覆盖可观察行为、工具 schema 和结构化接口；生成的 TypeScript declaration 可按类型契约做结构断言。
- 修改 `refine` 时，保持默认 local、显式 inspect/apply/rollback、revision 检查、有界历史和冲突安全回滚；不得把任务材料、运行状态或大上下文写入 continual state。
- 修改 Prime Agent 上游基线时，完整执行 `docs/upstream-sync.zh.md`；只有审阅完精确 commit 并记录 Adopt/Adapt/Defer/Reject 结论后，才能更新 `docs/upstream-baseline.json`。
- Runtime 状态属于 `DSH_HOME`，不得写入源码仓库。不要提交凭据、本机绝对路径、临时评测 profile 或 `prime-agent-v2/` 状态。
- 版本递增不自动创建或推送 tag；只有用户明确要求发布时才处理 tag。

## 验证与完成标准

- 纯文档修改核对文档中的路径、命令和跨文件契约；局部测试清理运行对应 focused test；一般代码或配置修改运行 `npm run check`，并按受影响行为补充 focused integration test。只有发布、同时影响多个 integration 领域的广泛变更或用户明确要求时运行 `npm run check:all`。
- preset、bundle patch 或打包边界变化时，重点覆盖 `tests/packaging-boundary.spec.ts`、`tests/preset-install.spec.ts`、`tests/loader-composition.spec.ts`、`tests/prime-preset-mount.e2e.spec.ts` 和真实 Prime 组合测试。
- 最终检查 `git diff`：`src/` 与 `lib/` 同步，文档与当前行为一致，没有意外修改用户文件或生成无关产物；报告任何未通过的验证，并区分本次变更导致的问题与既有失败。
