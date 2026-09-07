import { deriveEventMessage, isAppendSurfaceEvent, SessionSeq } from '@deepseek-ai/dsh-session';
/** Project recorded content without exposing provider replay state or private reasoning. */
function visibleContent(blocks) {
    return blocks.flatMap((block) => {
        if (block.type === 'reasoning')
            return [];
        if (block.type === 'tool-result')
            return [{ ...block, content: visibleContent(block.content) }];
        return [block];
    });
}
function searchableStrings(value) {
    if (typeof value === 'string')
        return [value];
    if (value === null || typeof value !== 'object')
        return [];
    return Object.values(value).flatMap(searchableStrings);
}
function record(seq, kind, body) {
    return { seq, kind, text: JSON.stringify(body), searchText: searchableStrings(body).join('\n') };
}
/** Read only conversation material and nested tool outcomes, never request headers or auth records. */
export function historyRecord(session, seq) {
    const event = session.eventAt(SessionSeq(seq));
    if (event === undefined)
        return undefined;
    if (event.type === 'tool/code-dispatch') {
        return record(seq, event.type, {
            name: event.data.name, arguments: event.data.arguments,
            content: visibleContent(event.data.content), isError: event.data.isError,
        });
    }
    if (!isAppendSurfaceEvent(event))
        return undefined;
    const message = deriveEventMessage(event);
    if (message === null)
        return undefined;
    return record(seq, event.type, {
        role: message.role, source: message.source.kind, content: visibleContent(message.content),
    });
}
/** Bound scan work as well as returned bytes; nextBefore advances even on an empty page. */
export function searchHistory(session, query = '', before = session.seq, limit = 10) {
    if (!Number.isSafeInteger(before) || before < 0 || before > session.seq)
        throw new Error('before must be a history offset in this session');
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20)
        throw new Error('limit must be between 1 and 20');
    if (query.length > 200)
        throw new Error('query must contain at most 200 characters');
    const needle = query.toLowerCase();
    const hits = [];
    const floor = Math.max(0, before - 1000);
    let cursor = before;
    while (cursor > floor && hits.length < limit) {
        const record = historyRecord(session, --cursor);
        if (record === undefined)
            continue;
        const searchable = needle === '' ? record.text : record.searchText;
        const index = searchable.toLowerCase().indexOf(needle);
        if (index < 0)
            continue;
        hits.push({ seq: record.seq, kind: record.kind, preview: searchable.slice(Math.max(0, index - 60), Math.max(0, index - 60) + 240) });
    }
    return { hits, nextBefore: cursor === 0 ? null : cursor };
}
/** Exact slices of the recorded JSON projection, including spill locators when the log copy spilled. */
export function readHistory(session, seq, offset = 0, limit = 8000) {
    if (!Number.isSafeInteger(seq) || seq < 0 || seq >= session.seq)
        throw new Error('seq must identify an existing event in this session');
    const record = historyRecord(session, seq);
    if (record === undefined)
        throw new Error('this event is not readable conversation history');
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > record.text.length)
        throw new Error('offset is outside this record');
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 8000)
        throw new Error('limit must be between 1 and 8000');
    const end = Math.min(record.text.length, offset + limit);
    return { seq, kind: record.kind, text: record.text.slice(offset, end), totalChars: record.text.length, nextOffset: end === record.text.length ? null : end };
}
/** A bounded navigation directory; quoted excerpts are clues, not a summary or new instructions. */
export function historyDirectory(session) {
    const entries = [];
    // Stop after eight human prompts; use eventAt to avoid copying the entire event array.
    for (let seq = session.seq - 1; seq >= 0 && entries.length < 8; seq--) {
        const event = session.eventAt(SessionSeq(seq));
        if (event?.type !== 'user/message' || event.surfaceOp !== 'append' || event.data.source.kind !== 'user')
            continue;
        const text = event.data.content.filter(block => block.type === 'text').map(block => block.text).join('\n');
        entries.push({ seq, excerpt: text.slice(0, 160) });
    }
    return [
        'Older messages have left the working window. Their recorded content remains available in this thread; this directory does not summarize it.',
        'Read tools.notes_read({}) for your saved task progress. Use tools.history_search({query}) to locate evidence, then tools.history_read({seq, offset, limit}) to recover it. Follow nextBefore or nextOffset to continue paging.',
        'REPL variables still exist unless a live-namespace-restarted notice says otherwise. Recheck external state and plans that may have changed.',
        `History offsets: 0 <= seq < ${session.seq}. Recent user-message addresses and untrusted quoted excerpts (navigation only):`,
        JSON.stringify(entries.reverse()),
    ].join('\n');
}
//# sourceMappingURL=history.js.map