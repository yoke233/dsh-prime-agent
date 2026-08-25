# Prime Realm `apply_patch` 本地实现计划

## 1. 目标与边界

在本仓库增加 Prime Realm 隐藏能力 `tools.apply_patch`，用于一次表达多 hunk、多文件的文本创建与更新。Prime 外层模型 catalog 仍只包含 `repl`；`apply_patch` 由现有 Realm SDK 从 Agent catalog 生成 typed binding，不成为第二个模型可见入口。

本计划只修改本仓库。`../deepseek-harness` 是只读 checkout，只可用于 diff、preset 审阅和事实核对；实现不要求修改、提交或发布 DSH。文件访问必须组合已安装 DSH 的公开工具执行 seam，继续由 DSH 持有 workspace 解析、sandbox、approval、observation、日志、取消和 Session 所有权。

第一版范围：

- 支持 `*** Add File` 和 `*** Update File`。
- 明确拒绝 `*** Delete File` 和 `*** Move to`，不把删除伪装为空内容写入，也不把移动拆成无保护的读写组合。
- 严格上下文匹配，不做 fuzzy、空白归一化或近似定位。
- 所有 parse、路径、快照和 plan 校验在首次 mutation 前完成；这些阶段失败时零文件副作用。
- mutation 阶段只调用正式 DSH `write` 工具。公开 seam 当前没有多文件事务，因此不承诺多文件 crash-atomic 或失败回滚；后续 write 失败必须以失败结束，不能返回部分成功的 canonical success。

明确不做：

- 不使用 `node:fs` 直接读写任务文件。
- 不使用 shell、`git apply` 或 Codex binary。
- 不复制或模拟 DSH 的 sandbox、approval、observation state、Agent/Session 身份或工具日志。
- 不增加 alias、`fuzz`、`cwd`、`atomic`、`dry_run`、sandbox escalation 等额外参数。
- 不修改现有 `tools.edit`；单点字面量替换仍可继续使用它。

## 2. 对外契约

### 2.1 工具接口

公开工具名固定为 `apply_patch`，参数仅有：

```ts
{
  patch: string
}
```

Realm 调用形式：

```ts
await tools.apply_patch({
  patch: "*** Begin Patch\n...\n*** End Patch",
})
```

成功 canonical value 固定为：

```ts
{
  applied: true,
  files: Array<{
    path: string,
    operation: "add" | "update",
    hunks: number,
  }>,
}
```

`files` 按 patch 中的文件顺序返回，只在所有 planned writes 成功后产生。失败使用结构化 `PatchError` 信息进入 DSH 的正常 tool failure 路径，不回传 patch 全文或文件全文。

### 2.2 Parser 与 planner

共享类型位于 `src/apply-patch/types.ts`。纯函数接口固定为：

```ts
parsePatch(patch: string): ParsedPatch

planPatch(
  parsed: ParsedPatch,
  snapshots: ReadonlyMap<string, string | null>,
): PatchPlan
```

`null` snapshot 表示目标已通过正式 DSH `read` 路径确认不存在。`ParsedPatch`、`PatchPlan`、planned file、hunk、`PatchError` 和稳定错误码均由 `types.ts` 统一定义；parser、planner 和 executor 不各自创造第二套错误形状。

## 3. Patch grammar

参考 Codex `*** Begin Patch` grammar 的模型熟悉形式，但第一版只实现经过测试锁定的安全子集：

```text
*** Begin Patch
*** Update File: src/example.ts
@@
 const before = true
-oldCall()
+newCall()
*** Add File: src/new.ts
+export const created = true
*** End Patch
```

规则：

1. patch 必须恰好有一个 `*** Begin Patch` 与一个终止的 `*** End Patch`，marker 外不允许非空内容。
2. 文件 section 只能是 `*** Add File: <path>` 或 `*** Update File: <path>`。
3. `*** Delete File` 和 Update section 中的 `*** Move to` 必须返回明确的 unsupported-operation 错误；未知 header 也必须失败。
4. Add body 的每一行以 `+` 开头，去掉前缀后组成新文件内容；Add 计为一个 hunk。
5. Update 至少含一个以 `@@` 开始的 hunk。hunk 行只接受空格上下文、`-` 删除和 `+` 新增前缀；每个 hunk 必须包含实际变化，并具有可严格定位的 old sequence。
6. planner 在当前虚拟文件内容中按顺序应用 hunk。上下文与删除行逐字匹配；零匹配或多匹配都失败，后续 hunk 不得回到前一 hunk 之前。
7. Add 要求 snapshot 为 `null`；Update 要求 snapshot 为字符串。Update 计算结果与原文相同必须失败。
8. parser 保留 patch 行号，planner 错误同时尽可能带 `path` 与 1-based `hunk`，便于调用方定位。

Parser 与 planner 都是纯计算，不访问 Cordis、DSH catalog、磁盘、环境变量或 Session。

## 4. 路径不变量

Patch 路径是 owning Session workspace 下的词法相对路径。进入任何 DSH read 前统一校验：

- 拒绝空路径、NUL、POSIX 绝对路径、Windows drive 路径和 UNC 路径。
- 将 `\\` 视为路径分隔符参与安全检查；拒绝任何 `..` segment。
- 拒绝解析后为空或只表示当前目录的路径。
- 同一路径在一个 patch 中只能出现一次；按统一分隔符后的词法 key 检测重复，不能用 `a/b` 与 `a\\b` 绕过。
- 不在本地转换为绝对路径，不自行跟随 symlink；validated relative path 原样交给 DSH `read` / `write`，由正式 DSH seam 完成 workspace、sandbox 与 observation 检查。

任何路径无效或重复都属于 parse/plan gate failure，首次 mutation 前终止。

## 5. 本仓库模块划分

### 5.1 纯核心

- `src/apply-patch/types.ts`：共享 AST、plan、success value 与结构化错误。
- `src/apply-patch/parser.ts`：解析 envelope、section、hunk 与行前缀，验证操作和路径，导出 `parsePatch`。
- `src/apply-patch/planner.ts`：把 `ParsedPatch` 与快照编译为每个文件的最终文本，导出 `planPatch`。

纯核心不依赖 DSH runtime，测试可直接传字符串和 `ReadonlyMap`。

### 5.2 DSH 执行适配

- `src/apply-patch/executor.ts`：通过公开 `ctx.tools.execute(...)` 调用 catalog 中的 `read` / `write`，构造 snapshots，执行完整 gate，再提交 planned writes。
- `src/apply-patch/plugin.ts`：用 `defineTool` 注册名称、单字段 schema、输出 schema 和 executor。
- `src/index.ts`：在 Agent scope 安装本地 plugin；保留现有外层 catalog filter 与 guard。
- `src/policy.ts`：只增加必要的使用指引，说明复杂文本 patch 使用隐藏 `tools.apply_patch`，仍需 grounded context。

内部 DSH 调用必须保持原工具执行身份：

- `agent`、`rootCallId`、`signal` 沿用当前 `apply_patch` execution。
- `parent` 指向当前 execution token，使调用仍处于同一授权与日志调用树。
- 每次内部 read/write 使用唯一派生 `callId`。
- 通过 `ctx.tools.get` / `ctx.tools.execute` 使用 catalog 中的正式工具；缺少 `read` 或 `write` 时 fail closed。
- 只解析正式 read 工具的 canonical result；不存在以外的 read failure、未知结果形状或权限错误不得误判为 missing。

## 6. 无副作用 gate 与提交顺序

Executor 顺序固定为：

1. `parsePatch(input.patch)`；失败时没有 DSH read/write。
2. 确认当前 Agent catalog 同时提供正式 `read` 和 `write`。
3. 按文件顺序读取全部目标，得到完整 `ReadonlyMap<string, string | null>`；任一非 missing read failure 时终止。
4. 调用 `planPatch(parsed, snapshots)`；任一 existence、上下文、重复或 no-op 错误时终止。
5. 只有完整 `PatchPlan` 已形成后，才按 plan 顺序调用正式 DSH `write`，内容是 planner 计算出的完整最终文本。
6. 所有 writes 成功后返回 canonical success。

关键 gate：步骤 1–4 不得调用 `write`。即使第一个文件的 plan 已可用，也必须等全部目标读取并规划成功后再 mutation。

公开 DSH seam 当前只能逐文件 write。若第 N 次 write 失败：

- 工具整体失败，不返回 `{ applied: true }`。
- 保留 DSH 原始失败因果与调用日志。
- 不用直接磁盘访问尝试私有 rollback，也不声称先前 writes 未发生。
- 该限制写入测试与验收；Delete/Move 继续拒绝，直到 DSH 公开了能保护相应语义的 seam。

## 7. 测试计划

### 7.1 `tests/apply-patch.spec.ts`

Parser 覆盖：

- 单文件与多文件 Add/Update、多 hunk、空行、Unicode、反引号、`${...}` 和 Markdown fence。
- marker 缺失/重复、marker 外内容、空 patch、未知 header、非法 hunk 前缀和准确 patch 行号。
- Delete 与 Move 返回明确 unsupported-operation 错误。
- 空路径、绝对路径、drive/UNC、NUL、`..`、混合分隔符重复路径。

Planner 覆盖：

- Add 只接受 missing snapshot，Update 只接受 existing snapshot。
- 严格单次上下文匹配、零匹配、多匹配、乱序 hunk 和 no-op 拒绝。
- 多 hunk 顺序应用，输出最终文本、operation 与 hunk count。
- 一个文件失败时不返回部分 plan，输入 snapshots 不被修改。
- LF/CRLF 与末尾换行行为由固定样例锁定，防止无关整文件 diff。

### 7.2 `tests/apply-patch-integration.spec.ts`

使用真实 DSH tools runtime 与受控 read/write tool doubles 验证公开执行 seam，而不是调用 Node 文件 API 实施 patch：

- schema 名称为 `apply_patch`，参数只有 required `patch: string`。
- parse/path failure 不触发 read 或 write。
- 所有 read 完成后才发生第一次 write；plan failure 的 write 次数为零。
- Add、Update、多文件成功返回精确 canonical success 与 hunk count。
- read permission/unknown-shape failure fail closed，不能当作 Add missing。
- 内部调用保留 agent、rootCallId、parent、signal，并使用唯一 callId。
- 第二次 write 失败时整体失败且不产生虚假 success/rollback 声明。
- plugin 安装后 Realm SDK 可生成 `tools.apply_patch` binding；外层模型 schema 仍只有 `repl`，直接模型调用 `apply_patch` 仍由 guard 拒绝。

## 8. 实施顺序

1. 先实现 `types.ts`、`parser.ts`、`planner.ts` 与纯单元测试，锁定 grammar、路径和严格匹配契约。
2. 实现 `executor.ts` 的 read-all → plan-all → write gate，并用 integration tests 证明首次 mutation 边界。
3. 注册 `plugin.ts`，接入 `src/index.ts`，更新 `src/policy.ts` 的隐藏 binding 指引。
4. 更新 `docs/architecture.md` 与 README 的当前行为说明，构建并提交对应 `lib/` 产物。
5. 运行本仓库的 focused tests、`npm run check` 和真实 Prime 组合验证；不执行任何 DSH 发布步骤。

## 9. 验收标准

功能：

- `parsePatch`、`planPatch` 与共享类型按第 2 节接口导出。
- 一个调用可以 Add/Update 多个仓库相对路径，并返回固定 success shape。
- 任一 parse、路径、read 或 plan failure 发生在首次 mutation 前，所有目标保持未写入。
- 上下文只接受严格唯一匹配；不 fuzzy，不容忍路径逃逸或重复目标。
- Delete/Move 使用稳定、可定位的 unsupported-operation failure。
- 所有文件 mutation 都能在 DSH 工具调用树中观察到正式 `write`；实现没有直接文件 I/O、shell 或外部 patch binary。

Prime：

- 外层模型 catalog 仍只有 `repl`。
- Realm SDK 中存在参数仅 `{ patch: string }` 的 `tools.apply_patch` typed binding。
- 成功值只含 `applied` 与有界 `files` 摘要；任一 write 失败不会伪装成 success。
- 现有 `tools.edit`、非 Prime one-shot runtime、可信 `exec.agent.id` 身份路由和 binding lease 不变量不变。

仓库边界：

- 所有实现、测试、文档和构建产物均在本仓库。
- `../deepseek-harness` 始终只是只读 checkout；验收不依赖其工作树修改、提交或新版本发布。
