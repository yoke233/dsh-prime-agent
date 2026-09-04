# Prime REPL Notebook 呈现规格

> 状态：已实现  
> 适用版本：`dsh-prime-agent` 0.4.1 及以上  
> 目标：定义 Prime Agent 的固定 REPL 教学、单槽 completion 保留、可信呈现 metadata 与模型可见文本契约。

## 1. 范围

本规格只描述当前已经交付的行为：

- Agent 收到的 Persistent TypeScript REPL 固定提示；
- Host 工具结果进入 Realm 的数据形态；
- cell 最新 completion 的 generation-local 保留和访问；
- Realm → Host 的可信 presentation metadata；
- 外层 `repl` canonical value；
- 模型可见的 notebook 文本；
- 大结果、非 JSON 对象、转义和失败语义。

本规格不改变 DSH 对工具 schema、权限、sandbox、approval、日志、Session、spill artifact、Subagent 或 Job 的所有权。

## 2. 三层契约

Prime REPL 分为三个独立层次。

### 2.1 执行层

Host 与 Realm 之间只传 lossless JSON：

- Host binding seam 上的 arguments 必须是 lossless JSON；`tools.grep.pattern` 在 generated SDK 与 Realm interface 中均为 string，正则 literal 必须由调用方通过 `.source` 转成 canonical string 后再跨 seam；
- `tools.*` 成功调用以内部 `{ value, presentation }` 传输，Worker 立即解包并只把 canonical `value` 返回给程序；
- object/array value 与非空 text presentation 通过 Worker 私有 WeakMap 按 identity 关联；image content 仍由 deferred context 转发；
- 工具失败在 cell 中抛对应的 typed error。

生成 SDK 始终声明 canonical `ToolOutputMap`。关联对象未经转换直接成为 completion 时展示 presentation；字段提取、spread、map 等派生值走普通 completion，primitive value 也保持 canonical。

### 2.2 保留层

成功 cell 的非 `undefined` 末尾表达式由 runtime 自动尝试保留在当前 Worker generation 的唯一 completion 槽中：

```ts
$_            // 最近一个通过准入的非 undefined completion
```

模型应优先把需要复用的工具结果和工作值赋给命名变量。`$_` 适合立即读取最新 completion；下一个产生非 `undefined` completion 的 cell 会替换它。completion 为 `undefined` 的 cell 不覆盖当前 `$_`，因此可先执行 `let saved = $_` 再继续工作。

单槽只保留原始 value identity，不提供 numeric id、历史列表、淘汰或管理操作。hard kill、OOM、active abort、timeout、Worker exit 或 host restart 会丢失整个 Worker generation；下一次真正执行会收到 namespace-loss notice，旧 bindings 与 `$_` 均不可恢复。

### 2.3 呈现层

模型看到的是 notebook 文本，不是 Host/Worker 协议：

- 不显示 `{ logs, result }` 外壳；
- 不显示内部 completion envelope；
- 不添加 `[repl result: ...]` 或 `[repl logs]`；
- 不添加 ```` ```text ```` 或其他 Markdown fence；
- preview 只用于观察，不能作为可解析数据继续计算。

## 3. Agent 固定提示

生产 system prompt 注入以下独立、自足的固定契约：

```text
## Persistent TypeScript REPL

Call only `repl` directly. In the TypeScript code passed to `repl`, use the
preloaded `tools.*`, `agents.*`, and `jobs.*` APIs. Follow each generated
declaration and its comments. `import` and `require` are unavailable.

Only the cell's completion value (its last expression) and `console.log` output
enter the conversation; every `tools.*` result stays in the REPL until you display
part of it. Visible output per cell is budgeted at about 12 KB: a larger display
is spilled to a file and replaced by a preview, so filter, slice, count, or aggregate
in code and display only what the next decision needs. Extra cells cost more than
extra output: reduce round trips first, then keep displays small when doing so does
not force another cell.

Top-level `await` works; top-level `return` does not. Treat the REPL as a live
notebook: successful top-level bindings remain available in later cells. Bind every
read, search, and command result to a named `let` variable and continue from it in
later cells: slice, filter, or transform the binding instead of repeating the call.
A value bound in an earlier cell does not need to be re-read, printed, or
reconstructed. Tool results are typed values (see `ToolOutputMap`): chain calls and
access fields directly in one cell without displaying intermediate results. A parse
failure executes nothing; fix the cell and retry.

If a cell is a single `await tools.x(...)` whose raw result becomes the completion,
you are using the REPL as tool-call syntax: bind the result and reduce it instead.
Conversely, when one grep or one ranged read already pins the answer, read it
directly; do not build machinery for a one-line lookup.

Pass TypeScript object literals, writing identifier keys as `key: 'value'`, not
`key': 'value'`. Tool results are parsed JavaScript values; do not call
`JSON.parse` on them. Inspect uncertain shapes with `Array.isArray(value)` and
`Object.keys(value)`.

`$_` is the latest non-undefined completion; assign it to a name before running
another value-producing cell. When a result reports `Full formatted result stored
at:`, your variable still holds the complete value: continue from it in the next
cell (slice, filter, count, or grep it) rather than displaying it whole again or
re-running the call, and read or grep the reported locator only for omitted
formatted text. Convert Windows locator backslashes to forward slashes before
putting the path in a string literal. Backslashes in JSON previews are notation,
not extra characters. Prefer forward-slash Windows paths such as `D:/work/project`.

Keep large source material in files and only compact working state in the REPL.
```

「about 12 KB」由插件配置 `visibleOutputBudgetBytes`（默认 12000）渲染，须与 preset 的 `prime-spill-policy.maxInlineBytes` 一致。固定提示之后、declaration 之前，插件在 `grep` 与 `read` 都在 catalog 中时附一段 `Patterns:`，含三个各不超过六行的 TypeScript 样例：批量 grep 后按文件分组计数、先 grep 定位锚点再范围 read、跨候选文件早停。样例只使用相对路径与真实字段名（`matches[].path/lineNumber`、`lines[].number/text`），不含仓库、任务或历史内容。

固定提示不拼接：

- 用户聊天或任务正文；
- 设计过程和失败复盘；
- 具体仓库、路径或历史 completion 标识；
- 上一 Session 或其他 Agent 的上下文；
- 当前 catalog 中不存在的可选工具名。

当前 Agent catalog 只负责生成实际可用的 `tools.*`、`agents.*`、`jobs.*` 参数与 canonical output 类型声明；`agents` 声明固定附带私有成员 `query`/`queryMany`，声明上方的 JSDoc 说明它们与 `spawn` 的分工，成员 JSDoc 携带当前预算（prompt 字符上限、单批条数、`maxTokens` 上限）。

## 4. 内部结果类型

### 4.1 Realm run result

Realm runtime 在官方 `CodeRunResult` 上增加可选、可信的呈现 metadata：

```ts
interface PrimeRunResult extends CodeRunResult {
  presentation?: ReplPresentation
}
```

### 4.2 Presentation union

```ts
type ReplPresentation =
  | { kind: 'full' }
  | {
      kind: 'retained-preview'
      valueType: string
      serializedBytes?: number
    }
  | {
      kind: 'unretained-preview'
      valueType: string
      serializedBytes?: number
      reason?: string
    }
  | {
      kind: 'opaque-reference'
      valueType: string
    }
```

`presentation` 只描述如何显示，不替代 canonical `value`。

### 4.3 来源认证

Worker 在 runtime-authored projection terminal 中携带本次 run 的私有 nonce。Host 必须依次验证：

1. terminal 属于当前 run；
2. `projected` 值等于当前 run nonce；
3. envelope 的 type、size、retained 状态和分类一致；
4. completion 通过 outer output ledger。

只有全部通过，Host 才附加 `ReplPresentation`。

用户程序可以返回与内部 envelope 同形的普通 JSON，但没有可信 nonce，因此：

- 不生成 `presentation`；
- 不计入 projected completion metrics；
- 按普通 JSON 显示。

## 5. 外层 `repl` canonical value

Agent-scope `repl` 工具成功时返回：

```ts
interface ReplExecutionResult {
  logs: string[]
  result?: JsonValue
  presentation?: ReplPresentation
  contextTokens?: number
  contextWindow?: number
}
```

该结构供 DSH tool runtime、测试、日志和 spill policy 程序化处理。模型只接收它的 notebook renderer 文本。`contextTokens` 是 cell 开始前 host `tokenMeter` 对当前 Session 的估算，`contextWindow` 是路由模型宣告的窗口；meter、LLM 服务或路由信息任一不可用时对应字段省略，测量失败不影响 cell。

失败 cell 继续抛：

```text
repl cell failed (<kind>): <message>
```

并在存在已接纳日志时附加日志。失败不伪造成功 presentation。

## 6. Notebook renderer

### 6.1 普通字符串

Realm completion：

```ts
'D:\\yjky\\yj-app-backend'
```

模型文本为实际字符串内容：

```text
D:\yjky\yj-app-backend
```

不添加引号、类型标题或 Markdown fence。

### 6.2 普通结构化值

Realm completion：

```ts
({ paths: ['D:\\yjky\\a.go'] })
```

模型文本只执行一次 deterministic pretty JSON：

```json
{
  "paths": [
    "D:\\yjky\\a.go"
  ]
}
```

JSON 中的 `\\` 是字符串表示，不是 underlying string 中的两个字符。

数字、boolean 和 `null` 同样按 JSON 值直接显示，例如 `42`、`true`、`null`，不增加 `json` 标签。

### 6.3 Logs

有日志时按接纳顺序以换行拼接，不增加 `[repl logs]`：

```text
reading files...
found 27 matches
```

同时存在 logs 和 completion 时，两部分以一个空行分隔。

### 6.4 空结果

无 logs 且 completion 为 `undefined` 时，renderer 返回空文本。tool-result 生命周期本身已证明调用完成，不发送额外成功占位文案。

### 6.5 Retained preview

```text
The complete value remains in this REPL as `$_`.
Assign it to a variable before running another value-producing cell.
Continue from that variable in the next cell (slice, filter, count); do not display it whole again.
Type: object
Serialized size: 65,722 bytes

Preview:
{
  "type": "object",
  "keyCount": 2
}
```

规则：

- presentation 不携带 numeric handle；
- `valueType` 必须存在，包括 minimal reference；
- preview 不显示内部 `retained` 或 `truncated` 字段；
- 提示必须说明在运行下一个产生 completion 的 cell 前先赋给命名变量，并说明下一步是从变量归约而不是整体重显示。

### 6.6 Unretained preview

```text
The complete value was not retained: single-slot retention budget exceeded.
This preview is not the original value. Recompute it or load it from a durable file.
Type: object

Preview:
{ ... }
```

未保留结果不得显示 `$_` 可恢复承诺；preview 不是原值，只能重新计算或从持久文件载入。

### 6.7 Opaque reference

Map、Set、函数、BigInt、循环对象、class instance 或分类阶段拒绝 lossless JSON 的其他 live value 使用独立的 opaque 单槽预算：

```text
The value remains in this REPL as `$_`.
Assign it to a variable before running another value-producing cell.
Type: function
No structural preview is available.
```

renderer 和分类过程不得调用用户 `toJSON`、`toString`、inspect hook、getter 或 Proxy trap 来生成展示。

### 6.8 上下文用量行

canonical value 带 `contextTokens` 时，renderer 在全部 sections 之后以空行分隔追加一行：

```text
Context: 61,900 / 372,000 tokens
```

`contextWindow` 缺失时只显示 `Context: 61,900 tokens`；`contextTokens` 缺失时不追加任何内容，即使 `contextWindow` 存在。这一行是纯追加的观察文本，不改写既有 sections，也不进入 `$_`。

## 7. 大小与降级

completion 呈现按以下链路降级：

```text
full → rich projection → typed minimal reference → output-limit
```

- `maxCompletionFullBytes` 以内且装得进剩余 output ledger 的 lossless JSON 原样跨 Host；
- 超过 full threshold 时生成有界 rich projection；
- rich projection 超过 `maxCompletionProjectionBytes` 时降为 typed minimal reference；
- minimal reference 仍装不进本次剩余 `maxOutputBytes` 时返回 `output-limit`；
- retained minimal JSON 和 retained minimal opaque envelope 都必须携带安全 `type`；
- minimal envelope 不携带 numeric handle；
- logs 与 completion 共用 `maxOutputBytes` ledger。

原始 live value 是否保留由单槽预算决定，与模型展示预算分离：JSON 使用 `maxCompletionRetainedBytes` 与 `maxCompletionRetainedNodes`，opaque 使用 `maxCompletionOpaqueBytes` 与 `maxCompletionOpaqueNodes`。每类值独立判定是否可以成为最新值；预算拒绝会清空旧单槽，且不得声称被拒绝的新值可恢复。

## 8. Spill 组合

Prime preset 对模型可见的外层 `repl` 文本应用 12KB best-effort spill threshold：

- Realm 内 canonical value 不被 spill 截断；
- renderer 先生成完整 notebook 文本；
- 文本超展示预算时由 DSH spill policy 保存并返回 locator；
- artifact 恢复的是完整 notebook 文本；
- store 缺失、保存失败或 locator notice 无法放入预算时，保留完整 inline 成功结果并告警；
- Prime 不拥有 spill store 的配额、保留期或清理。

## 9. Windows 路径与转义

模型自行编写路径时优先使用：

```text
D:/work/project
```

工具返回的 Windows 路径已经是 Realm 中的实际 JavaScript string。模型不得：

- 再次 `JSON.parse`；
- 根据 Session JSONL 中的编码形式手工反转义；
- 把 JSON preview 中的 `\\` 当成两个实际字符。

只有模型直接编写 TypeScript string literal 时才处理语言字面量转义。

## 10. 不变量

实现必须保持：

1. Session → Realm 隔离；
2. 同 Realm cell 严格串行；
3. binding lease 按 run 撤销；
4. hard kill 后显式 namespace-loss notice；
5. 单槽保留原始 value identity，`undefined` completion 不覆盖当前值，预算拒绝清空旧值且不声明可恢复；
6. projection 来源由 nonce 验证；
7. presentation metadata 不携带任务内容、路径、凭据或 Session identity；
8. Prime 不重新实现工具 renderer，而是直接使用 DSH 已生成的 `result.content`；
9. 程序始终得到 canonical value；关联对象直接成为 completion 时优先展示非空 content；
10. outer renderer 不再次改变程序化 completion value；
11. 普通结果不添加类型标题或 Markdown fence。

## 11. 验证

完整源码验证：

```powershell
npm run check:all
```

重点回归：

- `tests/repl-mode.spec.ts`
- `tests/llm-binding.spec.ts`
- `tests/completion-contracts.spec.ts`
- `tests/completion-history.spec.ts`
- `tests/completion-projection.spec.ts`
- `tests/completion-opaque.spec.ts`
- `tests/large-tool-output.e2e.spec.ts`
- `tests/prime-agent-loop.e2e.spec.ts`
- `tests/prime-runtime.spec.ts`

真实 TUI 验收使用 `test-dsh-tui` packaged ConPTY runner，至少证明：

- retained notice 出现且模型使用 `$_` 或先保存为命名变量；
- 模型按 generated output type 使用工具结果；
- Windows 路径字符数保持正确；
- 普通结果没有 `[repl result: ...]`、`[repl logs]` 或 Markdown fence；
- 旧外层 `{ logs, result }` 和内部 envelope 不进入模型文本；
- 模型 turn 前后 TUI PID 不变。
