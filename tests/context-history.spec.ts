import { describe, expect, it } from 'vitest'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { readHistory, searchHistory } from '../src/context/history.js'

function prompt(session: Session, text: string) {
  return session.append('user/message', createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }), { surfaceOp: 'append' })
}

describe('recoverable conversation history', () => {
  it('retrieves original evidence after repeated surface replacement and session reconstruction', () => {
    const session = Session.create(SessionId('history'))
    const evidence = 'Condition: only update the blue file. 中文🙂'
    const original = prompt(session, evidence)
    const replacement = session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'directory' }], source: { kind: 'plugin', plugin: 'test' } }), {
      surfaceOp: { op: 'replace', start: original.seq, end: original.seq }, sourceEventSeqs: [original.seq],
    })
    session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'next directory' }], source: { kind: 'plugin', plugin: 'test' } }), {
      surfaceOp: { op: 'replace', start: replacement.seq, end: replacement.seq }, sourceEventSeqs: [replacement.seq],
    })
    const restored = Session.fromRestore(session.id, session.snapshotEvents(), session.header, session.inheritedEventCount)
    expect(searchHistory(restored, 'BLUE').hits.map(hit => hit.seq)).toEqual([original.seq])
    let text = '', offset = 0
    for (;;) {
      const page = readHistory(restored, original.seq, offset, 7)
      text += page.text
      if (page.nextOffset === null) break
      offset = page.nextOffset
    }
    expect(JSON.parse(text).content).toEqual([{ type: 'text', text: evidence }])
    expect(searchHistory(restored, 'directory').hits).toEqual([])
  })

  it('pages through empty scan ranges without losing older results', () => {
    const session = Session.create(SessionId('pages'))
    const old = prompt(session, 'needle')
    for (let i = 0; i < 1001; i++) prompt(session, 'distractor')
    const first = searchHistory(session, 'needle')
    expect(first.hits).toEqual([])
    expect(first.nextBefore).not.toBeNull()
    expect(searchHistory(session, 'needle', first.nextBefore!).hits.map(hit => hit.seq)).toEqual([old.seq])
  })

  it('searches literal message text without requiring JSON escaping', () => {
    const session = Session.create(SessionId('escaped'))
    const path = 'D:\\work\\a.ts'
    const event = prompt(session, `Read "${path}"\nthen check 日本語🙂`)
    expect(searchHistory(session, path).hits.map(hit => hit.seq)).toEqual([event.seq])
    expect(searchHistory(session, '"\nthen').hits.map(hit => hit.seq)).toEqual([event.seq])
    expect(searchHistory(session, '日本語🙂').hits.map(hit => hit.seq)).toEqual([event.seq])
  })

  it('excludes private reasoning, provider state, and non-conversation events', () => {
    const session = Session.create(SessionId('filtered'))
    const turn = session.append('turn/start', { turn: 1 })
    const message = createAssistantMessage({ content: [{ type: 'reasoning', text: 'private-token' }, { type: 'text', text: 'visible-answer' }], source: { provider: 'test', model: 'test', replayState: { secret: 'private-token' } } })
    const row = session.append('assistant/message', { message }, { surfaceOp: 'append' })
    expect(searchHistory(session, 'private-token').hits).toEqual([])
    expect(JSON.parse(readHistory(session, row.seq).text).content).toEqual([{ type: 'text', text: 'visible-answer' }])
    expect(() => readHistory(session, turn.seq)).toThrow()
  })

  it('rejects invalid cursors and keeps sessions isolated', () => {
    const a = Session.create(SessionId('a')), b = Session.create(SessionId('b'))
    prompt(a, 'private-a')
    prompt(b, 'public-b')
    expect(searchHistory(b, 'private-a').hits).toEqual([])
    for (const seq of [-1, 0.5, NaN, 999]) expect(() => readHistory(a, seq)).toThrow()
    for (const limit of [0, -1, 8001]) expect(() => readHistory(a, 0, 0, limit)).toThrow()
    expect(() => searchHistory(a, '', 99)).toThrow()
    expect(() => readHistory(a, 0, 9999)).toThrow()
  })
})
