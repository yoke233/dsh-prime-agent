---
name: dsh-log-triage
description: Diagnose recent DeepSeek Harness (DSH) session, tool-call, REPL, provider, transport, or authentication errors from ~/.dsh. Use when a user reports DSH 调用错误, ToolCallError, repl cell failed, frequent red tool results, or asks to inspect recent ~/.dsh logs for a project or time window.
---

# DSH log triage

Find the errors the user actually saw. Prime REPL failures are nested inside otherwise successful outer `tool/result` events; an outer-only count produces a false zero.

## Analyzer

Run the bundled Node.js analyzer first:

```powershell
node .agents/skills/dsh-log-triage/scripts/analyze-dsh-logs.mjs --project D:/project/dsh-prime-agent --hours 2
```

Use `--since <local-iso>` with optional `--until <local-iso>` for a fixed window, `--json` for machine-readable evidence, and `--examples 0` for counts only. The analyzer requires Node.js with `node:zlib.zstdDecompressSync` support. Its output is the baseline; inspect matching event records only when classification needs deeper context.

## 1. Freeze scope

Extract from the request:

- exact time window; use it without widening;
- project cwd; default to the current cwd only when the user names no project;
- requested symptom, such as `ToolCallError`, provider failure, timeout, or all call errors.

Resolve `~/.dsh/sessions` from the current user's home directory. Candidate files are `session.jsonl.zstd`. Select candidates by modification time, then read each file's `session` event and retain only sessions whose normalized `cwd` equals the scoped project. Filter individual events by their millisecond `time`/`time0`; do not treat session mtime as the error timestamp.

Completion criterion: every session overlapping the requested project and time window is included, and no older or other-project session is included.

## 2. Decode without leaking secrets

Decode every complete frame in the concatenated Zstandard JSONL artifact; a one-stream decoder may stop after the first appended frame and falsely report zero errors. Do not print credentials, request headers, complete prompts, user messages, tool arguments, or full session transcripts. Prefer the bundled analyzer, which scans frame boundaries before decompression.

Redact before displaying:

- bearer/auth tokens, API keys, cookies, and `sk-*` values;
- request payloads and headers;
- unrelated user content.

Project paths and error messages are evidence and may remain visible unless they contain credentials.

## 3. Count both failure planes

Report these separately.

### Turn failures

Count `type === "turn/end"` where:

```ts
data.reason.kind === "error"
```

Preserve `data.reason.error.code` and the redacted message. These identify provider, transport, authentication, WebSocket, and uncaught harness failures.

### Nested tool/REPL failures

Inspect only records with `type === "tool/result"`. Recursively traverse `data`, locate objects with `isError === true`, and collect text from that object's `content`. Retain actual error payloads beginning with `Error:`.

The common Prime shape is conceptually:

```text
tool/result
  data.message.content[]
    content[]
      isError: true
      content[].text: "Error: repl cell failed ... ToolCallError ..."
```

Do not rely on `tool/result.data.isError`; it may be absent or false while the nested result is an error. Do not count mentions of `ToolCallError` in request headers, source code search results, assistant prose, user messages, or generated declarations. Deduplicate identical error text within one `tool/result` record, not across distinct calls.

Also count all `tool/result` records per session so the report can show `errors / results` rather than an ungrounded adjective such as “frequent.”

Completion criterion: manually inspect at least one detected nested error record and one non-error record to prove the selector distinguishes them.

## 4. Reconstruct the failing call

For every error record, use the event's turn, step, source call id, or nearest matching `tool/call` to identify:

- provider/model from `request/context`;
- exact event timestamp;
- outer tool name;
- nested binding/tool name when the error exposes `ToolCallError.toolName` or names it in the message;
- concise failure message.

Do not print complete tool arguments. Extract only non-secret facts needed for causality: path form, regex parse error, timeout limit, hunk condition, missing file, or unsupported API.

## 5. Classify causes

Use evidence-backed categories:

- invalid regex or escaping;
- wrong/missing path or unsupported absolute path;
- stale/ambiguous edit or patch precondition;
- generated REPL syntax/reference error;
- unsupported Realm operation such as dynamic `import()` or `require()`;
- direct tool call rejected because Prime exposes only `repl`;
- host binding timeout/budget/cancellation;
- provider transport/WebSocket/authentication failure;
- harness/plugin exception.

Distinguish protection working as designed from a defect. A rejected invalid regex, stale edit, or forbidden path is normally correct enforcement. A tool declaration that omits a required constraint is a prompt/schema contract gap. A provider or harness error must have a matching structured turn/error event or exact nested payload; do not infer it from generic red UI.

## 6. Deliver the short answer first

Lead with:

1. number of scoped sessions, tool results, nested tool errors, and fatal turn errors;
2. top cause and whether it is model input, documented enforcement, contract gap, provider/network, or harness defect;
3. 3–7 representative timestamped errors;
4. ranked category counts and concrete next fix.

State selector limitations. If the reported error is absent, say exactly which planes and files were checked; explain that pre-session or unflushed failures may not be persisted. Never report “zero errors” until the nested `isError` traversal has also returned zero.
