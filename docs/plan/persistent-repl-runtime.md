# Persistent REPL Runtime（已落地）

## 结论

Prime 现在只有一种运行语义：同一 Session、同一 Worker generation 中，每次 `run_code` 都是同一个严格模式 REPL 的下一 cell。普通顶层变量、函数、类和对象会自然留到后续 cell，不再要求模型操作额外的 `state` API。

旧方案在 modeltest 的 113 次 `run_code` 中只有 10 次主动使用 `state`（8.8%）。问题不在提示词写得不够重，而在持久性不是默认语言语义。因此本次直接删除显式 `state`，不再为它增加水合、脱水、采用率提示或兼容层。

```js
// 第一次 run_code
const smokeBase = 40
const smokeAdd = value => smokeBase + value
smokeAdd(1)

// 第二次 run_code
smokeAdd(2)
```

结果分别为 `41` 和 `42`。需要跨 Worker、进程或 Agent 存活的结果仍写入任务文件；live namespace 不做磁盘持久化。

## 最小产品契约

- 顶层 `const`、`let`、`var`、function、class、destructuring 和闭包跨 cell 可见。
- 同类顶层声明可按 V8 REPL 语义重声明。
- 支持 top-level `await`。
- Map、Set、普通对象、函数和闭包保留 live identity，不经 JSON 水合。
- cell 的末尾表达式就是 completion；顶层 `return` 由 V8 原生拒绝。
- `tools` 等注入 namespace 是只读、不可配置的保留名；顶层同名声明明确失败。
- 第一次合法请求冻结该 Realm 的注入 global schema。后续可以省略并恢复已知 namespace，也可以更新其函数成员，但不能新增 namespace 或改变错误类描述符。
- 一个 Realm 串行执行 cell；不同 Realm 可以并行。
- 非 Prime 请求继续走官方 one-shot runtime。

明确不提供：

- 程序可见的 `state`、`maxStateEntries`、binding census 或 retained-generation 回显；
- parser、顶层 `return` 改写、双执行器、feature flag 或兼容模式；
- 逐变量删除、历史版本、自动重放或跨进程 heap 恢复；
- 为 cell 内原生 `import()` 增加 helper 或语法转换。外部能力继续通过 `tools` 使用。

## 实现

Worker 内使用同进程 `node:inspector/promises` Session 调用 `Runtime.evaluate`，参数固定为严格模式、`replMode: true`、`awaitPromise: true` 和每次 run 独立的 object group。Inspector 不打开 TCP 监听地址。

completion 不使用 CDP 的直接 by-value 序列化。Worker 通过保留的函数 handle 调用现有 lossless snapshot 逻辑，再释放本次 run 的 object group。因此函数、Map、循环对象、特殊数字和输出预算仍按现有 Prime 契约处理。

工具 Proxy 保持稳定，只有当前 run 的 allowed member set 和 lease 会变化。`AsyncLocalStorage` 绑定 run ownership；旧 timer、Promise continuation 和异步资源不能借用下一 cell 的工具权限。

实现只针对当前 DSH 运行环境，并已在 Node `v24.18.0` 上实测。不增加最低 Node 版本承诺、版本矩阵、启动 capability probe 或回退路径。

## 失败与生命周期

- 语法错误：cell 不执行，namespace 不变。
- 普通运行时错误：错误前已发生的声明、赋值和副作用可能保留，采用 REPL 的部分提交语义。
- completion 序列化失败：cell 已执行，namespace 保留，结果为 invalid output。
- abort、timeout、OOM、Worker exit 或协议违规：hard-kill 当前 Worker，整个 live namespace 丢失。
- fresh Worker 的第一次真实 dispatch 回显一次 `[prime-realm] live namespace started empty`；正常后续 cell 静默。
- 同一 Realm 明确 hard-kill 后，下一次真实 dispatch 回显一次 `[prime-realm] live namespace restarted; previous bindings were lost`。
- idle/LRU 回收后重新进入只报告 fresh namespace，不维护跨 Realm tombstone。
- 正常结算会等待该 run 已接纳的 host binding calls 完成，再运行下一 cell。
- host binding 接口没有 `AbortSignal`，所以 timeout、abort 或 dispose 只能终止 Worker，不能撤销已经交给外部 host 函数的工作；其外部副作用可能稍后完成，但迟到回复会被丢弃。

## 安全收敛

真实探针确认了三个值得修的同-isolate 通道：

1. `process._getActiveHandles()` 可以枚举 Worker 私有 `MessagePort`。
2. `node:async_hooks` 可以修改 `AsyncLocalStorage` 原型并破坏 run ownership。
3. Map、Set、Array 原型 hook 可以观察或篡改 runtime 内部集合。

当前实现只做对应的定点处理：拒绝 active handle/request 枚举，拒绝 `module`、`async_hooks`、`inspector` 与 `process.binding()` 入口，并捕获 runtime 实际依赖的 ALS、Map、Set、Array 和 Reflect 方法。控制消息仍经私有 `MessagePort`，host 严格校验 run/call id、nonce 和单次 terminal settlement。

这不是通用 JavaScript sandbox。模型代码仍与 DSH host 处在同一 OS 用户权限边界；本次没有增加通用 denylist、第二 Worker、权限框架或未来扩展层。

## 已完成验收

- 严格模式、top-level await、五类声明重声明、destructuring、闭包和 partial commit。
- 普通对象、Map、Set、函数跨 cell identity。
- undefined、特殊数字、函数、Map、循环对象、深层结构和输出预算的 lossless completion。
- stale continuation、工具成员更新/撤销、host call 排序、abort、timeout、Worker exit 和 dispose。
- Session 隔离、同 Realm admission 顺序、跨 Realm 并行、idle/LRU、fresh/loss notice。
- runtime global schema 冻结和 caller misuse 不触碰 generation。
- active handle、Inspector/module、async hooks 与集合原型攻击回归。
- 非 Prime one-shot 路径和既有 Prime 集成测试。
- 真实 `dsh-prime-agent + gpt-5.6-sol (high)` headless 两 cell：第一次 `41`，第二次直接调用第一 cell 的 `smokeAdd(2)` 得到 `42`，进程退出码 `0`。

### modeltest V4.1b 单次观测

当前 Windows 环境使用 `openai-codex/gpt-5.6-sol`、high reasoning 和 Prime headless 完成了一次 frozen V4.1b 候选任务：

- 候选阶段 23 分 48 秒，92 次 `run_code`，headless 退出码 `0`。
- 没有使用已删除的显式 `state` API；模型自然跨 cell 复用了 `initPublic2`、`parserBlockRead`、`httpScript` 和 `manualB64` 等普通 binding。
- public tests 与 debug probe 通过；hidden tests `44/45`，唯一失败是无 actor session 的 reason 文案，行为与数据隔离通过；ESP static `9/9`。
- 当前机器未配置 ESP-IDF activation script，按冻结 rubric 的 `F9 skipped_env` 计 `3/6`。
- 自动草稿曾给出 Ability `93`、Ship `72`，原因是评分正则把“没有声称固件编译通过”中的否定句误判成 build overclaim。按同一冻结 rubric 去掉该误报并计入 `skipped_env` 后，本次单次结果为 **Ability 96、Ship 96、Class A**。

这是 single observation，不替代两跑 worst-of-n；也不修改 modeltest 的冻结评分代码。

当前已知限制只有两项与使用直接相关：Inspector cell 内原生 dynamic import 没有 import callback，会明确失败；已接纳且不可取消的 host binding 可能在 hard-kill 后完成外部副作用。
