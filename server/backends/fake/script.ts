/**
 * What the fake backend does with a message, decided from its text alone so every run is the same.
 *
 * Plain phrases (also used by the conformance suite, so real backends get the same prompts):
 * - "Reply with exactly the word X"            -> replies X and remembers it in the session
 * - "What word did you reply with before?"      -> the remembered word (survives a resume)
 * - "Call the tool NAME with input {json}"      -> calls that team tool, replies with its result
 * - "Run the shell command `cmd`"               -> asks permission (kind 'command'), then "Ran cmd."
 * - "Count slowly …"                            -> a slow turn, so messages can arrive during it
 * Markers, for what the conformance prompts do not cover:
 * - [[think]]          a thinking block          - [[image]]        a tool result with an image
 * - [[question]]       a question to the person  - [[background]] / [[background 200ms]] a background
 *   task, then a turn the backend starts by itself  - [[background-silent]] the task ends, no turn
 * - [[limit]] / [[limit 60s]]  the usage limit   - [[error text]]   an ordinary failed turn
 * - [[crash]]          the process dies
 * The core's tidy message ("Call compact_team with the finished helpers to keep…") makes the lead call
 * list_agents, keep the first finished helper it lists (with a reason) and call compact_team.
 * Anything else gets "Fake reply: <the message's first line>".
 */
export type Step =
  | { kind: 'reply'; text: string }
  | { kind: 'word'; word: string }
  | { kind: 'recall' }
  | { kind: 'think'; text: string }
  | { kind: 'tool'; name: string; input: unknown }
  | { kind: 'image' }
  | { kind: 'command'; command: string }
  | { kind: 'question' }
  | { kind: 'slow'; text: string }
  | { kind: 'background'; ms?: number; silent: boolean }
  | { kind: 'limit'; seconds: number }
  | { kind: 'error'; message: string }
  | { kind: 'crash' }
  | { kind: 'compact' };

function duration(v: string | undefined): number | undefined {
  if (!v) return undefined;
  // A unit is required ("200ms", "60s"): a bare number is ignored, so "[[limit 60]]" cannot mean 60 ms.
  const m = /^(\d+)(ms|s)$/.exec(v.trim());
  if (!m) return undefined;
  return m[2] === 's' ? Number(m[1]) * 1000 : Number(m[1]);
}

export function plan(text: string, info: { hasImage?: boolean } = {}): Step[] {
  const steps: Step[] = [];
  for (const m of text.matchAll(/\[\[([a-z-]+)(?:\s+([^\]]*))?\]\]/g)) {
    const [, name, arg] = m;
    if (name === 'think') steps.push({ kind: 'think', text: arg?.trim() || 'Thinking about it.' });
    else if (name === 'image') steps.push({ kind: 'image' });
    else if (name === 'question') steps.push({ kind: 'question' });
    else if (name === 'background') steps.push({ kind: 'background', ms: duration(arg), silent: false });
    else if (name === 'background-silent') steps.push({ kind: 'background', ms: duration(arg), silent: true });
    else if (name === 'limit') steps.push({ kind: 'limit', seconds: (duration(arg) ?? 60_000) / 1000 });
    else if (name === 'error') steps.push({ kind: 'error', message: arg?.trim() || 'The fake turn failed.' });
    else if (name === 'crash') steps.push({ kind: 'crash' });
  }
  // The core's tidy message ("… Call compact_team with the finished helpers to keep and why …").
  if (/call compact_team with the finished helpers/i.test(text)) steps.push({ kind: 'compact' });
  const tool = /call the tool ([A-Za-z0-9_]+) with input (\{.*?\})(?=\s|$|[.,;])/i.exec(text);
  if (tool) {
    let input: unknown = {};
    try {
      input = JSON.parse(tool[2]!);
    } catch {
      input = { raw: tool[2] };
    }
    steps.push({ kind: 'tool', name: tool[1]!, input });
  }
  const cmd = /run the shell command `([^`]+)`/i.exec(text);
  if (cmd) steps.push({ kind: 'command', command: cmd[1]! });
  if (/count slowly/i.test(text)) steps.push({ kind: 'slow', text: '1\n2\n3\n4\n5\nDONE' });
  const extra = /also reply with the word ([A-Za-z0-9_-]+)/i.exec(text);
  if (extra) steps.push({ kind: 'reply', text: extra[1]! });
  if (/what word did you reply with before/i.test(text)) steps.push({ kind: 'recall' });
  const word = /reply with exactly the word ([A-Za-z0-9_-]+)/i.exec(text);
  if (word) steps.push({ kind: 'word', word: word[1]! });
  if (info.hasImage) steps.push({ kind: 'reply', text: 'I see an image.' });
  // Only markers that say nothing (think, background) still need a reply.
  if (!steps.some((s) => s.kind !== 'think')) {
    const first = text.trim().split('\n')[0] ?? '';
    steps.push({ kind: 'reply', text: `Fake reply: ${first.replace(/\[\[[^\]]*\]\]/g, '').trim().slice(0, 120) || '(empty)'}` });
  }
  return steps;
}
