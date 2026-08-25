# Prime REPL Notebook 呈现与结果复用设计

> 状态：已实施并通过源码、真实 TUI 与真实模型验收  
> 上游参考：PrimeIntellect-ai/prime-agent `aacf04b4678fd02cf46b69ab0bdcbc5d29baab45`  
> 目标仓库：`dsh-prime-agent`

## 1. 决策摘要

Prime REPL 采用三层契约：

1. **执行层**：Host 工具与 Realm 之间继续传递 lossless JSON canonical value；这是机器协议，不进入模型教学。
2. **保留层**：cell completion 的真实对象继续留在当前 Worker generation，通过命名变量、`$_` 和低频历史接口 `$out(id)` 复用。
3. **呈现层**：模型只看到 notebook 风格文本；不再看到 `{ logs, result }` 的传输外壳，也不再看到以 `"$out": 17` 为中心的 completion envelope。

核心原则：**JSON 留在传输层；模型面对自然的 notebook 接口。**

本设计不取消 JSON，不扩大 Worker 权限，不引入 IPython/Jupyter，不改变 DSH 工具 canonical output，也不让 renderer 文本成为可重新解析的数据契约。

## 2. 问题与证据

### 2.1 最近真实会话中的两类 REPL 编程错误

目标会话在大型 completion 返回后收到：

```json
{
  "$out": 3,
  "use": "$out(3)",
  "retained": true,
  "type": "object",
  "truncated": true
}
```

模型随后写出：

```ts
$out.spec.path
```

并得到：

```text
TypeError: Cannot read properties of undefined (reading 'path')
```

正确代码应为：

```ts
const previous = $out(3)
previous.spec.path
```

`"$out": 3` 在视觉上把 `$out` 表现成数据字段。虽然同一 envelope 已提供 `use: "$out(3)"`，模型仍把 `$out` 当成结果对象。这是模型可见接口的诱导错误，不只是提示词缺失。

同一会话还出现：

```text
TypeError: filepaths.slice is not a function
```

模型猜测 `tools.glob(...)` 直接返回数组，实际 canonical output 是带 `paths` 字段的对象。正确代码为：

```ts
const filepaths = await tools.glob(args)
filepaths.paths.slice(0, 5)
```

生成的 SDK 已携带 output schema，但 Realm 执行 erasable TypeScript，不做编译期类型检查；当模型忽略声明并依据其他 harness 的先验猜测形状时，只会在运行期得到普通 `TypeError`。

### 2.2 当前模型可见接口暴露了传输细节

`src/index.ts` 当前把成功结果组织为：

```ts
{
  logs: string[]
  result?: JsonValue
}
```

并通过：

```ts
JSON.stringify(value)
```

生成模型可见文本。一个实际值在不同层中的表示为：

| 层 | 表示 |
| --- | --- |
| Realm 内实际字符串 | `D:\yjky\yj-app-backend` |
| 外层 JSON renderer | `"D:\\yjky\\yj-app-backend"` |
| Session JSONL 中的 renderer 文本 | `\"D:\\\\yjky\\\\yj-app-backend\"` |

反斜杠没有在实际字符串中增殖，但模型和操作者看到的是多层编码后的表示。模型还必须区分：

- Host tool canonical value；
- Realm completion；
- completion projection envelope；
- 外层 `repl` canonical result；
- outer renderer 文本；
- Session JSONL 对该文本的再次编码。

这些概念对 runtime 实现有用，对完成任务的模型没有直接价值。

### 2.3 当前提示词没有定义 completion intrinsics

当前 SDK 说明了 persistent cell 和 final expression，但没有完整声明：

```ts
$_
$out(id)
$out.list()
$out.drop(id)
$out.clear()
```

当前 policy 也没有解释：

- `$out` 是函数，不是结果对象；
- `$_` 是最近 completion；
- projection 只是预览，不是原值；
- Host tool 返回的是已经反序列化的 JavaScript value，不是 JSON 字符串。

runtime 已实现能力，模型接口没有正式教授能力，导致正确行为依赖 envelope 字段名和模型先验。

## 3. 上游 IPython 依据

本节的 IPython 上游是 `../prime-agent`，不是 DeepSeek Harness 当前 shipped Code Runtime。冻结基线 `aacf04b4678fd02cf46b69ab0bdcbc5d29baab45` 与本设计核查的相关文件无差异。

### 3.1 原生 completion history

Prime IPython 使用 IPython 自带的：

```python
_
_2
Out[2]
```

保存 cell completion。展示被截断不删除 kernel 中的原对象，模型可以继续对 `_` 或命名变量计算，不需要理解 host handle envelope。

对应位置：

- `../prime-agent/packages/coding-agent/src/core/kernel/index.ts`
- `../prime-agent/packages/coding-agent/src/core/kernel/state-snapshot.ts`

### 3.2 notebook 文本呈现

上游从 Jupyter IOPub 收集 stdout、stderr 和最后一个 `execute_result` 的 `text/plain`，随后直接拼接模型文本，不把它们包装成外层 JSON 对象。

对应位置：

- `../prime-agent/packages/coding-agent/src/core/kernel/index.ts:1252-1326`
- `../prime-agent/packages/coding-agent/src/core/tools/ipython.ts:713-741`

上游的可移植经验是：

1. 真实对象留在 notebook namespace；
2. 展示只是投影；
3. 最近结果有自然入口；
4. 模型不承担传输协议的反序列化心智成本。

不移植 Python 语法、Jupyter/ZMQ、dill/pickle、Python `repr` canonicalization 或无界 `Out` cache。

## 4. 设计原则

1. **协议与呈现分离**：lossless JSON 是 Host/Worker 协议，不是模型接口。
2. **常用路径最短**：最近结果通过 `$_` 使用，不要求模型复制 handle。
3. **历史入口降频**：`$out(id)` 只服务非最近结果、显式历史检查和恢复诊断。
4. **展示不可解析**：renderer 文本只帮助模型观察；后续计算必须使用 Realm 中的真实值。
5. **canonical value 不变**：`tools.*` 返回 DSH 工具原始 canonical JSON value，不增加 Prime 专用包装。
6. **不猜来源**：runtime-authored projection 必须由经过 nonce 验证的 metadata 标识，不能仅按用户值形状判断。
7. **小结果低开销**：普通 completion 不增加固定 metadata envelope。
8. **失败明确**：未保留、已淘汰、generation loss 和普通程序异常保持不同诊断。
9. **提示词短且可执行**：说明下一行代码怎么写，不解释内部 ledger、nonce 或 wire framing。
10. **用真实模型评测闭环**：字符串断言不能证明模型学会使用接口。

## 5. 目标数据模型

### 5.1 内部执行结果

Host 内部保留结构化 canonical value，但增加经过 runtime 验证的呈现 metadata：

```ts
interface ReplExecutionResult {
  logs: string[]
  result?: CodeJsonValue
  presentation?: ReplPresentation
}

type ReplPresentation =
  | { kind: 'full' }
  | {
      kind: 'retained-preview'
      valueType: string
      serializedBytes?: number
      handle: number
    }
  | {
      kind: 'unretained-preview'
      valueType: string
      serializedBytes?: number
      reason: string
    }
  | {
      kind: 'opaque-reference'
      valueType: string
      handle: number
    }
```

`presentation` 是 Host 内部 canonical metadata，不是用户程序 completion，也不作为 JSON envelope 原样展示给模型。

### 5.2 可信来源

Worker terminal message 已用 `projected: nonce` 标记 runtime-authored projection。`PersistentRealm.onDone()` 当前验证 nonce、projection shape 和 metrics 来源，随后丢弃来源信息，只把 envelope 当普通 `value` 向上传递。

实施时应在该验证点把 envelope 解析为 `ReplPresentation`，并把可信 metadata 传给 renderer。不得在 renderer 中仅根据 `value.truncated` 或 `$out` 字段猜测来源，因为用户程序可以合法返回相同形状。

### 5.3 Realm 内复用接口

常用接口：

```ts
$_
```

历史接口：

```ts
$out(17)
$out.list()
$out.drop(17)
$out.clear()
```

模型使用优先级：

1. 已命名变量；
2. 最近 completion：`$_`；
3. 更早 completion：`$out(id)`；
4. generation 已失效或对象未保留：重新计算或从 durable file 恢复。

`$out` 保持函数语义，但不再以 `"$out": number` 字段出现在常规模型输出中。

## 6. Notebook 呈现契约

renderer 返回纯文本内容，不添加 `[repl result: ...]`、`[repl logs]`、```` ```text ```` 或其他类型外壳。字符串与结构化值的区别只决定是否执行一次 JSON pretty-print，不形成模型需要理解的第二套协议。

### 6.1 普通字符串

模型可见文本：

```text
D:\yjky\yj-app-backend
```

不对 scalar string 再执行 JSON quote/escape。

### 6.2 普通结构化值

```text
{
  "paths": [
    "D:\\yjky\\a.go",
    "D:\\yjky\\b.go"
  ]
}
```

结构化值仍使用一次确定性 JSON 表示。这里的 `\\` 是 JSON notation，不是 underlying string 中的两个字符。

### 6.3 日志

```text
reading files...
found 27 matches
```

日志不再呈现为 JSON string array。

### 6.4 已保留的大结果

```text
The complete value remains in this REPL as `$_`.
For older access, use `$out(17)`.
Type: object
Serialized size: 65,722 bytes

Preview:
{
  "overview": "...",
  "spec": {
    "path": "D:/yjky/yj-app-backend/docs/spec/knowledge-base-system.md"
  }
}
```

后续代码：

```ts
const previous = $_
previous.spec.path
```

renderer 必须把 `$_` 放在第一入口，把 `$out(17)` 降为历史补充。不得要求模型解析 preview。

### 6.5 未保留的大结果

```text
The complete value was not retained: history budget exceeded.
This preview is not the original value. Recompute it or load it from a durable file.
Type: object

Preview:
{ ... }
```

不得生成无效 `$out(id)` 或暗示 `$_` 仍能取回原值。

### 6.6 opaque completion

```text
The value remains in this REPL as `$_`.
For older access, use `$out(21)`.
Type: function
No structural preview is available.
```

不得调用用户 `toJSON`、`toString`、inspect hook、getter 或 Proxy trap。

### 6.7 空结果

无 logs 且 completion 为 `undefined` 时返回空文本。工具调用已经通过外层 tool-result 生命周期明确结算，不再额外发送成功占位文案。

## 7. SDK 与提示词

本节区分两类内容：

- 设计依据、失败复盘和实现说明只存在于本文，不发送给 Agent；
- 下方“Agent 固定提示词”代码块是唯一注入 system prompt 的静态文案。

工具名称、参数和返回类型继续由当前 catalog 生成 SDK declaration；不把用户对话、任务内容、仓库路径、历史错误、设计术语或示例数据拼进固定提示词。

### 7.1 Agent 固定提示词

```text
## Persistent TypeScript REPL

Use `repl` to execute TypeScript cells. Top-level `await` works. Variables,
functions, and objects remain available in later cells while the
current REPL generation is alive. The final expression is the cell result;
top-level `return` is invalid.

Call the generated capabilities through `tools.*`, `agents.*`, and `jobs.*`.
Their results are already parsed JavaScript values. Use the generated return
types directly; do not call `JSON.parse` on tool results and do not guess their
fields. Assign values that you will use again. If a value's shape is uncertain,
inspect it with `Array.isArray(value)` and `Object.keys(value)`.

The latest retained cell result is available as `$_`. Retrieve an older retained
result with `$out(id)`. `$out` is a function, so call `$out(id)`; do not use
`$out.property` or `$out[id]`.

Displayed cell output may be a shortened preview. Continue computation from
your variables, `$_`, or `$out(id)` instead of parsing or copying the displayed
text. Backslashes shown inside a JSON preview are JSON notation, not additional
characters in the underlying string. When writing Windows paths yourself,
prefer forward slashes such as `D:/work/project`.

Keep large source material in files. Keep only paths, compact indexes, helper
functions, and task-relevant summaries in the live REPL.
```

这段提示只描述 Agent 可以依赖的可观察行为，不出现 Host/Worker wire、nonce、ledger、canonical presentation、本文决策过程或任何具体会话内容。

### 7.2 生成声明

SDK 生成器在固定提示之后声明当前真实存在的能力，并补充 completion intrinsics：

```ts
declare const $_: unknown

declare function $out(id: number): unknown

declare namespace $out {
  function list(): Array<{
    id: number
    type: string
    bytes?: number
    nodes?: number
    opaque?: boolean
  }>
  function drop(id: number): boolean
  function clear(): void
}
```

`tools.*`、`agents.*` 和 `jobs.*` 的声明必须完全来自当前 Agent catalog。固定提示不命名 `glob`、`read` 或其他可选工具，不携带 root/child 对话，不引用上一 turn、上一 Session 或其他 Agent 的状态。

### 7.3 按需结果提示

具体 handle 只在某次结果确实被 runtime 保留后，通过该次 notebook result notice 告知 Agent：

```text
The complete value remains available as `$_`.
For older access, use `$out(17)`.
```

该提示属于当前工具结果，不属于固定 system prompt。未保留结果不得显示 handle。固定提示不预置示例 handle，也不携带历史执行内容。

## 8. JSON 与转义边界

### 8.1 保持不变的 JSON seam

以下边界继续要求 lossless JSON：

- Realm → Host 的 binding arguments；
- Host → Realm 的 tool canonical result；
- Worker terminal protocol 中可跨线程的 completion projection；
- DSH Session 与 durable event log。

该约束防止 prototype/getter/Proxy 行为跨边界执行、循环/native handle 无定义传输、unsafe integer 和 renderer text 回灌程序。

### 8.2 不再暴露的 JSON seam

模型不再看到完整：

```json
{"logs":[],"result":...}
```

模型也不再看到 runtime bookkeeping：

```json
{"$out":17,"use":"$out(17)","retained":true,"truncated":true}
```

### 8.3 Windows 路径

提示词统一建议模型在代码和 DSH 工具参数中使用：

```text
D:/yjky/yj-app-backend
```

工具返回的 Windows 反斜杠字符串已经是 Realm 内实际 JavaScript string，不得再次 `JSON.parse`、手工反转义或从 Session JSONL 表示推导 runtime 字符串。

## 9. 不采用的方案

### 9.1 只重命名 envelope 字段

把 `{"$out":17,"use":"$out(17)"}` 改成 `{"handle":17,"retrieve":"$out(17)"}` 只能降低误用，不能移除模型对传输 envelope 的理解成本。它只可作为过渡降级，不是目标设计。

### 9.2 取消 JSON bridge

拒绝。它会把原型、循环结构、native handle、getter 和进程身份问题扩散到每个工具调用者。

### 9.3 为 DSH 工具增加 Prime 专用适配器

拒绝。普通 DSH tool 与 Prime Realm 必须共享同一个 canonical output schema。Prime 不创建第二套搜索、读取或编辑接口。

### 9.4 按 TypeError 文本自动修复代码

拒绝。对 `slice is not a function`、`map is not a function` 或 `Cannot read properties of undefined` 做特判只会抑制症状。

### 9.5 引入 IPython/Jupyter backend

拒绝。上游经验用于模型语义，不用于复制 Python runtime 技术栈。

## 10. 实施切片

### Phase A：可信 presentation metadata

涉及：

- `src/realm/protocol.ts`
- `src/realm/realm.ts`
- `src/realm/runtime.ts`
- 相应 `lib/` 构建产物

工作：

1. 在 nonce 验证后保留 runtime-authored projection 类型；
2. 向上层返回 content-free、可信的 `ReplPresentation`；
3. 用户程序伪造同形对象仍按普通 completion 呈现；
4. metrics 和 history 行为保持不变。

### Phase B：notebook renderer

涉及：

- `src/index.ts`
- outer spill/presentation 组合测试
- 相应 `lib/` 构建产物

工作：

1. logs 使用 plain text section；
2. scalar string 原样呈现；
3. structured JSON 只编码一次；
4. retained/unretained/opaque 使用明确 notebook notice；
5. 确保完整 renderer 文本仍受 DSH spill policy 管理；
6. canonical `repl` tool value 保持结构化。

### Phase C：SDK 教学

涉及：

- `src/index.ts` 的 `sdkText()`
- `src/policy.ts` 仅在需要删除重复规则时调整
- `tests/repl-mode.spec.ts`
- `README.md`
- `docs/architecture.md`

工作：

1. 声明 `$_` 与 `$out`；
2. 加入 parsed canonical value、返回形状、preview、Windows 路径规则；
3. 加入 `$out` 正反例；
4. 保持 REPL 代码语义集中在 SDK section。

### Phase D：旧 envelope 清理

涉及 completion envelope types、projection tests、completion contract tests 和相关文档。

工作：

1. 删除模型可见的 `"$out": number`；
2. 删除 `use`、`retained`、`truncated` 作为模型接口的承诺；
3. 保留 runtime 内部 handle、retention、projection metadata；
4. 不提供旧 envelope alias 或兼容 shim，完成 clean cutover。

## 11. 验证策略

### 11.1 单元与组合测试

必须覆盖：

1. scalar string renderer 不增加 JSON quotes 或反斜杠层；
2. structured object renderer 保持一次合法 JSON 表示；
3. logs 以 plain text 呈现；
4. retained completion notice 首选 `$_`；
5. older handle 明确显示 `$out(id)`；
6. unretained completion 不显示可用 handle；
7. opaque value 不调用用户 hook；
8. 用户返回与旧 envelope 相同形状时按普通数据呈现；
9. forged projection marker fail closed；
10. outer spill artifact 可恢复完整 notebook renderer 文本；
11. 小结果 canonical value 不变；
12. `src/` 与 `lib/` 构建产物同步。

### 11.2 真实模型 E2E eval

#### 场景一：大型 completion 复用

第一 cell 返回超过 `maxCompletionFullBytes` 的对象，要求模型在下一 cell 提取深层字段。

通过条件：使用 `$_` 或有效 `$out(id)`；不出现 `$out.foo` 或 `$out[id]`；不重新读取原始数据；两个 cell 内完成。

#### 场景二：工具返回形状

要求模型调用 `glob` 并返回前五条路径。通过条件是使用 `found.paths.slice(0, 5)`，不得出现 `found.slice(...)`。

#### 场景三：Windows 路径 round-trip

工具返回含反斜杠的 Windows 路径，模型将其传给下一次 `read`。通过条件：underlying path 完全一致；不把 `\\` 当成两个真实字符；不对已反序列化值再次 `JSON.parse`；模型直接编写的新路径优先使用 `/`。

#### 场景四：用户值与 runtime metadata 形状冲突

用户程序主动返回旧 envelope 同形对象。通过条件：按普通用户对象呈现，不显示 runtime retention 指令，metrics 不计为 projected completion。

### 11.3 评测指标

记录首次正确使用率、`repl` exception 数、修复 cell 数、重复读取次数、`$out` 误用次数、Windows 路径调用成功率、总 model step、projection 后继续计算成功率、renderer 字节数和 spill 触发率。

## 12. 完成标准

1. 模型常规路径不再看到 completion JSON envelope；
2. Host/Worker lossless JSON seam 保持不变；
3. `$_` 成为最近 retained completion 的首选入口；
4. `$out(id)` 只用于历史访问，不再被字段名诱导成对象；
5. scalar string 和 logs 不再经过外层 JSON 包装；
6. structured preview 只发生一次 JSON 表示；
7. runtime-authored projection 由可信 metadata 驱动呈现；
8. 用户伪造同形对象不会触发 runtime 呈现；
9. README、architecture、SDK 和测试与实际行为一致；
10. `npm run check` 通过；
11. 大结果复用、返回形状和 Windows 路径三个真实模型 eval 均证明错误率下降，且没有增加重复读取率。

## 13. 最终所有权

| 事实 | 所有者 |
| --- | --- |
| 工具参数与 canonical output schema | DSH Tools |
| Host 工具权限、sandbox、approval、日志与调度 | DSH Host |
| Realm live object 与 completion history | `dsh-prime-agent` Worker |
| completion retention/projection 判断 | `dsh-prime-agent` Realm runtime |
| notebook 模型呈现 | `dsh-prime-agent` `repl` renderer |
| oversized outer result spill | DSH spill policy/store |
| Session durable event JSON | DSH Session persistence |
| 模型使用教学 | Prime `tools:sdk` REPL section |

任何实施不得把 renderer 文本回灌为 `tools.*` canonical value，也不得让 presentation metadata 变成第二套工具结果 schema。

## 14. 验收记录

### 14.1 源码验证

```text
npm run check
Test Files  24 passed | 1 skipped (25)
Tests       289 passed | 1 skipped (290)
```

跳过项是需要显式模型凭据的常驻测试文件；真实模型行为由下一项独立闭合。

### 14.2 真实 TUI 与模型验证

使用 `D:/project/dsh-tui-plugin-OhMyPi/.agents/skills/test-dsh-tui` 的 packaged ConPTY runner，在隔离 `DSH_HOME` 中安装当前 `dsh-prime-agent-0.4.1.tgz`，启用真实 `openai-codex/gpt-5.6-sol`，执行自定义 Prime REPL 场景：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass `
  -File .agents/skills/test-dsh-tui/scripts/run-live-test.ps1 `
  -Scenario C:/Users/xyad/AppData/Local/Temp/prime-repl-notebook-live.mjs `
  -KeepArtifacts -AllowModelRequests
```

通过的可观察断言：

- 大 completion 显示 retained notice，普通结果没有类型标题或 Markdown fence；
- notice 首选 `$_`，模型在后续 cell 实际使用 `$_` 取回 marker；
- 模型依据 generated output shape 使用 `glob` 结果的 `.paths`；
- 模型验证 `String.raw` Windows 路径包含两个真实反斜杠字符；
- 模型可见输出不含旧 `{\"logs\":[],\"result\":...}` 外壳或 `\"use\":\"$out(...)\"` envelope；
- 最终回答包含 `PRIME_REPL_E2E_OK`、`retained-ok`、首个路径和反斜杠计数 `2`；
- TUI 进程在整个模型 turn 前后保持同一 PID `52116`。

保留的验收产物：

```text
C:/Users/xyad/AppData/Local/Temp/dsh-tui-live-9fa1c1aa5a5642008bef30ffb642446e/artifacts
```

其中包含 `report.json`、`pty-output.log` 及 `prime-repl-notebook.{txt,svg,png}`。
