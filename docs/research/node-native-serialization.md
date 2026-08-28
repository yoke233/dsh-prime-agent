# Node.js 原生序列化与结构化克隆能力评估

> Wayfinder 工单：[评估 Node.js 原生序列化与结构化克隆能力](https://github.com/yoke233/dsh-prime-agent/issues/2)
> 调研日期：2026-08-28
> 基线：Node.js 24.18.0、其内置 V8、WHATWG HTML Living Standard

## 结论

在候选原生 API 中，**`node:v8.serialize()` / `deserialize()` 最适合作为第一版 Restorable Binding 的二进制编码底座，但只能承诺恢复一个显式白名单内的“可恢复数据图”，不能承诺恢复任意 Realm binding。** 理由是它与结构化克隆的数据模型相容，同时唯一明确提供可落盘的 `Buffer` 和向后兼容的 wire format；相等值不保证产生相同字节，新格式也不保证可被旧运行时读取。[Node.js 的 Serialization API](https://nodejs.org/download/release/v24.18.0/docs/api/v8.html#serialization-api)明确给出这些保证；V8/Node 对一次 wire-format 升级的说明也明确指出 deserializer **不向前兼容**，[旧 Node 无法读取新 V8 产生的数据](https://github.com/nodejs/node/issues/42192)。

这项选择不扩大当前安全边界：

- `structuredClone()` 适合做同进程内存副本，不产生持久化字节；再次调用 `serialize()` 会再次遍历对象并可能再次触发 getter，因此不应把它当作 `v8.serialize()` 的预检阶段。Node 从 v17.0.0 提供稳定的 WHATWG [`structuredClone`](https://nodejs.org/download/release/v24.18.0/docs/api/globals.html#structuredclonevalue-options)。
- Worker messaging 是进程内传输协议，不是持久化格式。它增加了可转移 native handle，但 handle 的含义是转移活资源的所有权，不是重建资源；它也没有跨 Node/V8 版本的磁盘恢复契约。[`MessagePort.postMessage()`](https://nodejs.org/download/release/v24.18.0/docs/api/worker_threads.html#portpostmessagevalue-transferlist)列出了精确的 clone/transfer 范围。
- 函数、class 构造器、closure、Proxy、module namespace、Promise/WeakMap 等均不能由这三条路径恢复。class instance 即便克隆成功，也只剩普通对象的 enumerable own string-keyed 数据；prototype、私有字段、方法、accessor 和 descriptor 都丢失。[Node Worker 文档](https://nodejs.org/download/release/v24.18.0/docs/api/worker_threads.html#considerations-when-cloning-objects-with-prototypes-classes-and-accessors)对此有直接示例。
- 任何 native serializer 都不替代本仓库的 Realm identity、binding lease、nonce、权限、sandbox、取消和生命周期所有权。恢复结果只能是 Worker 内的无权限数据；`tools` 等 leased Proxy 必须由新 generation 按当前 run 重新注入。

如果第一版只需要恢复本仓库现有 host bridge 已接受的值，**显式 lossless JSON schema 仍是比扩大到结构化克隆全集更小、更强的产品契约**。`node:v8` 的价值在于未来确有需求时，可在同一安全外壳内增加 BigInt、Map/Set、循环/共享关系和 typed arrays；不能因底层“能编码”就把这些类型自动纳入公开保证。

## 本仓库约束

当前 TypeScript Realm 不是 `node:vm` 中可随时复制的对象，而是每个 Session/Realm 对应一个长期 Worker generation 内的 live V8 namespace：顶层函数、class、闭包、对象 identity 和稳定 Proxy 只在该 generation 中存在；hard kill 或 host restart 后 namespace 为空。[架构说明](../architecture.md#persistent-realm)和 [Worker 创建代码](../../src/realm/realm.ts#L877-L926)分别记录了这一契约与 `maxOldGenerationSizeMb` 限制。

Host bridge 刻意比结构化克隆更窄：binding arguments 和 resolution 必须是 lossless JSON，Worker 与 Host 之间传的是 nonce-authenticated JSON 字符串，而不是任意 `postMessage` 值；函数和 native handle 只能留在 Worker heap。[binding lease 契约](../architecture.md#binding-lease)、[Worker 出站校验](../../src/realm/realm-worker.ts#L584-L607)、[Host 入站/回包校验](../../src/realm/realm.ts#L1120-L1152)和[私有协议](../../src/realm/protocol.ts#L311-L359)共同构成这个边界。

控制通道虽然基于 `MessageChannel`，仍须防御同一 isolate 中的模型程序污染 built-in prototype。现有 Worker 在模型代码运行前捕获私有 port 的原始 `postMessage` 并删除 `workerData.port` 引用，[避免程序改写 `MessagePort.prototype.postMessage` 后取得或伪造控制通道](../../src/realm/realm-worker.ts#L83-L102)。因此，“Node 能 clone/transfer 某值”不等于“该值可安全进入本仓库协议”。

Restorable Binding 若落地，必须维持以下不变量：

1. 恢复的是普通数据 graph，不是旧 Worker 的 heap、代码、authority 或 lease。
2. binding 名称和持久化记录归属仍由可信 Realm identity 决定；记录内容不得自报 Session/Realm 身份。
3. 新 generation 先建立当前 schema 和 lease，再把获准数据装入 namespace；绝不从持久化内容恢复 `tools`、`agents`、`jobs`、`refine`、错误类构造器或控制 port。
4. 恢复失败必须 fail closed 且保持原子性；不能部分安装 namespace，也不能把损坏记录降级为可执行源码或重放历史 cell。

## 共同的结构化克隆模型

WHATWG 的 structured serialization 先把值转换成与 Realm 无关的记录，再在 target Realm 创建新值；算法的 `memory` map 明确用于保留循环和 graph 中重复对象的 identity。[StructuredSerializeInternal](https://html.spec.whatwg.org/multipage/structured-data.html#structuredserializeinternal)和 [StructuredDeserialize](https://html.spec.whatwg.org/multipage/structured-data.html#structureddeserialize)给出了这两项保证。`structuredClone`、Worker messaging 与 V8 ValueSerializer 的核心值语义因此大体一致，但 Node embedder 对 host object、Buffer、WebAssembly 和 transferable 有不同扩展。

### 值与关系矩阵

| 值或性质 | `structuredClone` | `node:v8` serialize/deserialize | Worker messaging | Restorable Binding 判断 |
| --- | --- | --- | --- | --- |
| `undefined`、`null`、Boolean、Number、String、BigInt | 保留 | 保留 | 保留 | 可作为显式白名单；Number 是否允许 `NaN`/Infinity/`-0` 应写进产品 schema |
| Symbol primitive / Symbol object | `DataCloneError` | `Error` | `DataCloneError` | 拒绝；symbol identity 没有跨 Realm 恢复语义 |
| Array、普通 Object | 只复制 enumerable own string-keyed 值 | 同结构化克隆模型 | 同左 | 只在预检确认 prototype/descriptor 契约后允许 |
| 循环、同一对象被多处引用 | 保留循环和共享 identity | 保留 | 保留 | 可以硬保证；恢复后 identity 只在新 graph 内成立 |
| Date、RegExp | 保留内建类型与核心内部数据 | 保留 | 保留 | 可选白名单；RegExp 的 `lastIndex` 和附加属性不在标准核心记录内 |
| Map、Set | 保留类型、顺序、键/值 graph | 保留 | 保留 | 可选白名单；键 identity 只指向恢复 graph 中的对应对象 |
| ArrayBuffer | 复制；列入 transfer 时 detach 源 | 编码字节；高级 Serializer 可 out-of-band transfer | 复制或 transfer；transfer 后源不可用 | 持久化只允许“复制字节”，禁止 transfer 语义进入记录 |
| SharedArrayBuffer | clone 共享底层 data block，不复制 | DefaultSerializer 没有应用可依赖的独立持久化共享内存恢复契约 | 两线程共享同一内存，且不可列入 transfer list | 拒绝；共享活内存不是 durable state |
| TypedArray / DataView | 保留 view 类型与范围；Node `Buffer` 退化为 `Uint8Array` | `DefaultSerializer` 特别把 Buffer/view 写成 host object，并只保存 view 覆盖的 buffer 区间 | view 可 clone/transfer；`Buffer` 接收为 `Uint8Array` | 若纳入，规范化为明确 typed-array tag；不要依赖 Buffer 在 API 间的一致 prototype |
| Error | 标准 Error prototype、message；stack 为实现定义，其他数据仅“should”保存 | V8 保存标准 Error 类别、message、stack，并在当前实现保存 data-property `cause` | 使用同一 V8 核心 | 第一版建议只恢复稳定 DTO（name/message/cause），不硬保证 stack 或自定义 Error subclass |
| 函数、async/generator/bound function、class 构造器 | 拒绝 callable | 拒绝 | 拒绝 | live-only；必须用受版本控制的代码标识 + 参数显式重建，不能序列化 closure |
| class instance | prototype/method/private/accessor 丢失，变普通对象 | 同左 | 同左 | 默认拒绝，避免“成功但语义损坏” |
| Proxy | 拒绝 exotic object | V8 拒绝 callable/exotic receiver | 拒绝 | 拒绝；不要触发 trap 来“展开”后再恢复 |
| module namespace | 拒绝 exotic object | V8 拒绝 special receiver | 拒绝 | 拒绝；恢复为重新 `import` 也不适用于本 Realm，因为当前没有 dynamic-import callback |
| Promise、WeakMap、WeakSet、iterator/generator state | 因专用 internal slots/exotic 状态而拒绝 | 拒绝 | 拒绝 | live-only |
| WebAssembly.Module | 取决于 embedder/platform serialization | DefaultSerializer 没有可作为 durable contract 的 transfer delegate | Node 明确允许在线程间传递 | 不纳入第一版持久化保证 |
| Node native handle | 仅实现声明为 serializable/transferable 的 platform object | 默认只处理其明确 host-object 格式；自定义 Serializer 必须自建协议 | Node 显式 allowlist，部分只能 transfer | 一律拒绝持久化；恢复必须通过 Host 权限路径重新取得资源 |

标准对普通对象先调用 `EnumerableOwnProperties(value, key)`，再对每个 key 执行 `[[Get]]`，所以 **getter 会在序列化时运行**；反序列化用 `CreateDataProperty` 创建普通数据属性。[WHATWG 的 deep serialization 步骤](https://html.spec.whatwg.org/multipage/structured-data.html#structuredserializeinternal)直接规定了这两个动作。Node 文档进一步确认 non-enumerable、accessor、prototype 均不保留，class 示例最终只剩 enumerable string-keyed 字段。由此还可推得：symbol-keyed own property、descriptor flags、setter、custom prototype 和 class private fields 都不属于恢复契约。

函数没有独立于当前 V8 Context 的代码与 closure environment 数据模型。WHATWG 在 callable 分支直接抛 `DataCloneError`；具有 Promise/WeakMap 状态等额外 internal slot 的对象以及 Proxy 等 exotic object 也直接拒绝。[拒绝分支](https://html.spec.whatwg.org/multipage/structured-data.html#structuredserializeinternal)明确列出了 callable、额外 internal slot 和 Proxy。ECMAScript 规范同时把 [module namespace 定义为 exotic object](https://tc39.es/ecma262/multipage/ecmascript-language-scripts-and-modules.html#sec-module-namespace-exotic-objects)，所以它不是“普通只读对象”的可恢复特例。

### Error 的两种“错误类型”

必须区分“被保存的 Error 值”和“API 自己抛出的失败”：

- 对 Error 值，WHATWG 只为 `Error`、`EvalError`、`RangeError`、`ReferenceError`、`SyntaxError`、`TypeError`、`URIError` 指定对应 prototype；未知 name 退化为 `Error`。message 被指定，stack 是 implementation-defined，其他伴随数据只是建议保存。[Error serialization](https://html.spec.whatwg.org/multipage/structured-data.html#structuredserializeinternal)和 [Error deserialization](https://html.spec.whatwg.org/multipage/structured-data.html#structureddeserialize)是可移植保证的上限。Node 24.18.0 内置的 V8 源码还编码 `cause` 和 stack，但只识别上述标准 prototype，[`WriteJSError` / `ReadJSError`](https://github.com/nodejs/node/blob/v24.18.0/deps/v8/src/objects/value-serializer.cc)表明自定义 Error/AggregateError 不能按原 class 硬保证。
- 对失败，WHATWG `structuredClone` 与 Worker clone/transfer 失败抛 name 为 `DataCloneError` 的 `DOMException`；Node Worker 文档也用 `DataCloneError` 演示 unsupported URL 和 untransferable object。`node:v8.Serializer.writeValue()` 只承诺抛 `Error`，且 `_getDataCloneError()` 默认使用 `Error` 构造器，而不是 DOMException；header 无效或 wire version 不支持时 `Deserializer.readHeader()` 同样抛 `Error`。[Node V8 Serializer/Deserializer 文档](https://nodejs.org/download/release/v24.18.0/docs/api/v8.html#class-v8serializer)给出了这条错误契约。

## 各 API 评估

### `structuredClone(value, { transfer })`

优势是标准、稳定、直接返回同进程的新 graph；它保留循环/共享关系和大多数结构化内建类型，并提供 ArrayBuffer 等 transferable 的原子 clone-with-transfer 语义。WHATWG 在真正执行 transfer 前先完成 serialization，以避免较晚的 clone 错误已经造成部分 transfer 副作用；重复、不可转移或已 detach 的条目抛 `DataCloneError`。[StructuredSerializeWithTransfer](https://html.spec.whatwg.org/multipage/structured-data.html#structuredserializewithtransfer)规定了这个顺序。

它不适合作为 durable 底座：没有 byte representation、版本 header、读取 API或磁盘格式；transfer 还会破坏发送方对原 buffer 的使用。更重要的是，单独用它“检查能不能 clone”再用另一 serializer 保存会执行两次 getter，违反本仓库已经认识到的单次观察原则。它最多适合对已知纯数据做一次 generation-local snapshot，不能帮助恢复函数、prototype 或 authority。

### `node:v8.serialize()` / `deserialize()`

这是唯一直接面向磁盘的候选。Node 声明其格式向后兼容且 safe to store to disk，header 包含 wire-format version，`readHeader()` 会拒绝无效或不支持的版本；相等值可能产生不同字节，因此结果不能作为 canonical hash、签名明文或内容地址。[Serialization API](https://nodejs.org/download/release/v24.18.0/docs/api/v8.html#serialization-api)与 [V8 ValueSerializer public header](https://chromium.googlesource.com/v8/v8/+/refs/heads/main/include/v8-value-serializer.h)给出了格式保证。

“向后兼容”应严格解释为**新 reader 读旧记录**，而不是旧 reader 读新记录。V8 `ReadHeader()` 在记录 version 大于当前 `kLatestVersion` 时抛 deserialization version error，[V8 source](https://chromium.googlesource.com/v8/v8/+/refs/heads/main/src/objects/value-serializer.cc)与 Node 的 V8 升级通知共同证明它不向前兼容。滚动部署若允许旧进程读取新进程刚写的记录，必须由应用 envelope 的 writer-version gate 阻止，而不能依赖 V8 自己猜测。

`DefaultSerializer` 的 Node host extension 也需要收窄理解：它特别序列化 Buffer/TypedArray/DataView，并只存 view 覆盖的那部分 backing buffer；更一般的 C++ host object 需要 subclass 实现 `_writeHostObject()` / `_readHostObject()`，SharedArrayBuffer 需要稳定的外部 ID 映射。[DefaultSerializer 与 host-object hooks](https://nodejs.org/download/release/v24.18.0/docs/api/v8.html#class-v8defaultserializer)说明这些并非免费支持。第一版不应自定义 host-object wire tags，因为那会立即引入第二套版本、权限、资源重建和兼容协议。

### Worker messaging

Node 的 `port.postMessage()` 使用兼容 HTML structured clone 的机制，明确支持循环、RegExp/BigInt/Map/Set、typed arrays、SharedArrayBuffer 和 WebAssembly.Module。Node 还列出 C++-backed allowlist：CryptoKey、FileHandle、Histogram、KeyObject、MessagePort、BlockList、TCP Server/Socket、SocketAddress、X509Certificate。[Node 24 Worker clone 列表](https://nodejs.org/download/release/v24.18.0/docs/api/worker_threads.html#portpostmessagevalue-transferlist)是 Node 原生能力的权威边界。

其中 ArrayBuffer 不在 transfer list 时复制，在 list 中则 detach 源及其所有 views；SharedArrayBuffer 只共享且不能 transfer。MessagePort、FileHandle、TCP Server/Socket transfer 后发送侧不可再用，Socket 还受“未开始读、无 buffered data、仅 TCP”等活状态约束。这些都是**所有权转移**，不是“可落盘后重建”。Buffer pool 更危险：Node 明确警告 pooled Buffer 可能复制整个 pool，带来额外内存和安全问题。[TypedArray/Buffer transfer 注意事项](https://nodejs.org/download/release/v24.18.0/docs/api/worker_threads.html#considerations-when-transferring-typedarrays-and-buffers)要求只有确定拥有 backing ArrayBuffer 时才能 transfer。

所以 Worker messaging 适合继续承担本仓库当前 generation 内的私有控制 transport，但 Restorable Binding 不应直接把待保存值 `postMessage` 给 Host：这会扩大当前 lossless-JSON seam、暴露 Node host-object allowlist、引入 transfer side effect，并把 program-controlled graph 交给协议 serializer。若以后在独立 checkpoint Worker 中运行 `v8.serialize`，消息只应传入已经过白名单验证的纯数据或受限字节，不能传 lease/handle。

## 相邻原生 API

- [`util.types`](https://nodejs.org/download/release/v24.18.0/docs/api/util.html#utiltypes)提供不依赖 `instanceof` 的 `isProxy()`、`isModuleNamespaceObject()`、`isNativeError()`、Map/Set/typed-array 等判定。它适合白名单 validator，尤其跨 Context 时比 prototype 名称可靠；但它只分类，不负责 graph 大小、descriptor、getter 或恢复语义。
- [`worker_threads.markAsUncloneable()` / `markAsUntransferable()`](https://nodejs.org/download/release/v24.18.0/docs/api/worker_threads.html#worker_threadsmarkasuncloneableobject)可保护 runtime-owned live object 不被意外发消息/转移，且标记不可撤销。它们可作为控制 port/backing buffer 的纵深防御，却不会让普通数据变得 durable，也不能替代私有 port 与 nonce。
- [`moveMessagePortToContext()`](https://nodejs.org/download/release/v24.18.0/docs/api/worker_threads.html#worker_threadsmovemessageporttocontextport-contextifiedsandbox)只是把 live port 移到另一个 `vm` Context；原 port 失效，接收对象使用 target Context 的 `Object` prototype。它不保存 port，也不恢复 namespace。
- [`vm.Script.createCachedData()`](https://nodejs.org/download/release/v24.18.0/docs/api/vm.html#scriptcreatecacheddata)保存的是 V8 code cache，不含 JavaScript 可观察状态；加载时仍然执行 source，缓存还受 V8 version/flags/CPU tag 约束并可能被拒绝。它不能保存 binding value、closure environment 或 lease。
- [`v8.startupSnapshot`](https://nodejs.org/download/release/v24.18.0/docs/api/v8.html#startup-snapshot-api)能在构建自定义 Node 启动镜像时保存整个应用对象，并提供 serialize/deserialize callbacks，但用户态 snapshot 目前不能再次 snapshot，API 面向进程启动而非运行中的 per-Session Worker generation。为每个 Realm 重建 Node snapshot 会改变部署与所有权模型，不适合第一版。
- [`v8.getHeapSnapshot()` / `writeHeapSnapshot()`](https://nodejs.org/download/release/v24.18.0/docs/api/v8.html#v8getheapsnapshotoptions)输出供 DevTools 诊断的、V8-specific 且未文档化 JSON schema，没有 restore API；生成同步阻塞并需要约两倍 heap，存在 OOM 风险。它不是 checkpoint 格式。
- Worker [`resourceLimits`](https://nodejs.org/download/release/v24.18.0/docs/api/worker_threads.html#new-workerfilename-options)只限制 JS engine；Node 明确说明不限制包括 ArrayBuffer 在内的 external data，且进程仍可能全局 OOM。它是隔离恢复工作的必要 backstop，不是单独充分的资源保证。

## 不可信输入与资源上限

这些 API 都不是完整的信任边界。

序列化方向首先有用户代码执行风险：普通对象遍历会读取 getter；Error 的 `name`/stack 读取和 Node/V8 host-object hooks 也可能执行实现或用户路径。当前 Realm 自己的 lossless-JSON walker已经明确承认 getter 只可读取一次，[并用单次 traversal 同时做 snapshot、计数和 projection](../../src/realm/realm-worker.ts#L869-L1029)。Restorable validator 应改为 descriptor-first：只接受允许 prototype 上的 enumerable own **data descriptor**，拒绝 accessor，而不是先 structuredClone 再检查结果。使用 `util.types.isProxy()` / `isModuleNamespaceObject()` 在任何通用反射前拒绝 exotic value。

反序列化方向，Node 对 `deserialize(buffer)` 的公开参数说明是“由 `serialize()` 返回的 buffer”，而不是任意不可信字节；`readHeader()` 能验证 header/version，不等于认证来源或限制工作量。[Deserializer 文档](https://nodejs.org/download/release/v24.18.0/docs/api/v8.html#class-v8deserializer)只承诺格式检查。WHATWG 也明确指出 deserialization 会因创建新对象、尤其 ArrayBuffer 的内存分配而失败。`v8.serialize` 唯一文档化的绝对输出上限是超过 `buffer.constants.MAX_LENGTH` 时抛 `ERR_BUFFER_TOO_LARGE`，这个上限远大于合理的 per-binding 配额，也没有 per-call depth/node/CPU/heap 参数。

因此第一版最少需要：

1. **写前白名单与单次有界 walk**：限制 binding 数、每值与总节点数、深度、string/collection/ArrayBuffer 字节数和预计总字节；拒绝 accessor、symbol keys、custom prototype、Proxy、module namespace、SharedArrayBuffer、transferable、native host object、函数和异步状态。
2. **应用 envelope**：magic、应用 schema version、writer Node major/V8 wire version、Realm-keyed record identity、payload length、创建时间和完整性字段。非可信写入者存在时使用 keyed MAC；普通 checksum 只能发现损坏，不能认证来源。
3. **读前检查**：在分配/deserialize 前限制文件与 payload 字节，验证 envelope、length、version policy、MAC；不接受 trailing/拼接记录。
4. **隔离恢复**：在可 hard-kill 的独立 Worker 中 deserialize，设置 JS heap/stack limits，并由 Host 实施 wall timeout；同时用应用自己的 ArrayBuffer/collection/graph ceilings弥补 `resourceLimits` 不覆盖 external memory。
5. **读后重新验证**：deserialize 成功后再次按 schema 检查类型、descriptor、graph 数量和 key；随后构建临时 namespace，全部成功才原子安装。任何错误都删除临时 graph 并报告 checkpoint 不可恢复。
6. **滚动版本纪律**：新 writer 不得生成仍可能由旧 reader 打开的格式。可选择部署期间只由最低共同版本写入，或读写 generation/version 隔离；升级前保留用目标版本实际读取旧 fixture 的 compatibility gate。

Worker 超时能终止同步 serializer 所在 isolate，适合故障封闭；但 checkpoint 若在当前 Realm Worker 中执行，超时 hard-kill 恰会销毁正在尝试保存的 namespace。因此更稳妥的顺序是：当前 Realm 先完成有界 descriptor walk 并产出获准 DTO/graph，再把它交给隔离编码 Worker；任何 checkpoint 工作都不得持有或调用 leased Proxy。

## 建议的第一版硬保证

建议将产品契约命名为 **Restorable Data Binding**，避免“Restorable Binding”被理解为透明恢复任意 JavaScript binding。第一版最小闭环如下：

- 编码器：`node:v8.serialize()` / `deserialize()`，外包应用自有 versioned + authenticated envelope。
- 默认允许：`null`、Boolean、String、明确规定范围的 Number，以及 plain Array / plain Object 组成的 graph；允许循环/共享关系是 `v8` 相比 JSON 的首个实质收益。
- 只有明确用例出现后再逐类加入 BigInt、Date、RegExp、Map、Set、ArrayBuffer/TypedArray。每类必须定义可观察恢复语义，例如 RegExp 不承诺 `lastIndex`、Buffer 规范化成哪种类型、Map key identity 如何描述。
- 默认拒绝：symbol、函数/class/closure、class instance/custom prototype、accessor、Proxy、module namespace、Promise/Weak collections/iterator state、SharedArrayBuffer、WebAssembly.Module、Error 原对象、Node native object 和全部 transferable。
- 恢复结果不继承旧对象 identity，只保证新 graph 内的 alias/cycle；不恢复 prototype/descriptor、pending task/microtask、AsyncLocalStorage、module cache、native resource、private field、WeakMap association 或任何权限。
- `tools` 等 runtime namespace 永不进入 checkpoint。恢复数据若需要再次调用工具，只能通过新 run 已租用的稳定 Proxy；恢复本身不得自动产生外部副作用。
- checkpoint failure 保留旧 durable record；恢复 failure 保持空的新 namespace并给出可行动错误，不回退为执行字符串、`eval`/`Function`、源码反序列化或重放 cell。

若产品目标要求 hard kill 后连函数/closure/class instance 行为都无差别恢复，结论不是换用另一项 Node 原生 API，而是**当前候选均不满足**。可行设计只能把代码作为受信任、版本控制的 module/recipe，由数据 checkpoint 保存 recipe id 与参数，在新 generation 中重新加载并构造；这是一项新的应用协议和 lifecycle 设计，不属于原生结构化克隆的保证范围。

## 最终判定

| 候选 | 可作为第一版硬保证底座 | 判定 |
| --- | --- | --- |
| `structuredClone` | 否 | 值语义合适，但无持久化格式；双重预检会重复 getter side effect |
| `node:v8.serialize/deserialize` | **是，有条件** | 唯一提供持久化 bytes 与向后兼容 reader；必须加白名单、envelope、认证、配额、隔离和版本 gate |
| Worker messaging | 否 | 是 live transport，host extensions/transferables 扩大权限与所有权语义，无 disk/version contract |
| V8/Node heap/startup/code snapshot | 否 | 分别是诊断、进程构建或代码缓存用途，不是 runtime per-Realm binding checkpoint |

因此，本工单的实现决策应记录为：**采用 `node:v8` 只做“显式可恢复数据 graph”的编码实现；拒绝承诺 arbitrary binding 或 executable state；第一版公开 schema 保持尽可能接近现有 lossless-JSON seam，并把未来类型扩展逐项显式化。**
