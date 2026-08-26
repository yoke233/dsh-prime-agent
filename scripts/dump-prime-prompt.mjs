#!/usr/bin/env node

import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { boot, loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import { createUserMessage, isAgentLoopRequest } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'

const PROJECT_ROOT = resolve(import.meta.dirname, '..')
const BASE_PATCH = fileURLToPath(import.meta.resolve('@deepseek-ai/dsh-base/cordis.patch.yml'))
const PRIME_PATCH = join(PROJECT_ROOT, 'cordis.patch.yml')
const PRIME_PRESET = join(PROJECT_ROOT, 'agent-presets/prime')
const PRIME_AGENT_URL = pathToFileURL(join(PROJECT_ROOT, 'lib/index.js')).href
const PRIME_REFINE_SKILL_URL = pathToFileURL(join(PROJECT_ROOT, 'lib/refine-skill-provider.js')).href
const PRIME_RESTRICTIONS_URL = pathToFileURL(join(PROJECT_ROOT, 'lib/tool-restrictions.js')).href
const PRIME_RUNTIME_URL = pathToFileURL(join(PROJECT_ROOT, 'lib/runtime.js')).href
const DEFAULT_OUTPUT = join(process.cwd(), 'prompt-dumps', 'prime-prompt.txt')

function usage() {
  return [
    'Usage: node scripts/dump-prime-prompt.mjs [--output <file>] [--cwd <directory>] [--system-only] [--stdout]',
    '',
    'Runs one normal Prime Agent turn and captures the final request at the LLM stream boundary.',
    'The plain-text dump defaults to ./prompt-dumps/prime-prompt.txt.',
    '--system-only prints only request.system; injected messages such as the skill catalog are shown by the default dump.',
  ].join('\n')
}

function parseArgs(argv) {
  const options = { cwd: process.cwd(), output: DEFAULT_OUTPUT, systemOnly: false, stdout: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--help' || arg === '-h') return { help: true, ...options }
    if (arg === '--system-only') {
      options.systemOnly = true
      continue
    }
    if (arg === '--stdout') {
      options.stdout = true
      continue
    }
    if (arg === '--cwd' || arg === '--output') {
      const value = argv[index + 1]
      if (value === undefined || value.startsWith('--')) throw new Error('missing value for ' + arg)
      index += 1
      if (arg === '--cwd') options.cwd = resolve(value)
      else options.output = resolve(value)
      continue
    }
    throw new Error('unknown argument: ' + arg)
  }
  return { help: false, ...options }
}

function replacePluginName(value, from, to) {
  if (Array.isArray(value)) return value.map(item => replacePluginName(item, from, to))
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replacePluginName(item, from, to)]))
  }
  return value === from ? to : value
}

function renderContent(blocks) {
  return blocks.map(block => {
    if (block.type === 'text' || block.type === 'reasoning') return block.text
    return JSON.stringify(block, null, 2)
  }).join('\n')
}

function renderMessage(message, index) {
  const source = message.source?.kind === undefined ? '' : ' / ' + message.source.kind
  return '### ' + String(index + 1) + '. ' + message.role + source + '\n\n' + renderContent(message.content)
}

function renderTool(tool) {
  return '### ' + tool.name + '\n\n' + JSON.stringify(tool, null, 2)
}

function contextUsage(request) {
  const system = request.system ?? ''
  const messages = JSON.stringify(request.messages)
  const tools = JSON.stringify(request.tools ?? [])
  const characters = system.length + messages.length + tools.length
  return { characters, tokens: Math.ceil(characters / 4) }
}

function renderUsageLine(value) {
  return 'Prompt context usage (estimated): ' + value.tokens.toLocaleString('en-US')
    + ' tokens (' + value.characters.toLocaleString('en-US') + ' characters)'
}

function renderDump(request) {
  const messages = request.messages.map(renderMessage).join('\n\n')
  const tools = (request.tools ?? []).map(renderTool).join('\n\n')
  return [
    renderUsageLine(contextUsage(request)),
    '',
    '# Prime Model Request Dump',
    '',
    '## Route',
    '',
    '- provider: ' + request.provider,
    '- model: ' + request.model,
    '',
    '## System Prompt',
    '',
    request.system ?? '(empty)',
    '',
    '## Messages',
    '',
    messages || '(none)',
    '',
    '## Model-visible Tools',
    '',
    tools || '(none)',
    '',
  ].join('\n')
}

async function copyPrimePreset(target) {
  await mkdir(target, { recursive: true })
  const composition = (await readFile(join(PRIME_PRESET, 'agent.cordis.yml'), 'utf8'))
    .replace(/(^\s*name:\s*)dsh-prime-agent\s*$/m, '$1' + PRIME_AGENT_URL)
    .replace(/(^\s*name:\s*)dsh-prime-agent\/refine-skill-provider\s*$/m, '$1' + PRIME_REFINE_SKILL_URL)
    .replace(/(^\s*name:\s*)dsh-prime-agent\/tool-restrictions\s*$/m, '$1' + PRIME_RESTRICTIONS_URL)
  await writeFile(join(target, 'agent.cordis.yml'), composition)
  await writeFile(join(target, 'preset.yml'), await readFile(join(PRIME_PRESET, 'preset.yml'), 'utf8'))
}

function captureResponse() {
  return (async function* () {
    const text = 'prompt captured'
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'usage', usage: { inputTokens: 0, outputTokens: 0 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  })()
}

async function main() {
  let options
  try {
    options = parseArgs(process.argv.slice(2))
  } catch (error) {
    process.stderr.write((error instanceof Error ? error.message : String(error)) + '\n\n' + usage() + '\n')
    process.exitCode = 2
    return
  }
  if (options.help) {
    process.stdout.write(usage() + '\n')
    return
  }

  const scratch = await mkdtemp(join(tmpdir(), 'dsh-prime-prompt-dump-'))
  const previousHome = process.env.DSH_HOME
  let ctx
  let handle
  try {
    const home = join(scratch, 'home')
    const presetRoot = join(scratch, 'presets')
    await copyPrimePreset(join(presetRoot, 'prime'))
    const configPath = join(scratch, 'cordis.yml')
    await writeFile(configPath, '[]\n')
    process.env.DSH_HOME = home

    const basePatches = loadOverlayPatches('prime-prompt-dump', BASE_PATCH).map(patch => ({
      ...patch,
      ...(Array.isArray(patch.insert)
        ? { insert: patch.insert.filter(entry => entry.id !== 'hmr') }
        : {}),
    }))
    const primePatches = replacePluginName(
      loadOverlayPatches('prime-prompt-dump', PRIME_PATCH),
      'dsh-prime-agent/runtime',
      PRIME_RUNTIME_URL,
    )
    const presetPatch = [{
      insert: [{
        id: 'agent-presets',
        name: '@deepseek-ai/dsh-agent-presets',
        config: {
          default: 'prime',
          roots: [{ path: presetRoot, trust: 'system' }],
          includeUserRoot: false,
        },
      }],
    }]

    ctx = await boot(
      'prime-prompt-dump',
      configPath,
      [...basePatches, ...primePatches, ...presetPatch],
      undefined,
      import.meta.url,
    )

    let capturedRequest
    ctx.on('llm/stream', request => {
      if (isAgentLoopRequest(request)) {
        if (capturedRequest !== undefined) throw new Error('prompt dump expected exactly one Agent Loop model request')
        capturedRequest = request
      }
      return captureResponse()
    })

    const selection = ctx.agentDefaultModel.currentSelection()

    handle = await ctx.agents.create({
      sessionId: SessionId('prime-prompt-dump'),
      meta: { cwd: options.cwd, agentPreset: 'prime' },
      agentOptions: { provider: selection.provider, model: selection.model },
      setup: agentCtx => ctx.agentPresets.mount(agentCtx, 'prime').then(() => undefined),
    })

    handle.agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'Capture this Prime request without taking any actions.' }],
      source: { kind: 'user' },
    }))
    await handle.agent.whenIdle()
    if (capturedRequest === undefined) throw new Error('Prime Agent completed without issuing a model request')

    const output = options.systemOnly
      ? renderUsageLine(contextUsage(capturedRequest)) + '\n\n' + (capturedRequest.system ?? '') + '\n'
      : renderDump(capturedRequest)
    if (options.stdout) process.stdout.write(output)
    else {
      await mkdir(dirname(options.output), { recursive: true })
      await writeFile(options.output, output)
      process.stdout.write(options.output + '\n')
    }
  } finally {
    await handle?.dispose()
    await ctx?.fiber.dispose()
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    await rm(scratch, { recursive: true, force: true })
  }
}

await main()
