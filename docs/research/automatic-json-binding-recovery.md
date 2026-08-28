# 顶层 JSON binding 自动恢复：最小 Go/No-Go 调研

## 结论先行

**当前原始要求应判为 No-Go；接受两项明确降级后才是 Conditional Go。**

它不是“把两个现成函数接起来”即可完成的简单小需求：

1. `Runtime.globalLexicalScopeNames` 能发现顶层 `let` / `const` / `class` 名称，但不返回 declaration kind；`Runtime.evaluate({ throwOnSideEffect: true })` 只能对求值过程作保守副作用检查。官方 CDP 没有承诺它会让随后对返回对象的递归遍历也无副作用。[CDP `globalLexicalScopeNames`](https://chromedevtools.github.io/devtools-protocol/tot/Runtime/#method-globalLexicalScopeNames)、[CDP `evaluate`](https://chromedevtools.github.io/devtools-protocol/tot/Runtime/#method-evaluate)
2. 已安装的 `@deepseek-ai/dsh-session@0.1.1-rc.2` 中，`snapshotJsonValue` 是正确的最终 lossless-JSON 边界，但它会读取属性，因而会执行 getter；其 prototype、own-key、enumerability 和 value 读取也会触发相应 Proxy traps。上游测试还明确验证了 getter 被执行一次以及 getter 异常向外传播。它不能直接用于不可信的 Realm 对象而又声称“capture 无副作用”。[`json.ts:51-179`](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/core/session/src/json.ts#L51-L179)、[`json.spec.ts:67-181`](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/core/session/tests/json.spec.ts#L67-L181)
3. 本仓库和所核对的 DSH 源码中没有现成的、在触发 trap 之前拒绝任意 Proxy 的 capture seam。若新增 Worker 内的“拒绝 Proxy / accessor、只复制 own data descriptors”的可信 copier，才可以把复制后的普通数据交给 Host 侧 `snapshotJsonValue` 作最终边界；这已经是一个新的安全模块，而不是直接复用现有 primitive。

因此最小可接受契约必须是：

- **词法 binding 只恢复值，不恢复 declaration kind，统一恢复为 `replMode` 下的 mutable `let`。** 原 `const` 的不可赋值语义会消失。
- **新增 global own data property 不统一改成 `let`**，而是仍恢复为 `globalThis` own data property；否则 `var` / `globalThis.x` 的可见性会被破坏。
- 仅恢复经可信 copier 判定为无 accessor、无 Proxy、最终通过 `snapshotJsonValue` 的数据；函数、class 值、imports、accessor、Proxy、Map/Set/Date、class instance、循环、稀疏/装饰数组、`undefined`、BigInt、symbol、`-0`、非有限数全部跳过。
- checkpoint 是“最近一个已完成 capture 边界的 detached JSON”，不是 JS heap，也不保持对象 identity、共享引用、prototype、闭包或未完成异步工作。
- 磁盘提交只承诺 rename-based atomic visibility，不承诺掉电后 durability。

在这些条件下，预计产品面仍可控制在 **1 个很小的安全 capture/store helper、4 个现有生产文件、2 个现有 focused test 文件**；私有协议只增加 **一个首 run 的可选 restore payload** 和 **一个 done 的可选 checkpoint payload**。如果不接受新的安全 copier、mutable-`let` 降级、自动落盘的隐私风险或非 durable 语义，则保持 No-Go，不应实现半安全版本。

## 已核对的当前 seam

### Realm 执行与生命周期

- `PersistentRealm` 目前保证同 Realm 严格串行；正常 run 保留 Worker，abort、timeout、output overflow、substrate death、protocol violation 会 hard-kill 并启动新 generation。[`src/realm/realm.ts:1-12`](../../src/realm/realm.ts)
- `RealmRunNotice` 只在实际 dispatch 时报告 `fresh` / `namespaceLost`，所以排队取消或 type-strip 失败不会错误消费恢复通知。[`src/realm/realm.ts:114-129,720-773`](../../src/realm/realm.ts)
- `ensureSession` 为每代 Worker 建立新的私有 `MessagePort`，使用空环境、空 `execArgv` 和 V8 old-generation 限制；generation 在 Worker 真正建立时 materialize。[`src/realm/realm.ts:807-856`](../../src/realm/realm.ts)
- `hardKill` 先将 session 标死、撤出当前 session、安排 generation bump，再关闭端口并调用 `worker.terminate()`；run 只在 Worker 及 stdio drain 结束后结算。恢复不能削弱这条语义，也不能向将死 Worker 请求“最后一次快照”。[`src/realm/realm.ts:1103-1133`](../../src/realm/realm.ts)
- Worker 当前通过 Inspector `Runtime.evaluate` 的 `replMode: true` 执行 cell，并支持 top-level await；现有测试证明同 generation 内 `const`、`let`、`var`、function、class 都可在后续 REPL cell 中 redeclare。[`src/realm/realm-worker.ts:1489-1549`](../../src/realm/realm-worker.ts)、[`tests/realm-worker.spec.ts:109-134`](../../tests/realm-worker.spec.ts)
- Worker 在发出 `done` 前调用 `revokeLeases()`、清除 active run、清理 timers、abort promise timers，并拒绝未决 binding calls。capture 必须位于用户求值完成之后、该 terminal cleanup 之前或作为其中一个同步步骤；无论 capture 成败，撤销顺序不能改变。[`src/realm/realm-worker.ts:1551-1579`](../../src/realm/realm-worker.ts)
- Host 对 `done` 已有 session ownership、runId 和单次 nonce 校验；错误归属或伪造 terminal 会 hard-kill，而不是接纳。checkpoint payload 必须沿用同一 envelope，不另开可伪造通道。[`src/realm/protocol.ts:246-285`](../../src/realm/protocol.ts)、[`src/realm/realm.ts:887-945`](../../src/realm/realm.ts)

### CDP 发现与读取能力

官方 CDP Runtime 文档确认：

- `Runtime.globalLexicalScopeNames` 返回 global scope 中所有 `let`、`const`、`class` 名称，结果仅为 `names: string[]`；没有 declaration kind。[官方方法定义](https://chromedevtools.github.io/devtools-protocol/tot/Runtime/#method-globalLexicalScopeNames)
- `Runtime.evaluate` 在 global object 上求值；`throwOnSideEffect` 的语义是“如果无法排除副作用则抛异常”，并隐含 `disableBreaks`。该参数是 **Experimental**；返回仍是 `RemoteObject result` 加可选 `exceptionDetails`。[官方方法定义](https://chromedevtools.github.io/devtools-protocol/tot/Runtime/#method-evaluate)
- `replMode` 允许 top-level await 和源自 `replMode` 的 `let` redeclaration。它说明为何恢复生成的 `let` 不会永久阻止后续 REPL redeclare，但不提供原 declaration kind。[同一官方 `evaluate` 定义](https://chromedevtools.github.io/devtools-protocol/tot/Runtime/#method-evaluate)

可安全依赖的最窄用法是：用 `globalLexicalScopeNames` 发现候选名，再对单个、经过名称白名单的 identifier 做 `Runtime.evaluate({ throwOnSideEffect: true, returnByValue: false, generatePreview: false, silent: true })`。这只能安全取得 binding 当前引用；**不能据此推断递归读取该对象安全**。

### `snapshotJsonValue` 的真实边界

本地安装的 `@deepseek-ai/dsh-session@0.1.1-rc.2` 编译实现与只读上游源码一致。[上游 package](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/core/session/package.json)

`snapshotJsonValue` 的优点：

- 迭代遍历，不受 JS call stack 深度限制；
- 校验与 detached copy 在同一次属性读取中完成；
- 接受 `null`、boolean、string、有限且非 `-0` 的 number、dense plain arrays、plain/null-prototype objects；
- 拒绝 functions、symbols、BigInt、`undefined`、非有限数、`-0`、cycles、sparse/decorated arrays、exotic prototypes；
- 忽略 `toJSON`，不会通过 `JSON.stringify` 的 hook 改写值；
- detached snapshot 会打断共享 object identity，上游测试明确证明同一个源对象在多个位置会成为多个副本。[`json.ts:3-162`](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/core/session/src/json.ts#L3-L162)、[`json.spec.ts:35-155`](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/core/session/tests/json.spec.ts#L35-L155)

但它不是无副作用 walker：

- object property 通过 `task.source[task.key]` 读取，array slot 通过 `task.source[index]` 读取；getter 会运行。[`json.ts:99-115`](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/core/session/src/json.ts#L99-L115)
- prototype、`Reflect.ownKeys`、enumerability 检查和 property read 对 Proxy 可能触发 traps；实现没有类别性 Proxy rejection。[`json.ts:15-159`](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/core/session/src/json.ts#L15-L159)
- throwing getter 会直接抛出，而不是返回 `undefined`；上游测试对此有明确断言。[`json.spec.ts:168-181`](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/core/session/tests/json.spec.ts#L168-L181)

本仓库现有 Host binding resolution 已在 `dispatchCall` 中调用它，并把异常或 `undefined` 折叠成 `binding resolution must be lossless JSON`。该位置处理的是 Host function 返回值，不是 model-controlled Realm heap，因此不能直接证明 checkpoint capture 也安全。[`src/realm/realm.ts:1033-1098`](../../src/realm/realm.ts)

**结论：** `snapshotJsonValue` 可以且应当作为 Host 收到“已安全分离候选值”后的最终 schema/data boundary；不能直接拿 model Realm 中的对象调用。

### `writeFileAtomic` 的真实保证

本地安装的 `@deepseek-ai/dsh-atomic-write@0.1.1-rc.2` 与只读上游源码一致。[上游 package](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/util/atomic-write/package.json)

`writeFileAtomic` 创建 parent directory，在目标同目录以随机后缀和 `wx` 写完整 temp file，随后 `rename(temp, filename)` 替换目标，失败时删除 temp 并重抛。因此正常 reader 看到旧完整文件或新完整文件，不会看到半份内容；同目录 temp 也避免跨 filesystem rename。[`atomic-write/src/index.ts:1-63`](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/util/atomic-write/src/index.ts#L1-L63)

它明确不 `fsync` 文件或 parent directory，源码写明 crash durability out of scope；README 也称其为 “Atomic, not durable”。掉电或 OS crash 后 rename 可能回退，不能承诺最近一次成功 run 的 checkpoint 一定持久。[`atomic-write/src/index.ts:43-55`](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/util/atomic-write/src/index.ts#L43-L55)、[`atomic-write/README.md:35-70`](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/util/atomic-write/README.md#L35-L70)

本设计直接使用 `writeFileAtomic`，不再叠 `withFileLock`：`PrimeRealmRuntime` 已在建立 Realm 前取得 per-Realm cross-process lease，同一 Realm 的 run 又严格串行；writer 必须在释放该 lease 前等待自身 checkpoint write 完成。现有 lease 的目的正是阻止两个 Host 为同一 Realm 提供两个 live heaps。[`src/realm/realm-lease.ts:1-8,94-136`](../../src/realm/realm-lease.ts)、[`src/realm/runtime.ts:275-339,374-418`](../../src/realm/runtime.ts)

## 最小协议和存储格式

不引入通用 checkpoint framework，只扩展现有私有 `HostToRealm` / `RealmToHost`：

- `HostToRealm` 的 `type: 'run'` 增加可选 `restoreJson: string`，只在该 Worker generation 的第一次 dispatch 出现。内容是 Host 已 parse、exact-shape validate、经 `snapshotJsonValue` 复核后再 stringify 的 checkpoint。
- `RealmToHost` 的 `type: 'done'` 增加可选 `checkpointJson: string` 和内容无关的统计（候选数、恢复数、跳过数即可）。它继续携带既有 `runId` / `nonce`；Host 只有在当前 `RealmSession`、当前 run、nonce 都匹配时才可写盘。
- `RealmRunNotice` 增加恢复 manifest 元数据：`restoredNames`、`restoredTotal`，以及至多一个 unavailable/stale 状态。它只在实际 first dispatch 消费。

不新增独立 handshake、ack/retry 消息、事件日志、cell replay 或通用版本协商。

建议单文件 schema：

- `schemaVersion: 1`
- `revision`: Host 单调递增 safe integer
- `sourceGeneration`: 产生它的 Worker generation，仅作 fencing/诊断
- `bindings`: 按 `scope` + `name` 排序的数组
  - lexical 项：`{ scope: 'lexical', name, value }`
  - global 项：`{ scope: 'global', name, writable, enumerable, configurable, value }`

使用数组而不是 name-keyed object，因为 lexical 和 global own property 可以同名并同时存在；恢复后 lexical 仍应遮蔽 `globalThis[name]`。

建议路径为 `<stateDirectory>/realm-checkpoints/<realmId>.json`，file mode `0o600`、新目录 mode `0o700`。文件名使用已验证的 opaque realm id，不落盘 raw session id。checkpoint 不需要时间戳、模型输入、日志或 skip reason 明细。

## Capture 算法

Worker generation boot 完成、任何 model code 执行前记录：

- `bootLexicalNames`：一次 `Runtime.globalLexicalScopeNames`；
- `bootGlobalOwnNames`：`globalThis` 的 own string keys；
- `runtimeOwnedNames`：`$_`、所有 `RealmNamespaceSpec.global`、error class name，以及内部 bridge 名。

每个实际执行过的 cell 在 terminal boundary：

1. lexical candidates = 当前 lexical names − boot lexical names − runtime-owned names；
2. global candidates = 当前 global own string keys − boot global keys − runtime-owned names；
3. 名称满足现有 portable ASCII identifier 规则并排除 portable reserved words；该规则已有于 binding global validation，避免新增第二套名称/codegen 约定。[`src/realm/realm.ts:143-173,610-653`](../../src/realm/realm.ts)
4. lexical 值只通过 identifier + `throwOnSideEffect: true` 取得；global property 只从 `globalThis` own **data descriptor** 取 `descriptor.value`，绝不执行 getter；
5. 唯一新增的可信 copier 必须在读取任意 object graph 的 prototype、own keys 或 descriptors 之前拒绝 Proxy；对已证明非 Proxy 的 ordinary object，只用 Worker boot 时捕获的 intrinsics 读 own descriptors，遇到 accessor 立即拒绝整个 binding；
6. 只递归复制 data descriptor 的 value，按 DSH 规则拒绝不合格 scalar、prototype、array、cycle；形成 detached candidate；
7. Host `JSON.parse` 后调用 `snapshotJsonValue`。只有返回非 `undefined` 且 exact checkpoint shape 合法才可提交。

必须排除 runtime-owned globals、imports、functions/classes、accessors、Proxies、symbol-named properties、exotic/non-lossless values和不符合名称/codegen规则的名字。每次 checkpoint 是符合资格 binding 的**完整替换**，不是 patch；某名称从 JSON 变成 function/Proxy/accessor 后，旧值不能在重启后复活。

普通成功和普通 program exception 都 capture：现有 Realm 会保留异常前已完成的 declarations/assignments。[`tests/realm-worker.spec.ts:87-99`](../../tests/realm-worker.spec.ts) Type-strip/syntax 在 dispatch 前失败时不 capture。[`tests/realm-worker.spec.ts:222-243`](../../tests/realm-worker.spec.ts) Timeout、abort、output-limit hard kill、worker exit、protocol violation不请求 dying Worker capture，只保留上一已提交 checkpoint。

如果改为直接对 model object 调 `snapshotJsonValue`、`JSON.stringify`，或仅凭 `throwOnSideEffect` 就开始遍历，都会执行用户 getter/Proxy trap，不能称为安全自动恢复。

## Restore 与 declaration 语义

Host 取得 per-Realm lease 后读取 checkpoint；缺失即空，JSON/shape/version 无效则不执行其中任何内容并给一次 bounded warning。合法文档经 `snapshotJsonValue` 后保存在该 `PersistentRealm` 的 Host-owned state。

新 Worker 第一次 run 先安装当前 runtime namespaces，再从 restore set 排除与 namespaces/error classes/`$_` 冲突的名字，并在用户 cell 前执行一次生成的 restore evaluation：

- lexical 项以 `replMode: true` 的 `let name = value` 恢复；
- global 项以 own data property 恢复，重建 `writable` / `enumerable` / `configurable` flags；
- 名称只来自白名单，值只来自 detached JSON 的 `JSON.stringify`；restore 成功后才执行用户 cell。

### 为什么不能全部统一成 `let`

`globalLexicalScopeNames` 不报告 `var`，但 top-level `var` 或显式 `globalThis.x = ...` 会表现为 global own data property。若也恢复成 lexical `let`，`globalThis.x` 可见性、descriptor、delete/enumeration 行为都会改变，同名 lexical 和 global property 也无法同时恢复。所以只有 lexical 类别统一 `let` 可接受。

即使如此，原 `const` 会变成可赋值；CDP 无法区分 `let` / `const` / `class`。class value 是 function，会被排除；普通 `const` JSON 值恢复为 mutable `let`。若要求 `const` assignment 仍抛错，方案 No-Go。

JSON 还会丢失共享引用：两个 binding 原来引用同一 object，恢复后是两个 detached copies；上游测试证明 snapshot 采用这种语义。[`json.spec.ts:35-49`](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/core/session/tests/json.spec.ts#L35-L49)

## Host 生命周期、fencing、预算和提示

最小正确顺序：

1. `PrimeRealmRuntime.admit` 取得现有 per-Realm lease后加载 checkpoint。
2. `PersistentRealm.ensureSession` 创建新 generation；只有首次 dispatch 携带 `restoreJson`。
3. Worker执行/capture，在 nonce-authenticated `done` 中携带完整 `checkpointJson`。
4. Host 确认 `entry.session === current session`、runId、nonce、generation 均匹配，再 parse + `snapshotJsonValue` + exact schema check。
5. 同 Realm write 串行；`revision` 只由 Host增加。旧 generation 的迟到 terminal/write 不得覆盖新 revision。
6. `writeFileAtomic` 完整替换；Realm disposal/idle reclaim 在释放 cross-process lease 前等待已接纳 write完成。
7. hard kill 仍立即终止 Worker；被杀 run 的部分 mutation 不进入 checkpoint，下一代恢复最近成功提交值，不重放 cell。

不建议首版扩展 `src/runtime.ts` 公开配置。复用现有 worker wall/compute/heap ceilings，另设少量内部固定上限：binding count、总 serialized bytes、总 graph nodes、manifest bytes。checkpoint 私有 wire/file bytes不计模型 outer output，但必须有独立 byte/node cap。现有 completion capture 已使用 byte/node 预算维度。[`src/realm/protocol.ts:52-87`](../../src/realm/protocol.ts)

模型提示复用现有 `namespaceNotice` 和 `NOTICE_RESERVE_BYTES = 512`，不新增 system-prompt 注入。runtime 已在 first actual dispatch 后 Host-side append 一条 `[prime-realm]` notice并预留512 bytes。[`src/realm/runtime.ts:43-49,109-118,244-272`](../../src/realm/runtime.ts)

一次性 manifest 只包含 restored 总数、按名字排序且在总预算内的名称、省略数，以及“detached JSON、lexical values are mutable、non-JSON state was not restored”；hard kill 后还应说明 killed-cell changes未 checkpoint。不得注入 value、serialized checkpoint、skip details或路径。未 dispatch 的 queued cancel、type-strip failure、caller misuse 不消费提示。

## 失败语义

| 情况 | 最小语义 |
|---|---|
| 名称不合规、function/import/exotic/accessor/Proxy/非 lossless JSON | 跳过该 binding；下一完整 checkpoint 不保留旧值 |
| capture 超 binding/byte/node/wall/heap 限制 | 不提交 partial checkpoint；保留上一文件；bounded warning |
| terminal 前 hard-kill | 不 capture dying heap；恢复上一提交边界 |
| checkpoint parse/version/shape/`snapshotJsonValue` 失败 | 不执行 restore source；fresh empty namespace + 一次 bounded warning |
| restore evaluation 意外失败 | 用户 cell 不执行；partial Worker hard-kill；不自动重放 cell |
| `writeFileAtomic` 失败 | 原完整文件保持可见或不存在；cell program result不改写，提示“checkpoint not updated” |
| 正常 Host/Worker 重建 | acquire lease 后读最后可见完整文件 |
| 掉电/OS crash | 允许回退到更旧 checkpoint，不宣称 latest durable |

自动持久化会把顶层 lossless-JSON 中的 token、用户数据或路径写入磁盘。`0o600`/`0o700` 只能缩小本机读取面，不能消除从 heap-only 到 persisted 的隐私变化；若产品不能明确接受，No-Go。

## 最小文件面与 focused tests

### 生产文件

1. `src/realm/protocol.ts`：run可选 restore payload；done可选 checkpoint payload；wire shape/固定预算。
2. `src/realm/realm-worker.ts`：Inspector基线；`startRun` 前 restore；terminal cleanup前 discover/capture；保持 lease撤销顺序。
3. `src/realm/realm.ts`：Host parse + `snapshotJsonValue` 最终校验；generation/revision fence；write串行/disposal await；恢复 manifest。
4. `src/realm/runtime.ts`：per-Realm checkpoint path；bounded一次性 notice；reclaim/teardown等待 write再释放 lease。
5. 唯一可选新模块 `src/realm/json-checkpoint.ts`：仅放 exact disk schema、可信 safe copier/store seam和 `writeFileAtomic` 调用；不扩成多后端/事件日志框架。

采用内部固定预算时 `src/runtime.ts` 无需改；只有决定公开 checkpoint caps 时才改配置，首版不建议。

### 只扩展两个现有测试文件

`tests/realm-worker.spec.ts`：

- lexical `let` / `const` / destructuring与新增 global own data property capture/restore；
- lexical恢复为 mutable `let`，global仍从 `globalThis` 可见且 flags保留；
- getter与Proxy trap计数均为0，binding被跳过；
- function/class/Map/Set/Date/cycle/sparse array/`undefined`/BigInt/`-0`/NaN被跳过；
- program exception前mutation可capture，syntax/type-strip failure不capture；
- 恢复后工具仍按当前run lease，`state`仍是普通用户binding，没有`$state`。

`tests/prime-runtime.spec.ts`：

- hard-kill后恢复上一成功边界，被杀cell部分mutation不出现；stale generation不能覆盖新revision；
- idle LRU、Host dispose/takeover后恢复同Realm，其他Realm隔离，pending write结束后才release lease；
- atomic write failure保留旧checkpoint，坏JSON/schema不执行；
- manifest只在first actual dispatch出现一次，只列名字不列值，超限显示省略数，总输出仍受cap；
- binding/byte/node超限不写partial file；同Realm仍串行、不同Realm仍并行。

上游 DSH 已覆盖 `snapshotJsonValue` lossless boundary和`writeFileAtomic` temp/rename/cleanup；本仓库只测本功能observable contract，不复制上游内部测试。[`json.spec.ts:16-181`](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/core/session/tests/json.spec.ts#L16-L181)、[`atomic-write.spec.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/util/atomic-write/tests/atomic-write.spec.ts)

## 最终 Go/No-Go 门槛

### Conditional Go

仅当全部接受：唯一新增可信 copier能在trap前拒绝Proxy并拒绝accessor；lexical kind不保真且统一mutable `let`；global own property独立恢复；identity/prototype/closure/function/import不恢复；hard-kill可能恢复更旧边界；atomic visibility而非power-loss durability；顶层JSON自动落盘隐私变化；严格固定caps。

### No-Go

任一成立即不值得实施：要求直接用现有` snapshotJsonValue`遍历model objects又保证零副作用；要求保真`const`/`let`/`var`/class/import kind；要求heap/object identity/closure透明恢复；要求timeout/abort前最新mutation或cell replay；要求掉电后最新checkpoint；不接受自动落盘敏感JSON；不愿为Proxy/accessor和generation-fenced write增加focused coverage。

**推荐决策：当前先 No-Go。** 产品方将“可信 Proxy rejection seam + mutable-let + 自动落盘隐私 + 非 durable”写成明确契约后，再按上述最小协议进入 Conditional Go；否则实现会在 getter/Proxy、const语义或stale write上作出错误的透明恢复承诺。
