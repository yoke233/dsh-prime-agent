# 可恢复 JavaScript 执行引擎与高保真快照方案评估

> 对应票据：[评估可恢复 JavaScript 执行引擎与高保真快照方案 #3](https://github.com/yoke233/dsh-prime-agent/issues/3)
>
> 调研日期：2026-08-29
>
> 证据范围：只使用各候选项目的官方文档、官方仓库源码、官方测试、官方发布记录与官方安全公告。
>
> 证据标记：未另行标注的事实均由紧邻官方链接直接支持；由 heap graph 或 raw-memory 实现推出、但项目未逐项承诺的结论明确标为“源码推论”，不代替产品验收。

## 结论

在本票据列出的候选中，没有一种 **Node/V8 原生方案**能够把已经运行中的 DSH Realm 当作任意时间点的检查点，随后在新进程中无损恢复顶层 lexical bindings、函数、class、closure、异步队列和 Node 原生资源。

- V8 startup snapshot、Node.js user-land startup snapshot 和 `isolated-vm.createSnapshot()` 都是“先构造、再冻结、用于初始化新实例”的 **startup image**。官方材料直接展示构建阶段的函数、class 和纯 JS 对象图可进入镜像；closure context 与 lexical environment 随可达 heap graph 保留则是源码机制推论，不是项目对各类语法状态的逐项兼容承诺。这些 API 不是普通运行中 Node Worker 的 checkpoint；Node 还明确不允许从已反序列化的 user-land snapshot 再生成 snapshot。[V8 将 snapshot 定义为预先准备的 heap 初始化镜像](https://v8.dev/blog/custom-startup-snapshots)，[Node 的 snapshot 在 builder 进程退出时生成](https://nodejs.org/api/cli.html#--build-snapshot)，并且[已从 user-land snapshot 恢复的应用不能再次 snapshot](https://nodejs.org/api/v8.html#startup-snapshot-api)。
- `node:vm` 只提供同一 V8 isolate 内的 Context 和代码缓存；它没有 Context/heap 导出 API。其 code cache 明确“不包含任何 JavaScript 可观察状态”，而结构化克隆不能克隆函数，因此无法 revival closure 或 lexical environment。[`vm.Script#createCachedData()` 文档](https://nodejs.org/api/vm.html#scriptcreatecacheddata)、[`workerData` 的 structured clone 限制](https://nodejs.org/api/worker_threads.html#new-workerfilename-options)。
- `isolated-vm` 能提供独立 V8 isolate、超时和近似内存限制，但其唯一 snapshot API 仍只接受初始化 source；维护者明确写明“不要使用”该功能，且它不受通常的 isolate 防护。它不是运行中 checkpoint 路线。[官方 snapshot 警告](https://github.com/laverdet/isolated-vm/blob/066d0106fa0b4ed020797546f13639fcda6d6e6b/README.md#L192-L226)。
- 原生 QuickJS 的 `JS_WriteObject()` 是值/bytecode 序列化器，不是 runtime/context snapshot。源码只允许未实例化的 `JS_TAG_FUNCTION_BYTECODE`，普通运行中函数属于 `JS_TAG_OBJECT`，不在支持的 object class 列表内，最终报 `unsupported object class`；top-level lexical environment 也没有公开导出 API。[QuickJS serializer 源码](https://github.com/bellard/quickjs/blob/04be246001599f5995fa2f2d8c91a0f198d3f34c/quickjs.c#L38132-L38267)。`quickjs-emscripten` 又未导出这套底层 bytecode 序列化接口，因此同样不能 checkpoint。
- 在本票据要求的“维护中、Node 可嵌入、运行中高保真恢复”范围内，本次按官方材料核对的候选中，只有 **`vercel-labs/quickjs-wasi`** 跨过了运行中 VM image 的功能门槛：它复制整个 WASM linear memory，并保存 stack pointer、runtime/context pointer 和扩展元数据；官方示例演示了序列化落盘、在另一个进程恢复以及 pending Promise 的继续执行。[实现](https://github.com/vercel-labs/quickjs-wasi/blob/54c4d2dd4be2445409aeab603ecfc3bb209c7310/src/index.ts#L2307-L2339)、[跨进程及 pending Promise 示例](https://github.com/vercel-labs/quickjs-wasi/blob/54c4d2dd4be2445409aeab603ecfc3bb209c7310/README.md#L504-L578)。**源码推论**：因为它复制并恢复同一 guest 的整个 raw memory image，lexical bindings、函数、class、closure 和对象 identity 预期会随内存保留；官方直接验证的是全局状态与 pending Promise，未见对前述每一种语言构造的逐项承诺，因此必须由原型验收。

`quickjs-wasi` 值得进入一个隔离、限时的技术原型，但 **目前不应替换产品运行时**。它在 2026 年才快速演进到 3.x；[snapshot header 与校验逻辑](https://github.com/vercel-labs/quickjs-wasi/blob/54c4d2dd4be2445409aeab603ecfc3bb209c7310/src/index.ts#L862-L923)没有将 blob 绑定到 engine/build id，也没有哈希、MAC 或签名，而 [restore 实现](https://github.com/vercel-labs/quickjs-wasi/blob/54c4d2dd4be2445409aeab603ecfc3bb209c7310/src/index.ts#L718-L776)会把外部字节覆盖到新实例内存并恢复内部指针。[3.6.0 官方发布](https://github.com/vercel-labs/quickjs-wasi/releases/tag/quickjs-wasi%403.6.0)。它还意味着从 V8/Node 语义迁移到 QuickJS-NG、重建 TypeScript 编译和 DSH binding bridge，并自行承担可信 snapshot、版本钉死、配额、原子发布和恢复失败语义。

因此当前产品决策应是：**保留现有 Node Worker/V8 live namespace 的 generation-local 契约；不采用 V8/Node/isolated-vm/QuickJS bytecode 伪装成恢复；若“崩溃后保留任意 closure/lexical state”成为硬需求，只对 `quickjs-wasi` 做带明确淘汰门槛的原型。**

## 评估口径：startup image 不等于 checkpoint

本报告把两类机制严格分开：

1. **startup image**：embedder 从一开始就以可 snapshot 模式创建 VM，执行预初始化代码，在受限且静止的边界生成启动 blob；新 VM 从该 blob 初始化。它擅长缩短启动和复制预热 heap。
2. **runtime checkpoint**：已经执行任意用户 cell 后，在不重放源码的前提下捕获当前执行环境，并在新进程恢复同一语义状态。高保真至少要求保留 lexical environment、closure 捕获值、class/prototype、对象 identity；如声称异步恢复，还必须说明 guest job queue 与 host I/O 的边界。

V8 官方说明 startup snapshot 只捕获 V8 heap，所有与外部世界的交互都在边界之外；typed-array backing store、API callback 等至少需要 embedder 特殊处理。[V8 custom startup snapshots 的限制](https://v8.dev/blog/custom-startup-snapshots)。当前 `SnapshotCreator` 也要求 embedder 显式把 default/additional Context 加入 blob，并为 object internal fields、Context embedder data 和 API wrapper 提供序列化回调；这不是自动捕获 Node/libuv 状态。[`SnapshotCreator` 当前公开 API](https://github.com/v8/v8/blob/25650aa99470f7c4a19336e71e3680d535e59896/include/v8-snapshot.h#L204-L276)。

## 总览

| 方案 | lexical / function / class / closure | 新进程 revival | async 与 Node binding | 资源控制 | 兼容与 Windows | 安全 / 维护 | 集成成本 | 官方证据 | 判断 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| V8 `SnapshotCreator` / embedded startup snapshot | 构建期、heap 可达的纯 V8 状态可保留；closure/lexical 保留是 heap 机制推论，不是任意普通 isolate API | 可，但必须使用匹配的 V8 build、external references 与反序列化回调 | 纯 guest Promise heap state 可保留是机制推论；native stack、event loop、I/O、embedder pointer 不自动恢复 | heap constraint、终止执行；OOM 仍可能 fatal | 原生 C++ build 绑定 V8 版本/flags/CPU；Windows 需自建与持续跟随 V8 | 上游活跃；blob 必须可信，heap sandbox 不是强安全边界 | 极高：等于自己成为 V8 embedder 并重建 Node/DSH host | [snapshot API](https://github.com/v8/v8/blob/25650aa99470f7c4a19336e71e3680d535e59896/include/v8-snapshot.h#L204-L276)、[资源 API](https://github.com/v8/v8/blob/25650aa99470f7c4a19336e71e3680d535e59896/include/v8-isolate.h#L54-L119)、[安全](https://v8.dev/blog/sandbox)、[Windows build](https://chromium.googlesource.com/v8/v8/+/main/docs/source-code.md) | 不采用 |
| Node startup snapshot | 构建脚本中的 JS class、函数、对象可保存；对任意 live Worker 无入口 | 可；严格绑定相同 Node 版本、平台、架构和兼容 flags/CPU | 仅部分 builtin 可 snapshot；user-land module 需 bundle；资源需 serialize/deserialize hook 重取 | 进程级 Node/V8 限制；无 per-Realm snapshot 配额 | Node 官方 Windows 支持好；blob 本身严格不跨平台/版本 | Node release line 与安全流程持续维护；能力模型不匹配 | 高：每个检查点都变成 builder 进程退出与新进程启动，不能链式 snapshot | [API](https://nodejs.org/api/v8.html#startup-snapshot-api)、[blob 兼容](https://nodejs.org/api/cli.html#--snapshot-blobpath)、[平台](https://github.com/nodejs/node/blob/05447419fbc708fbedaa7bc9740dcd242fab0d08/BUILDING.md#platform-list)、[安全](https://github.com/nodejs/node/blob/05447419fbc708fbedaa7bc9740dcd242fab0d08/SECURITY.md) | 不采用 |
| `node:vm` | 同进程 Context 活着时全部正常；没有状态导出 | 不可；code cache 无状态，structured clone 不含函数 | 最贴近 Node/DSH；Promise timeout 有可绕过/跨 queue 陷阱 | 只有单次同步执行 timeout/code generation 开关；无 per-Context memory limit | 随 Node，Windows 一等支持 | Node 核心持续维护；官方明确不是 security mechanism | 低，但没有恢复收益 | [code cache](https://nodejs.org/api/vm.html#scriptcreatecacheddata)、[async/timeout](https://nodejs.org/api/vm.html#timeout-interactions-with-asynchronous-tasks-and-promises)、[安全警告](https://nodejs.org/api/vm.html#vm-executing-javascript) | 维持 live realm，不作为恢复 |
| `isolated-vm` | live isolate 内完整；`createSnapshot` 只运行初始化 source，不捕获已有 isolate | runtime state 不可；startup blob 可用于新 isolate | Node 能力必须通过 `Reference`/`Callback`/`ExternalCopy` 桥接；支持 async API | per-run timeout；memory limit 官方称只是 guideline，攻击者可达 2–3 倍 | native addon 紧耦合 Node/V8；Windows 需 node-gyp，官方有 win32-x64 预编译资产 | maintenance mode；2026 critical escape 已修补，必须快速跟进安全版 | 中高；仍没有 checkpoint 收益 | [snapshot/资源](https://github.com/laverdet/isolated-vm/blob/066d0106fa0b4ed020797546f13639fcda6d6e6b/README.md#L184-L226)、[维护/兼容](https://github.com/laverdet/isolated-vm/blob/066d0106fa0b4ed020797546f13639fcda6d6e6b/README.md#L17-L39)、[GHSA](https://github.com/laverdet/isolated-vm/security/advisories/GHSA-864f-rcv7-6rh4)、[Windows asset](https://github.com/laverdet/isolated-vm/releases/tag/v6.0.2) | 不采用 |
| QuickJS C API | runtime 内完整；`JS_WriteObject` 不支持运行中 function object/closure，也不导出 lexical env | 值和受信 bytecode可；runtime 不可 | Promise/job queue 由 embedder驱动；没有 Node API，所有 binding 需 C bridge | runtime memory、stack limit、interrupt handler | bytecode 绑定 QuickJS 版本；原版 Windows 仅初步 MinGW 交叉编译 | 官方版本仍更新；bytecode 不做恶意输入校验 | 极高，且行为兼容下降 | [serializer](https://github.com/bellard/quickjs/blob/04be246001599f5995fa2f2d8c91a0f198d3f34c/quickjs.c#L38132-L38267)、[资源/bytecode](https://bellard.org/quickjs/quickjs.html)、[Windows](https://github.com/bellard/quickjs/blob/04be246001599f5995fa2f2d8c91a0f198d3f34c/doc/quickjs.texi#L2242-L2264) | 不采用 |
| `quickjs-emscripten` | live WASM runtime 内完整；公开 API 无 runtime snapshot | 不可 | host function/Promise bridge；Asyncify 允许 host async，但只能同时 suspend 一次且更慢更大 | memory、stack、interrupt API | WebAssembly 跨平台，Node >=16；Windows 随标准 Node/WASM host | 项目 <1.0、未审计、业余维护 | 高，且无恢复收益 | [Runtime API](https://github.com/justjake/quickjs-emscripten/blob/7b7af98e4e69757c64c27aac46a74e1e07229545/doc/quickjs-emscripten/classes/QuickJSRuntime.md#methods)、[Asyncify](https://github.com/justjake/quickjs-emscripten/blob/7b7af98e4e69757c64c27aac46a74e1e07229545/README.md#L428-L477)、[平台/状态](https://github.com/justjake/quickjs-emscripten/blob/7b7af98e4e69757c64c27aac46a74e1e07229545/README.md#L796-L844) | 不采用 |
| `quickjs-wasi` | **源码推论**：raw linear memory 预期保留 lexical、closure、class 与 identity；官方未逐项承诺 | **可**：官方示例持久化并在另一进程 restore | guest pending Promise 已有官方测试；host I/O 不在 image，host callback 必须按 name 重注册；无 Node API | memory limit、interrupt、max stack；3.3.1–3.6.0 才连续修正 limit/OOM/stack 边界 | 同一 WASM artifact 理论跨 OS/CPU；官方未承诺跨 build 或 Windows CI | 发布活跃，但 raw-memory image 是新的高风险信任/兼容面 | 很高：换引擎、TS 编译、全部 DSH bridge、snapshot store/security | [snapshot/restore](https://github.com/vercel-labs/quickjs-wasi/blob/54c4d2dd4be2445409aeab603ecfc3bb209c7310/src/index.ts#L718-L776)、[pending Promise/跨进程](https://github.com/vercel-labs/quickjs-wasi/blob/54c4d2dd4be2445409aeab603ecfc3bb209c7310/README.md#L504-L578)、[3.3.1](https://github.com/vercel-labs/quickjs-wasi/releases/tag/quickjs-wasi%403.3.1)、[3.5.0](https://github.com/vercel-labs/quickjs-wasi/releases/tag/quickjs-wasi%403.5.0)、[3.6.0](https://github.com/vercel-labs/quickjs-wasi/releases/tag/quickjs-wasi%403.6.0) | 只做隔离原型 |

## 逐项分析

### 1. V8 startup / embedded snapshot

#### 保真度

V8 `SnapshotCreator` 能把 default Context 和额外 Context 放进 blob，并可选择保留 compiled function code；V8 官方的说明是反序列化后的 Context 是拍摄来源的“exact copies”，预定义函数不必再次执行源码。[V8 官方介绍](https://v8.dev/blog/custom-startup-snapshots)、[`SnapshotCreator::SetDefaultContext` / `AddContext` / `CreateBlob`](https://github.com/v8/v8/blob/25650aa99470f7c4a19336e71e3680d535e59896/include/v8-snapshot.h#L204-L276)。**源码机制推论**：若 embedder 从启动就由 `SnapshotCreator` 持有 isolate，并在静止点生成 blob，则 heap 中可达的纯 JS closure context 与 lexical environment 预期会随 Context 恢复；V8 的公开文档并未把每类 lexical/closure 状态列为独立兼容契约。

这仍不是透明进程 checkpoint：

- API 的基本生命周期是“创建用于 serialization 的 isolate → 设置要包含的 Context → `CreateBlob()`”，而不是把一个任意 Node Worker attach 到 serializer。[构造与所有权约束](https://github.com/v8/v8/blob/25650aa99470f7c4a19336e71e3680d535e59896/include/v8-snapshot.h#L127-L177)。
- snapshot 只覆盖 V8 heap。embedder internal field、Context data、C++ wrapper 都需要回调；任意外部 pointer、文件描述符、socket、libuv request、线程和 host promise 都不由 V8 恢复。[字段序列化回调契约](https://github.com/v8/v8/blob/25650aa99470f7c4a19336e71e3680d535e59896/include/v8-snapshot.h#L39-L125)。
- startup blob 必须是可信输入；V8 在 `CreateParams` 中直接要求 embedder 保证 snapshot 来自 trusted source。[`Isolate::CreateParams` 源码](https://github.com/v8/v8/blob/25650aa99470f7c4a19336e71e3680d535e59896/include/v8-isolate.h#L300-L324)。

#### async、资源和安全

**机制推论**：纯 guest Promise/async function 的 heap 对象可随 heap image 存在，但 V8 的 microtask queue、foreground task 调度和所有 I/O 都由 embedder管理；官方 embedding 文档明确由应用负责 Context、模板、C++ callback 与平台集成。[V8 embedding guide](https://v8.dev/docs/embed)。因此，即使一个 pending Promise 对象被保留，也不能由此推出原来等待的 Node I/O 会继续。

V8 提供启动前 heap hard limit、stack limit 和跨线程 `TerminateExecution()`；达到 heap hard limit 且 GC/near-limit callback 无法腾挪时，契约是 `FatalProcessOutOfMemory`，仍需要进程级隔离。[`ResourceConstraints`](https://github.com/v8/v8/blob/25650aa99470f7c4a19336e71e3680d535e59896/include/v8-isolate.h#L54-L119)、[`TerminateExecution`](https://github.com/v8/v8/blob/25650aa99470f7c4a19336e71e3680d535e59896/include/v8-isolate.h#L1270-L1314)。V8 heap sandbox 已是维护中的安全机制，但官方仍称它尚有工作才能成为 strong security boundary，不能替代 OS 进程隔离。[V8 Sandbox 官方说明](https://v8.dev/blog/sandbox)。

#### 产品成本

直接嵌入 V8 会失去 Node Worker、Node module/runtime、libuv、N-API 与现有 TypeScript/DSH binding 的免费承载。团队需要自己维护 V8 build、platform task runner、microtask policy、module loader、inspector、external references、wrapper serialization、OOM/termination、Windows toolchain和安全更新；V8 官方的源码获取说明对 Windows 明确要求 Git、Visual Studio、Windows debugging tools 和 `depot_tools`，构建还需生成 GN 配置并编译。[官方 source checkout 说明](https://chromium.googlesource.com/v8/v8/+/main/docs/source-code.md)、[官方 build 说明](https://chromium.googlesource.com/v8/v8/+/refs/heads/main/docs/build.md)。即使能生成高保真纯 V8 heap startup blob，Node/DSH binding 仍必须另做可重绑描述符。因此它不是合理的 dsh-prime-agent seam。

### 2. Node.js startup snapshot

#### 能保存什么

Node 的 builder 会运行单一入口，并在进程退出时生成 blob。官方 `v8.startupSnapshot` 示例把用户定义的 `BookShelf` class、`Map`、Buffer 数据、静态方法和 deserialize main function 一并保存；serialize/deserialize callback 用于在边界两侧压缩、恢复和重取状态。[Startup Snapshot API 示例](https://nodejs.org/api/v8.html#startup-snapshot-api)。这直接证明构建阶段的用户 function/class 和纯 JS 对象图可恢复；**机制推论**：通过 continuation callback 或显式 data 保持可达的 lexical/closure state 也应随镜像恢复，但该官方示例没有对此逐项验证。

但它不能承接当前 live Realm：

- 构建模式只能加载一个入口；该入口只能直接加载 builtin module，不能加载额外 user-land module，官方建议先 bundle。只有一部分 builtin 被验证可序列化，遇到不支持的 builtin 甚至可能使 builder crash。[`--build-snapshot` 限制](https://nodejs.org/api/cli.html#--build-snapshot)。
- 已从 user-land snapshot 启动的应用不能再次 snapshot。[Startup Snapshot API 尾部限制](https://nodejs.org/api/v8.html#startup-snapshot-api)。所以它不能形成“运行一段 → checkpoint → 恢复 → 再 checkpoint”的持续链。
- Node 只刷新明确处理的运行时状态，例如示例中的 `process.env` 与 `process.argv`；其他 native/host resource 需要在 deserialize callback 重建。[官方示例](https://nodejs.org/api/v8.html#startup-snapshot-api)。

#### 兼容、平台和维护

加载 blob 时，Node 要求生成与加载端的 Node 版本、架构、平台完全相同，并检查 V8 flags 与 CPU feature 兼容；不匹配就拒绝。[`--snapshot-blob`](https://nodejs.org/api/cli.html#--snapshot-blobpath)。截至调研日，builder 已在 Node 24.13.1/25.4.0 标记为非实验，但 `--snapshot-blob` 加载开关本身仍标为 Experimental。[同一 CLI 文档](https://nodejs.org/api/cli.html#--snapshot-blobpath)。

Node 对 Windows x64 是 Tier 1、Windows arm64 是 Tier 2，并发布官方二进制；核心 runtime、V8 和 snapshot 随受支持 release line 接收安全修复。[Node 平台表](https://github.com/nodejs/node/blob/05447419fbc708fbedaa7bc9740dcd242fab0d08/BUILDING.md#platform-list)、[Node release/LTS 规则](https://nodejs.org/en/about/previous-releases)、[安全报告流程](https://github.com/nodejs/node/blob/05447419fbc708fbedaa7bc9740dcd242fab0d08/SECURITY.md)。维护质量是候选中最高的，问题在于能力模型与 ticket 不匹配。

### 3. `node:vm`

#### live 语义与 revival

同一 `vm.Context` 活着时，它确实提供独立 global environment，并可用同一 context 连续运行脚本；函数、class、closure 和 lexical bindings 由 V8 正常保留。[Contextification 说明](https://nodejs.org/api/vm.html#what-does-it-mean-to-contextify-an-object)、[`runInContext()` 示例](https://nodejs.org/api/vm.html#vmrunincontextcode-contextifiedobject-options)。这与长期 Worker 内 live Realm 的方向相容。

但公开持久化面只有两类，均不够：

- `vm.Script#createCachedData()` 只保存编译 metadata；官方明确写明不含任何 JavaScript observable state。[文档](https://nodejs.org/api/vm.html#scriptcreatecacheddata)。
- Node 的值序列化/Worker 消息采用 structured clone；含 function 的对象会抛 `DataCloneError`。[Worker 文档](https://nodejs.org/api/worker_threads.html#new-workerfilename-options)。即使手工枚举 global property，函数、prototype、alias、closure、Promise 和不可枚举 lexical binding 仍无法无损恢复。

#### async、资源和安全

`timeout` 只限制一次执行。Promise microtask 默认能在返回后逃逸 timeout；`microtaskMode: 'afterEvaluate'` 可把 inner queue 纳入本次 timeout，却会导致跨 Context Promise 不能自动推进，且注入 `setTimeout`、`setImmediate`、`process.nextTick` 等后回调进入共享 global queue，仍不受该 timeout 控制。[Node 官方 timeout/microtask 章节](https://nodejs.org/api/vm.html#timeout-interactions-with-asynchronous-tasks-and-promises)。

`node:vm` 没有 per-Context heap limit，所有 Context 仍共享 isolate/进程；`contextCodeGeneration` 能限制 string/Wasm code generation，但 Node 开篇明确声明 `node:vm` 不是 security mechanism。[官方警告与 API](https://nodejs.org/api/vm.html#vm-executing-javascript)。它适合作为 live execution primitive，不是 crash recovery primitive。

### 4. `isolated-vm`

#### live 能力与 snapshot 实质

`isolated-vm` 为 Node 暴露真正的 V8 `Isolate`，一个 context 活着期间可以完整保存 lexical/function/class/closure。跨 isolate 只能传 transferable primitive/value，复杂能力通过 `Reference`、`Callback` 和 `ExternalCopy`；async API 在独立 thread pool 排队执行。[官方 API 总述](https://github.com/laverdet/isolated-vm/blob/066d0106fa0b4ed020797546f13639fcda6d6e6b/README.md#L141-L173)。

`createSnapshot(scripts, warmup_script)` 是静态方法，只接收初始化源码，并把 blob 传给新 `Isolate({ snapshot })`。没有“对现有 isolate 调用 snapshot”的实例 API。维护者明确说该能力从未稳定、随 V8 变化越来越不稳定，并建议只定义 function、class 和简单数据；snapshot 构建时无限循环会卡死进程，过量内存会使进程崩溃。[官方 API 与警告](https://github.com/laverdet/isolated-vm/blob/066d0106fa0b4ed020797546f13639fcda6d6e6b/README.md#L184-L226)。因此它最多是较薄的 V8 startup image wrapper。

#### 资源、安全、兼容和 Windows

每次 `script.run` / `module.evaluate` 可设 timeout，isolate 可设 `memoryLimit`。官方同时明确 memory limit 只是 guideline，恶意脚本在终止前可使用设定值的 2–3 倍；catastrophic error 后建议停止服务并 `process.abort()`。[Isolate options](https://github.com/laverdet/isolated-vm/blob/066d0106fa0b4ed020797546f13639fcda6d6e6b/README.md#L184-L210)。

安全性高度依赖 bridge：把 `Reference`/`ExternalCopy` 暴露给不可信代码通常足以回到 Node isolate，官方建议把 `isolated-vm` 放在不同 Node 进程。[安全章节](https://github.com/laverdet/isolated-vm/blob/066d0106fa0b4ed020797546f13639fcda6d6e6b/README.md#L107-L138)。2026-08-07 项目披露了可由 guest 通过一个 `Reference` 触发的 critical type confusion/sandbox escape，影响 `<=7.0.0`，修复版为 7.0.1 与 6.2.0；这说明必须快速跟随项目补丁，不能把 isolate 当最终安全边界。[官方 GHSA](https://github.com/laverdet/isolated-vm/security/advisories/GHSA-864f-rcv7-6rh4)、[7.0.1 发布](https://github.com/laverdet/isolated-vm/releases/tag/v7.0.1)、[6.2.0 发布](https://github.com/laverdet/isolated-vm/releases/tag/v6.2.0)。

项目当前明确处于 maintenance mode；版本必须与 Node/V8 主版本配套，Node 20+ 还要求以 `--no-node-snapshot` 启动。[状态与兼容矩阵](https://github.com/laverdet/isolated-vm/blob/066d0106fa0b4ed020797546f13639fcda6d6e6b/README.md#L17-L39)、[安装要求](https://github.com/laverdet/isolated-vm/blob/066d0106fa0b4ed020797546f13639fcda6d6e6b/README.md#L69-L85)。Windows 有 node-gyp 构建说明，官方 6.0.2 release 也发布了 win32-x64 预编译资产，但 native addon ABI 与工具链成本显著高于纯 Node。[6.0.2 官方发布](https://github.com/laverdet/isolated-vm/releases/tag/v6.0.2)。

### 5. QuickJS C API 与 `quickjs-emscripten`

#### 原生 QuickJS

QuickJS 是小型可嵌入解释器，当前官方文档称支持大部分 ES2025；一个 `JSRuntime` 是一个 object heap，多个 runtime 不能交换对象，runtime 内不支持多线程。[官方特性与 runtime 文档](https://bellard.org/quickjs/quickjs.html#Introduction)、[C API runtime/context](https://bellard.org/quickjs/quickjs.html#Runtime-and-contexts)。它有 Promise、async function、module 和 job queue，但没有 Node API。

其公开持久化机制不能替代 heap snapshot：

- `JS_WriteObject` / `JS_ReadObject` 可允许 function/module bytecode 和 object references，但 serializer 源码把实例化后的普通 function/class object 落入 `JS_TAG_OBJECT`，支持列表只有 Array、plain Object、ArrayBuffer、Date、boxed primitive、TypedArray 等；其他 class 抛错。[header flags](https://github.com/bellard/quickjs/blob/04be246001599f5995fa2f2d8c91a0f198d3f34c/quickjs.h#L979-L1002)、[writer switch](https://github.com/bellard/quickjs/blob/04be246001599f5995fa2f2d8c91a0f198d3f34c/quickjs.c#L38132-L38267)。
- 未实例化 bytecode 与带环境的 closure 不等价；公开 API 也没有枚举/导出 Context lexical environment 或整个 `JSRuntime` 的函数。
- bytecode 格式绑定具体 QuickJS 版本，执行前不做安全检查，官方禁止加载不可信 bytecode。[QuickJS 文档](https://bellard.org/quickjs/quickjs.html#Script-evaluation)。

资源控制优于 `node:vm`：`JS_SetMemoryLimit()` 限制 runtime 全局分配，`JS_SetMaxStackSize()` 限制 stack，`JS_SetInterruptHandler()` 可实现 timeout。[官方 C API](https://bellard.org/quickjs/quickjs.html#Memory-handling)。Windows 方面，Bellard 原版文档只承诺在 Linux host 上通过 MinGW 交叉编译的 preliminary support。[官方安装说明](https://github.com/bellard/quickjs/blob/04be246001599f5995fa2f2d8c91a0f198d3f34c/doc/quickjs.texi#L2242-L2264)。

#### `quickjs-emscripten`

`quickjs-emscripten` 把 QuickJS 编译为 WASM，提供 Context/handle/host function、memory/stack/interrupt 和 module loader。Context 活着时隔离且完整；但官方生成的 `QuickJSRuntime` API 方法清单只包含 context、job、module loader、memory/stack/interrupt 等 live-runtime 操作，没有文档化的 runtime snapshot/export/restore 契约，因此不能据此实现 revival。[官方 `QuickJSRuntime` API 方法清单](https://github.com/justjake/quickjs-emscripten/blob/7b7af98e4e69757c64c27aac46a74e1e07229545/doc/quickjs-emscripten/classes/QuickJSRuntime.md#methods)、[Runtime 使用文档](https://github.com/justjake/quickjs-emscripten/blob/7b7af98e4e69757c64c27aac46a74e1e07229545/README.md#L112-L174)。

普通 guest Promise 可用；若 host callback 自身需要异步暂停，则要使用 Asyncify build。官方列出的限制是同一 WASM module 同时只能 suspend 等待一个异步调用，再次 suspend 会 crash；Asyncify 产物约 2 倍大且更慢。[Asyncify 说明](https://github.com/justjake/quickjs-emscripten/blob/7b7af98e4e69757c64c27aac46a74e1e07229545/README.md#L428-L477)。

WASM 使 Windows 部署比原生 QuickJS 简单：项目声称支持任何 ES2020 host，Node 要求 >=16。[平台说明](https://github.com/justjake/quickjs-emscripten/blob/7b7af98e4e69757c64c27aac46a74e1e07229545/README.md#L796-L811)。但项目仍 <1.0、会有 breaking API change、未经过安全审计且由维护者业余维护。[项目状态](https://github.com/justjake/quickjs-emscripten/blob/7b7af98e4e69757c64c27aac46a74e1e07229545/README.md#L835-L844)。它引入了明显语义与桥接成本，却没有解决本 ticket 的 checkpoint，故排除。

### 6. `quickjs-wasi`：本票据“维护中、Node 可嵌入、运行中高保真”候选中唯一通过功能门槛的近似方案

#### 为什么它不同

`quickjs-wasi` 不依赖 QuickJS 的 value/bytecode serializer。`snapshot()` 直接复制整个 `WebAssembly.Memory`，同时记录 `__stack_pointer`、QuickJS runtime/context pointer 和扩展位置；restore 先实例化相同 WASM/扩展、增长内存，再覆盖完整 linear memory并恢复内部指针。[snapshot 实现](https://github.com/vercel-labs/quickjs-wasi/blob/54c4d2dd4be2445409aeab603ecfc3bb209c7310/src/index.ts#L2307-L2330)、[restore 实现](https://github.com/vercel-labs/quickjs-wasi/blob/54c4d2dd4be2445409aeab603ecfc3bb209c7310/src/index.ts#L718-L776)。

基于该实现，可以区分官方直接验证的行为与源码推论：

- **源码推论，待原型验收**：lexical environment、function/class object、closure 捕获 cell、prototype、alias/cycle 和 symbol/atom table 均存于被整体复制的 guest linear memory 中，因而预期不需要逐值重建。项目官方测试未对这些语言构造逐项做恢复契约。[snapshot 复制整个 `memory.buffer` 的源码](https://github.com/vercel-labs/quickjs-wasi/blob/54c4d2dd4be2445409aeab603ecfc3bb209c7310/src/index.ts#L2307-L2330)。
- 官方直接验证了一个 pending Promise 经 serialize → deserialize → restore 后，保存的 resolver 可继续解析并运行 `.then`；这支持该例的 guest Promise/job 状态可恢复，不等于对任意 job queue 或 host I/O 的普遍承诺。[README 示例](https://github.com/vercel-labs/quickjs-wasi/blob/54c4d2dd4be2445409aeab603ecfc3bb209c7310/README.md#L504-L552)、[官方 snapshot test](https://github.com/vercel-labs/quickjs-wasi/blob/54c4d2dd4be2445409aeab603ecfc3bb209c7310/test/snapshot.test.ts#L130-L155)。
- blob 可落存储并由另一个进程恢复；它不是 startup-only 预热图，而是运行中 VM image。[README](https://github.com/vercel-labs/quickjs-wasi/blob/54c4d2dd4be2445409aeab603ecfc3bb209c7310/README.md#L526-L552)。

#### async 与 DSH binding 边界

快照只保存 guest：Node 的 DNS/fetch/文件/DSH tool promise 仍在 host event loop，不会随 WASM memory 复制。产品必须只在没有 in-flight host call 的 quiescent boundary 落盘，或者把每个外部操作变成可持久化 operation id，在恢复后由 host 重新关联/重试。官方 async host 示例本身就是“host 完成 I/O → 调用 guest deferred → 手工 `executePendingJobs()`”，说明两侧 lifecycle 是分开的。[Promises/async host function 示例](https://github.com/vercel-labs/quickjs-wasi/blob/54c4d2dd4be2445409aeab603ecfc3bb209c7310/README.md#L260-L286)。

host-backed function 在 snapshot 中只保留 name；restore 后必须按同名重新注册，未注册 callback 不能继续工作。[Host callback restore](https://github.com/vercel-labs/quickjs-wasi/blob/54c4d2dd4be2445409aeab603ecfc3bb209c7310/README.md#L553-L578)。这可以映射 DSH 的 per-run lease，但不能直接沿用当前 V8 Proxy：需要设计一个最小 dispatch ABI、每轮重绑、撤销旧 lease、JSON/handle marshalling、错误/取消、并发、日志和 approval 传播。

Node 内建模块不在 guest。项目只随包提供 URL、Encoding、Headers、Crypto、Structured Clone 五个 WASM extension；其他 Node/DSH 能力仍要经 host callback。[扩展列表](https://github.com/vercel-labs/quickjs-wasi/blob/54c4d2dd4be2445409aeab603ecfc3bb209c7310/README.md#L579-L624)。TypeScript 也必须在 host 先编译为 QuickJS-NG 可执行 JavaScript。

#### 资源、兼容和安全风险

项目提供 memory limit、interrupt handler；interrupt 后 VM 仍可继续使用。3.6.0 又加入 `maxStackSize`，使 guest stack overflow 能作为 guest error处理而不是耗尽物理 WASM stack。[限制 API](https://github.com/vercel-labs/quickjs-wasi/blob/54c4d2dd4be2445409aeab603ecfc3bb209c7310/README.md#L438-L475)、[3.6.0 发布说明](https://github.com/vercel-labs/quickjs-wasi/releases/tag/quickjs-wasi%403.6.0)。但这些边界刚经过实质修复：3.3.1 才修正 memory limit 实际不计算 retained allocations 的问题，3.5.0 又修复 limit 下无法构造 OOM error。[3.3.1 官方发布](https://github.com/vercel-labs/quickjs-wasi/releases/tag/quickjs-wasi%403.3.1)、[3.5.0 官方发布](https://github.com/vercel-labs/quickjs-wasi/releases/tag/quickjs-wasi%403.5.0)。这证明维护活跃，也证明当前成熟度不足以跳过独立验证。

最关键的是 snapshot 信任与兼容：

- 序列化 header 只有 `QJSS` magic、格式版本、memory size、stack/runtime/context pointer 和 extension metadata；没有 QuickJS-NG version、`quickjs-wasi` version、WASM digest/build id、checksum、MAC 或签名。[格式定义与反序列化](https://github.com/vercel-labs/quickjs-wasi/blob/54c4d2dd4be2445409aeab603ecfc3bb209c7310/src/index.ts#L500-L550)、[校验实现](https://github.com/vercel-labs/quickjs-wasi/blob/54c4d2dd4be2445409aeab603ecfc3bb209c7310/src/index.ts#L862-L923)。
- restore 会按 snapshot 声称的大小增长内存，直接复制 bytes，再把其中的 pointer 设为 runtime/context。[restore 源码](https://github.com/vercel-labs/quickjs-wasi/blob/54c4d2dd4be2445409aeab603ecfc3bb209c7310/src/index.ts#L734-L774)。因此 blob 必须按“可信可执行运行时状态”处理；仅靠格式 version 不能安全接收用户输入，也不能证明跨 package/engine build 兼容。
- 因为 artifact 是 WASM32 image，同一 `quickjs.wasm` bytes 在不同 Node host/OS 上具有跨架构潜力；官方只演示“different process entirely”，没有承诺跨 OS、跨 package version 或跨 QuickJS-NG build。产品契约应保守限定为 **同一 WASM SHA-256、同一 extension digest/顺序、同一 snapshot schema**，任何不匹配 fail closed。
- 项目在 3.3.1、3.5.0 到 3.6.0 间持续发布，3.5.0 又将 QuickJS-NG 更新到含 correctness/security fixes 的 0.16.2。[3.3.1](https://github.com/vercel-labs/quickjs-wasi/releases/tag/quickjs-wasi%403.3.1)、[3.5.0](https://github.com/vercel-labs/quickjs-wasi/releases/tag/quickjs-wasi%403.5.0)、[3.6.0](https://github.com/vercel-labs/quickjs-wasi/releases/tag/quickjs-wasi%403.6.0)。QuickJS-NG 本身有私密漏洞报告政策、明确把恶意 bytecode 排除在安全边界外，并持续跨 50 余配置测试；但 raw memory snapshot 是 `quickjs-wasi` 自己增加的新攻击面。[QuickJS-NG 安全政策](https://github.com/quickjs-ng/quickjs/blob/5cbbc675f13067ae2113b2ccacbdd05db2595496/SECURITY.md)、[维护与测试说明](https://quickjs-ng.github.io/quickjs/diff/)。

Windows 运行不依赖 native addon：包交付 WASM，调用者显式提供 bytes/预编译 `WebAssembly.Module`，Node 负责 WebAssembly host。[加载方式](https://github.com/vercel-labs/quickjs-wasi/blob/54c4d2dd4be2445409aeab603ecfc3bb209c7310/README.md#L179-L208)。这是 Windows 部署优势；但仓库没有把 Windows 列为单独测试/支持契约，必须在产品原型中实测，而不能从“WASM 可加载”推导所有 filesystem、extension、timeout、OOM 和 snapshot 行为已受支持。

## 对产品设计的建议

### 现在不改运行时

继续把 live namespace 定义为 Worker generation 内状态，hard kill/host restart 后显式 namespace loss。对必须恢复的进度继续使用显式、受约束的应用数据或工作区文件。不要尝试以下伪高保真路径：

- 枚举 `globalThis` + `v8.serialize()`：丢 lexical binding、function/closure、prototype/descriptor和 host handle。
- 保存 `vm.Script`/QuickJS bytecode：只保存代码/编译 metadata，不保存实例化 closure environment。
- 把历史 cell 自动重放包装成 snapshot：effectful tool/I/O 会重复，且 nondeterminism 与 partial commit 无法透明消除。
- 用 Node/V8 startup blob 为每个 Realm 滚动 checkpoint：Node 不能链式 user-land re-snapshot，平台/版本严格绑定，资源重绑边界也不成立。

### 若立项原型，只验证 `quickjs-wasi`

原型必须是独立 runtime adapter，不修改当前 V8 路径，并以以下门槛决定是否淘汰：

1. **语义保真**：跨进程验证 `let`/`const`/`var`、function、class/private field、nested closure、alias/cycle、Map/Set/typed array、symbol、module namespace、top-level await、pending guest Promise；与当前 TypeScript cell lowering 的重声明和 completion 语义逐项对齐。
2. **bridge 不变量**：仅一个 host dispatch capability；每 run lease；旧 function 在 lease 撤销后失败；restore 后只按可信 catalog 重注册；参数/结果、错误、取消、approval、日志和输出上限保持现有 DSH 所有权。
3. **quiescence**：snapshot 前必须证明无 active host call、无未结算 bridge promise、无正在执行 guest frame；pending 外部 operation 必须先持久化 id，恢复后去重继续，不能复制 Node promise。
4. **可信 blob**：在项目格式外包一层 manifest，至少含 snapshot schema、`quickjs-wasi` version、QuickJS-NG version、main WASM SHA-256、各 extension SHA-256/顺序、Realm identity、长度和 MAC；任何字段、大小、MAC 或 digest 不匹配 fail closed。blob 只允许由拥有该 Realm 的 host 写入和读取。
5. **资源与失败**：在 Windows/Linux 覆盖超大 snapshot、截断/篡改 header、伪造 pointer/extension metadata、OOM、stack overflow、infinite loop、restore interrupt、进程中断时原子发布、配额/LRU、旧版本拒绝以及坏 snapshot 不影响其他 Realm。
6. **成本门槛**：测量 full linear-memory image 的原始/压缩大小、snapshot/restore 延迟、峰值双份内存和高频 checkpoint 写放大；源码确认 `snapshot()` 复制的是整个 `memory.buffer` 而非 live heap。[实现](https://github.com/vercel-labs/quickjs-wasi/blob/54c4d2dd4be2445409aeab603ecfc3bb209c7310/src/index.ts#L2309-L2324)。
7. **发布边界**：engine artifact 与 snapshot format 必须作为同一个不可分割版本发布；升级不做隐式兼容迁移，旧 blob 明确失效或由旧 runtime 完成一次受控导出。

只有上述门槛全部通过，并且真实任务显示 crash recovery 的收益足以抵消 V8→QuickJS-NG 兼容差异、全新 bridge 和 snapshot storage 的长期成本，才应把该路线升级为产品设计。否则，当前 generation-local live namespace 加显式持久数据仍是更简单、可验证且安全边界更清楚的实现。
