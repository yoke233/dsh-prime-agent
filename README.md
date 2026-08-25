<p align="center">
  <img src="./assets/readme/hero.svg" width="100%" alt="dsh-prime-agent —— 为 DeepSeek Harness 提供唯一模型可见的持久 TypeScript REPL：普通顶层变量在下一次 repl cell 中仍然可用">
</p>

<p align="center">
  <a href="docs/architecture.md">当前架构</a> ·
  <a href="docs/prime-agent-learnings.md">Prime Agent 学习笔记</a> ·
  <a href="docs/upstream-sync.zh.md">上游同步手册</a>
</p>

`dsh-prime-agent` 是面向 DeepSeek Harness 的 RLM-first 控制面。选中 Prime preset 的会话只有一个模型可见工具 `repl`：它的唯一参数是 `{ code }`，执行一个持久 TypeScript REPL cell。上一 cell 声明的普通变量、函数和对象，下一 cell 可以直接使用；DSH 的其他工具不进入模型 schema，而是作为 `tools`、`agents`、`jobs` 绑定预加载进 cell。

```ts
// 第 1 次 repl
repl({ code: `
const lookup = new Map(records.map(item => [item.id, item]))
const review = async (id) => tools.review_item({ item: lookup.get(id) })
lookup.size
` })

// 第 2 次 repl —— 同一会话的新调用
repl({ code: `await review('a') // Map 和函数都还活着` })
```

普通会话完全不受影响,继续使用官方 one-shot 语义。

## 工作原理

<p align="center">
  <img src="./assets/readme/architecture.svg" width="100%" alt="repl {code} 经 Agent scope 用可信 exec.agent.id 解析 Realm identity,host primeRealmRuntime 服务准入持久 Realm Worker;官方 code-runtime row 未改动,非 Prime 会话继续官方 one-shot">
</p>

- 模型 catalog 只含 `repl`。其他 DSH 工具不直接可见:prompt assembly 把 tools 列表过滤到只剩 `repl`,直接调用其他工具会被 guard 拒绝;这些能力作为 cell 内预加载绑定出现——`tools.*` 是返回已解析 canonical JavaScript value 的 typed bindings,`agents.*`(spawn/fork/list/send/interrupt)与 `jobs.*`(list/output/kill)是 continuable child 与后台任务的薄适配。Agent 固定提示与具体对话、任务、仓库和历史错误无关；当前 catalog 只负责生成真实参数与返回类型声明。
- 路由信任 Agent 执行上下文。`repl` 要求拥有 Agent 会话:插件用可信 `exec.agent.id` 从共享 `realm-identity` 存储解析该会话稳定的不透明 Realm id,再把程序、本轮租约绑定与取消信号交给 host 侧的 `ctx.primeRealmRuntime.run(...)`。没有握手、没有模型可见的身份工具;缺少可信执行上下文或无法解析 Realm id 时明确失败,绝不降级。
- Host 服务与官方运行时并存。`cordis.patch.yml` 只是把 `dsh-prime-agent/runtime` 作为新 row 插入,官方 `code-runtime` row 原样保留;非 Prime 会话继续使用官方 one-shot 语义,不存在 fallback。
- Realm 内的绑定经跨 run 稳定的 Proxy 与 per-run binding lease 调用:schema、审批、沙箱、日志、并发和取消仍由 DSH 执行,run 结束立即撤销授权。
- 多个 TUI 进程可共享 Prime 持久状态并同时运行不同 Session；同一 Session 的 live Realm 同时只允许一个进程持有，owner 退出后另一进程以空 namespace 接管。
- Prime 不封装搜索接口：直接调用 DSH 的 `grep`，并在 repl 程序内把 TypeScript 正则字面量的 `.source` 作为 `pattern`，避免字符串二次转义。
- Profile 显式安装的 DSH Host MCP client 把 server tools 注册进统一 catalog，repl 单元自动获得对应 `tools.*` 绑定；Prime 不复制 Python kernel-owned MCP runtime。
- 工具结果已经是 Realm 内的 JavaScript value，不对其再次 `JSON.parse`。notebook 结构化 preview 中的 `\\` 只是 JSON notation；模型自行编写 Windows 路径时优先使用 `D:/work/project` 形式，避免额外转义层。
- Prime preset 为模型可见的工具结果配置 12KB best-effort spill 阈值；`repl` 的外层 canonical value 仍是可程序化读取的 lossless JSON（`logs`、可选 `result` 与可信 presentation metadata），但模型只看到无类型外壳的 notebook 文本：logs 和字符串原样显示，结构化值只 pretty-print 一次，空结果返回空文本；renderer 不添加 `[repl result: ...]`、`[repl logs]` 或 Markdown fence。外层 notebook 文本超过展示预算时由 DSH 写入 artifact 并返回 locator；保存失败时保留完整 inline 成功结果并告警，不伪造 locator。
- 完成值由 runtime 自动保留在 generation-local 的 completion history 中：`$_` 是最近已保留结果的首选入口，`$out(N)` 只用于较早结果；runtime-authored preview 由 nonce 验证后的 metadata 驱动，已保留 preview 明确教授这两个入口，未保留 preview 不显示 handle，opaque 值不做结构化渲染。用户主动返回旧 envelope 同形 JSON 时仍按普通 JSON 显示。
- Realm 是 live-only 的：abort、timeout、OOM 会 hard-kill Worker 并丢失 namespace，下一次真正执行时会明确提示之前的 bindings 与保留结果已丢失。跨重启的检查点由程序显式写入持久任务文件。

完整身份路由、namespace 生命周期、Agent 编排与学习层边界见 [当前架构](docs/architecture.md)。

## 三层数据

| 状态层 | 责任 | 保证 |
| --- | --- | --- |
| Realm live namespace | 普通顶层变量、函数、对象、Map 和索引 | 同一 Worker 内的 cell 间保留；hard kill 后丢失 |
| Completion history | runtime 自动保留的 cell 结果，经 `$_` 与 `$out(N)` 访问 | 同上；超预算按 FIFO 淘汰，失效 handle 抛 `CompletionExpiredError` |
| 持久任务文件 | 大型输入、重要结果与跨重启检查点 | 由文件系统承载,进程重启后仍可恢复 |
| `refine` | 稳定路由与行为经验 | 证据化、乐观并发、事务历史和安全回滚 |

## 安装与启用

```sh
npm install
npm run check
dsh plugin --profile web add ./dsh-prime-agent
```

`dsh plugin add` 即提供全部内容:随包 bundle patch 在官方 `code-runtime` row 旁纯插入 `dsh-prime-agent/runtime` host row(不替换、不停用官方运行时);随包 Prime preset 在启动时落位到 `$DSH_HOME/.agent-presets`(仅缺失时)。启用 Prime 模式只是为某个会话选中 Prime preset;默认 preset 与其他 preset 保持官方 one-shot 语义。落位后的 preset 不会被覆盖,删除 `$DSH_HOME/.agent-presets/prime` 并重启即可重新落位当前快照。

Host runtime 会监控启动它的直接父进程。Windows 父 shell 被强制终止或 macOS/POSIX 子进程被重新托管时,插件会释放整个 Cordis tree、Realm Worker 与该进程持有的 Realm leases,随后退出;根级 dispose 未在 5 秒内结算时强制非零退出。它面向前台 `dsh` 生命周期,不支持把宿主有意脱离父进程作为 daemon 运行。

### TUI 运行

Prime 的 `cordis.patch.yml` 是纯插入：官方 `code-runtime` row 原样保留，新增的 `prime-code-runtime` host row 注册 `primeRealmRuntime` 服务、监控父进程并落位 preset。TUI Profile 不需要额外的支持 bundle，也不会停用或替换官方 provider。

```powershell
npm pack
$primePackage = Get-ChildItem -Filter 'dsh-prime-agent-*.tgz' |
  Sort-Object LastWriteTime -Descending |
  Select-Object -First 1 -ExpandProperty FullName
dsh plugin --profile tui add $primePackage
```

使用 `dsh --profile tui --dump-config` 核验组合结果中存在 `agent-presets`、`prime-code-runtime`、官方 `tool-subagent-report` 和 `tui`，然后运行 `dsh --profile tui`。

### Headless 运行

当前 DSH headless bundle 不会挂载 agent preset,因此需要同时安装仓库内的 `prime-headless-shim`,并在 headless profile 中启用 Prime preset。推荐使用隔离的 `DSH_HOME`,避免影响日常 profile。

```powershell
$sourceDshRoot = Join-Path $env:USERPROFILE '.dsh'
$isolatedDshRoot = Join-Path $env:TEMP ('dsh-prime-headless-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
$pluginRoot = (Resolve-Path '.').Path
$shimRoot = Join-Path $pluginRoot 'scripts\eval\prime-headless-shim'

New-Item -ItemType Directory -Path $isolatedDshRoot | Out-Null
foreach ($name in @('settings.yaml', '.credentials.yaml', 'openai-codex-auth.json')) {
  $source = Join-Path $sourceDshRoot $name
  if (Test-Path -LiteralPath $source) {
    Copy-Item -LiteralPath $source -Destination (Join-Path $isolatedDshRoot $name)
  }
}

$env:DSH_HOME = $isolatedDshRoot
dsh --profile headless --dump-default-config | Out-Null

# shim 从全局 DSH 安装解析这两个运行时依赖。
$globalNodeRoot = npm root -g
$shimModules = Join-Path $shimRoot 'node_modules\@deepseek-ai'
New-Item -ItemType Directory -Force -Path $shimModules | Out-Null
foreach ($packageName in @('dsh-agent', 'dsh-llm')) {
  $junction = Join-Path $shimModules $packageName
  if (-not (Test-Path -LiteralPath $junction)) {
    $target = Join-Path $globalNodeRoot "@deepseek-ai\dsh\node_modules\@deepseek-ai\$packageName"
    New-Item -ItemType Junction -Path $junction -Target $target | Out-Null
  }
}

$shimLink = 'link:' + ($shimRoot -replace '\\', '/')
$pluginLink = 'link:' + ($pluginRoot -replace '\\', '/')
dsh plugin --profile headless add $shimLink
dsh plugin --profile headless add $pluginLink
```

如果 `settings.yaml` 使用 `openai-codex` provider,headless profile 还必须安装对应适配器。下面复用现有 web profile 已安装的适配器:

```powershell
$codexAdapter = Join-Path $sourceDshRoot 'profiles\web\node_modules\dsh-openai-codex-auth'
if (-not (Test-Path -LiteralPath $codexAdapter)) {
  throw '当前 web profile 未安装 dsh-openai-codex-auth'
}
$codexAdapterLink = 'link:' + ($codexAdapter -replace '\\', '/')
dsh plugin --profile headless add $codexAdapterLink
```

将隔离 profile 的 `profiles/headless/cordis.patch.yml` 设置为:

```yaml
- insert:
    - id: agent-presets
      name: '@deepseek-ai/dsh-agent-presets'
      config:
        default: prime
```

启动前可用 `dsh --profile headless --dump-config` 核验组合结果中同时存在 `prime-headless-runner`、`prime-code-runtime`、`dsh-prime-agent` 和 `agent-presets`。然后在目标工作目录运行:

```powershell
$env:NODE_USE_ENV_PROXY = '1'  # Node 需要读取系统代理时启用
$env:DSH_TELEMETRY_DISABLED = '1'
dsh --profile headless '完成当前工作区中的任务'
```

#### 为单次 headless 请求指定 Ark 模型

当前 headless CLI 不提供 `--provider` 或 `--model` 参数，而是读取 `settings.yaml` 中的 `agent-default-model`。如果不希望修改日常 profile 的默认模型，可以让本次运行临时读取一份独立设置。下例明确请求 Ark 的 `deepseek-v4-flash-ga-260731`；`deepseek-v4-flash` 只是显示名称，不能代替请求中的模型 ID。

现有 `$DSH_HOME/.credentials.yaml` 中需要已经配置 `ARK_API_KEY`。临时设置只改变本次模型选择，凭据仍由原来的 DSH credential provider 读取。

```powershell
$arkTestRoot = Join-Path $env:TEMP ('dsh-headless-ark-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
New-Item -ItemType Directory -Path $arkTestRoot | Out-Null

$arkSettingsPath = Join-Path $arkTestRoot 'settings.yaml'
$arkPatchPath = Join-Path $arkTestRoot 'cordis.patch.yml'
$arkSettingsYamlPath = $arkSettingsPath -replace '\\', '/'

@'
agent-default-model:
  provider: ark
  model: deepseek-v4-flash-ga-260731
llm-pi-ai:
  providers:
    ark:
      displayName: 火山
      apiKeyEnv: ARK_API_KEY
      api: openai-completions
      baseURL: https://ark.cn-beijing.volces.com/api/v3
      models:
        - id: deepseek-v4-flash-ga-260731
          name: deepseek-v4-flash
'@ | Set-Content -LiteralPath $arkSettingsPath -Encoding utf8

@"
- id: settings
  config:
    path: '$arkSettingsYamlPath'
    watch: false
"@ | Set-Content -LiteralPath $arkPatchPath -Encoding utf8

try {
  $env:NODE_USE_ENV_PROXY = '1'
  $env:DSH_TELEMETRY_DISABLED = '1'
  dsh --profile headless --patch $arkPatchPath '只输出：ARK_HEADLESS_OK_260731'
  if ($LASTEXITCODE -ne 0) {
    throw "headless 请求失败，退出码: $LASTEXITCODE"
  }
} finally {
  Remove-Item -LiteralPath $arkTestRoot -Recurse -Force
}
```

预期输出为 `ARK_HEADLESS_OK_260731`。如果希望所有后续 headless 请求都使用该模型，可直接把 `$DSH_HOME/settings.yaml` 中的 `agent-default-model` 改为同一组 `provider` 和 `model`；此时不再需要临时 patch。

会话轨迹保存在 `$DSH_HOME/sessions`,Prime Realm 身份与学习状态保存在 `$DSH_HOME/prime-agent`。

## 编排工作流

控制面 policy 引导模型在一个程序里组合读取、工具与子 Agent：中间值留在 live namespace；独立前台工作用 `Promise.all`，best-effort 探测逐项捕获，副作用型 mutation 顺序执行。大结果不需要模型自己归约——runtime 会把超过 64 KiB 的完成值换成有界引用 envelope，cell 仍然成功，原值留在 Realm 内可用 envelope 里给出的 `$out(N)` 继续计算。

慢任务使用非阻塞控制循环：交给 managed Job 或 continuable child，保存 id/输出位置后继续独立工作，或结束当前 turn 等待通知；不使用 sleep 轮询或长阻塞 `await` 占住交互。多回合或多 child 工作由直接面向用户的 root 在有意义里程碑简洁汇报结果、阻塞和下一步。

Prime preset 的 `subagent` 与 `subagent_fork` 默认创建 continuable child：调用在 child inbox 接受任务后返回持久 child id，父 Agent 随即继续。后续使用 `list_agents` 观察、`send_message` 投递新 turn、`interrupt_agent` 中断当前 turn；child 通过 `report` 主动回传选定结论。continuable child 不产生 Job result，详细过程保存在 child Session。

Jobs 是独立的后台任务生命周期。后台 shell 或 one-shot background provider 返回 Job id，使用 `job_output`、`job_list`、`job_kill` 管理，不能与 continuable child id 混用。大材料和大结果通过共享工作区文件交接，prompt/report 只携带任务、摘要与路径。

## refine

持续学习刻意放在次要位置。不要存研究资料、任务状态、工具输出或大上下文;只有出现重复失败、用户纠正或稳定可复用策略后才使用它。

- `inspect` 返回当前 revision、条目和近期事务。
- `apply` 需要 inspect 得到的 revision、trigger、具体 evidence、可验证的 expected outcome,以及最小 create/update/delete edits。
- `rollback` 需要当前 revision 和目标 transaction id,可附带 trigger 记录回滚动机,且只有相关条目没有发生漂移时才成功。

条目类型包括 `prompt`、`memory`、`skill` 与 `subagent`。skill/subagent 只能引用真实可见的工具;它们记录路由,不会创建能力或扩大权限。

## 配置

`stateDirectory` 必填。未配置选项时使用下列默认值。

| 选项 | 默认值 | 含义 |
| --- | --- | --- |
| `refineToolName` | `refine` | 持续学习工具名（可配置） |
| `allowGlobalRefinement` | `false` | 允许模型访问 global 学习状态 |
| `requireOrchestrationTools` | `true` | 要求 Agent catalog 具备 Subagent admission（`subagent`/`subagent_fork`）与 `agents`/`jobs` 控制（`list_agents`、`send_message`、`interrupt_agent`、`job_output`、`job_list`、`job_kill`） |
| `continual` | 有界默认值 | 学习条目、事务、状态与 prompt 限制 |

`dsh-prime-agent/runtime` 条目另接受官方预算字段（`computeMs`、`maxWallMs`、`maxOutputBytes`、`maxOldGenerationSizeMb`，同名逐字透传）、realm pool 治理项（`maxActiveRealms`、`maxIdleMs`、`maxHostCallsPerRun`、`maxParallelHostCallsPerRun`），以及 completion history 与投影上限（`maxCompletionHistoryEntries`、`maxCompletionHistoryEstimatedBytes`、`maxCompletionHistoryNodes`、`maxCompletionHistoryEntryBytes`、`maxCompletionFullBytes`、`maxCompletionProjectionBytes`）。

## 存储与安全

- 插件状态位于 `<stateDirectory>/continual`(学习层)与 `<stateDirectory>/realm-identity`(HMAC 密钥、Session 稳定 Realm identity 和按 Realm 的进程 leases);Session 文件名使用 id 的 keyed hash。
- 状态提交使用跨进程写锁与原子替换;损坏、超限、丢失或 revision 冲突都会明确失败。
- Host runtime 监控直接父进程;父进程消失后执行有界根级清理,避免孤儿进程继续持有 Realm leases。
- Continual-learning 条目以 JSON 引用的不可信建议记录进入 prompt,不能覆盖当前 system、user、权限或工具约束。
- 在宿主平台支持时请求 POSIX owner-only 权限。这些措施用于持久化与完整性加固,不代表安全沙箱。

## 开发

开发、类型检查和测试统一解析 `package-lock.json` 锁定的 npm 发布包；同级 `../deepseek-harness` checkout 仅用于审阅上游 diff 与 preset 快照，不参与模块解析。宿主提供的 DSH peer range 限制在兼容的 `0.1.x` 系列并标记为 optional，避免重复安装宿主服务；`@deepseek-ai/dsh-code-runtime` 是例外，由 Prime 包作为生产依赖直接交付，repl bridge 与 Realm seam 复用其官方 run/binding 类型契约（官方运行时本体仍由宿主提供）。

```sh
npm run typecheck
npm test
npm run build
```
