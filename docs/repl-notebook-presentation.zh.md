# Prime REPL Notebook 呈现规格

> 状态：已实现  
> 适用版本：`dsh-prime-agent` 0.4.1 及以上  
> 目标：定义 Prime Agent 的固定 REPL 教学、completion 保留、可信呈现 metadata 与模型可见文本契约。

## 1. 范围

本规格只描述当前已经交付的行为：

- Agent 收到的 Persistent TypeScript REPL 固定提示；
- Host 工具结果进入 Realm 的数据形态；
- cell completion 的 generation-local 保留和访问；
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

成功 cell 的末尾表达式由 runtime 自动进入当前 Worker generation 的 completion history：

```ts
$_            // 最近一个已保留 completion
$out(17)      // 读取较早的 completion
$out.list()   // 有界 metadata
$out.drop(17)
$out.clear()
```

优先级：

1. 模型已命名的变量；
2. 最近 completion：`$_`；
3. 更早 completion：`$out(id)`。

`$out` 是函数，不是结果对象；`$out.property` 和 `$out[id]` 均不是合法访问方式。

history 只在当前 Worker generation 内有效。hard kill、OOM、active abort、timeout、Worker exit 或 host restart 会使旧 handle 失效；后续访问抛 `CompletionExpiredError`。

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

Use `repl` to execute TypeScript cells. Top-level `await` works. Variables,
functions, and objects remain available while the REPL stays active. The final
expression is the cell result; top-level `return` is invalid. A cell that fails to
parse executes no code; correct its TypeScript syntax and retry it.

Call tools through `tools.*`, `agents.*`, and `jobs.*`. Pass arguments as
TypeScript object literals. For identifier keys, write `key: 'value'`; never write a trailing quote after
an unquoted key. Results are already parsed JavaScript values. Follow the provided TypeScript declarations; do not
call `JSON.parse` on tool results or guess their fields. Assign values that you
will reuse. If a value's shape is uncertain, inspect it with
`Array.isArray(value)` and `Object.keys(value)`.

`$_` is the latest available cell result. Retrieve an older result with
`$out(id)`. `$out` is a function, so call `$out(id)`; do not use
`$out.property` or `$out[id]`.

Displayed cell output may be shortened. Continue computation from your
variables, `$_`, or `$out(id)` instead of parsing or copying displayed text.
Backslashes shown inside a JSON preview are JSON notation, not additional
characters in the underlying string. When writing Windows paths yourself,
prefer forward slashes such as `D:/work/project`.

Keep large source material in files. Keep only paths, compact indexes, helper
functions, and task-relevant summaries in the REPL.
```

固定提示不拼接：

- 用户聊天或任务正文；
- 设计过程和失败复盘；
- 具体仓库、路径或历史 handle；
- 上一 Session 或其他 Agent 的上下文；
- 当前 catalog 中不存在的可选工具名。

当前 Agent catalog 只负责生成实际可用的 `tools.*`、`agents.*`、`jobs.*` 参数与 canonical output 类型声明。

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
      handle: number
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
      handle: number
    }
```

`presentation` 只描述如何显示，不替代 canonical `value`。

### 4.3 来源认证

Worker 在 runtime-authored projection terminal 中携带本次 run 的私有 nonce。Host 必须依次验证：

1. terminal 属于当前 run；
2. `projected` 值等于当前 run nonce；
3. envelope 字段、handle、type、size、retained 状态和取回表达式一致；
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
}
```

该结构供 DSH tool runtime、测试、日志和 spill policy 程序化处理。模型只接收它的 notebook renderer 文本。

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
For older access, use `$out(17)`.
Type: object
Serialized size: 65,722 bytes

Preview:
{
  "type": "object",
  "keyCount": 2
}
```

规则：

- `$_` 必须先于 `$out(id)` 出现；
- handle 必须已真实入槽；
- `valueType` 必须存在，包括 minimal reference；
- preview 不显示内部 `$out`、`use`、`retained` 或 `truncated` 字段。

### 6.6 Unretained preview

```text
The complete value was not retained: history budget exceeded.
This preview is not the original value. Recompute it or load it from a durable file.
Type: object

Preview:
{ ... }
```

未保留结果不得显示 `$_` 可恢复承诺或 `$out(id)` handle。

### 6.7 Opaque reference

Map、Set、函数、BigInt、循环对象、class instance 或分类阶段拒绝 lossless JSON 的其他 live value 使用 opaque history：

```text
The value remains in this REPL as `$_`.
For older access, use `$out(21)`.
Type: function
No structural preview is available.
```

renderer 和分类过程不得调用用户 `toJSON`、`toString`、inspect hook、getter 或 Proxy trap 来生成展示。

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
- 当前最坏合法 typed minimal envelope 上限为 105 bytes；
- logs 与 completion 共用 `maxOutputBytes` ledger。

原始 live value 是否保留由独立 history/opaque budgets 决定，与模型展示预算分离。

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
5. handle 由 Host 全局单调分配且不复用；
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
- `tests/completion-contracts.spec.ts`
- `tests/completion-history.spec.ts`
- `tests/completion-projection.spec.ts`
- `tests/completion-opaque.spec.ts`
- `tests/large-tool-output.e2e.spec.ts`
- `tests/prime-agent-loop.e2e.spec.ts`
- `tests/prime-runtime.spec.ts`

真实 TUI 验收使用 `test-dsh-tui` packaged ConPTY runner，至少证明：

- retained notice 出现且模型使用 `$_`；
- 模型按 generated output type 使用工具结果；
- Windows 路径字符数保持正确；
- 普通结果没有 `[repl result: ...]`、`[repl logs]` 或 Markdown fence；
- 旧外层 `{ logs, result }` 和内部 envelope 不进入模型文本；
- 模型 turn 前后 TUI PID 不变。
