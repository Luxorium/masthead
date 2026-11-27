/** How one tool call reads to a person: a verb and, when there is one, what it acted on. */
export interface ToolLine {
  verb: string;
  target?: string;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v ? v : undefined;
}

function oneLine(s: string | undefined, max = 120): string | undefined {
  if (!s) return undefined;
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * Describes a tool call. `live` picks the wording for something happening now ("Reading x") over
 * something finished ("Read x").
 */
export function toolLine(name: string, input: unknown, live = false): ToolLine {
  const i = (input ?? {}) as Record<string, unknown>;
  const v = (done: string, doing: string) => (live ? doing : done);
  switch (name) {
    case 'Read':
      return { verb: v('Read', 'Reading'), target: str(i.file_path) };
    case 'Edit':
    case 'NotebookEdit':
      return { verb: v('Edited', 'Editing'), target: str(i.file_path) ?? str(i.notebook_path) };
    case 'Write':
      return { verb: v('Wrote', 'Writing'), target: str(i.file_path) };
    case 'Bash':
      return { verb: v('Ran', 'Running'), target: oneLine(str(i.command)) };
    case 'Grep':
      return { verb: v('Searched for', 'Searching for'), target: oneLine(str(i.pattern)) };
    case 'Glob':
      return { verb: v('Looked for files', 'Looking for files'), target: str(i.pattern) };
    case 'WebSearch':
      return { verb: v('Searched the web', 'Searching the web'), target: oneLine(str(i.query)) };
    case 'WebFetch':
      return { verb: v('Fetched', 'Fetching'), target: str(i.url) };
    case 'TodoWrite':
    case 'TaskCreate':
    case 'TaskUpdate':
      return { verb: v('Updated its task list', 'Updating its task list') };
    case 'Skill':
      return { verb: v('Used skill', 'Using skill'), target: str(i.skill) };
    case 'ToolSearch':
      return { verb: v('Looked up a tool', 'Looking up a tool'), target: oneLine(str(i.query)) };
    case 'AskUserQuestion':
      return { verb: v('Asked you a question', 'Asking you a question') };
    case 'mcp__masthead__spawn_agent':
      return { verb: v('Started an agent:', 'Starting an agent:'), target: str(i.title) ?? str(i.name) };
    case 'mcp__masthead__send_message':
      return { verb: v('Messaged', 'Messaging'), target: str(i.to) };
    case 'mcp__masthead__list_agents':
      return { verb: v('Checked the team', 'Checking the team') };
    case 'mcp__masthead__stop_agent':
      return { verb: v('Stopped agent', 'Stopping agent'), target: str(i.name) };
    case 'mcp__masthead__set_effort':
      return { verb: v('Asked for effort', 'Asking for effort'), target: str(i.level) };
    case 'mcp__masthead__set_agent_effort':
      return { verb: v(`Set ${str(i.name) ?? 'an agent'} to`, `Setting ${str(i.name) ?? 'an agent'} to`), target: `${str(i.level) ?? '?'} effort` };
  }
  if (name.startsWith('mcp__')) {
    const [, server, ...rest] = name.split('__');
    return { verb: `${v('Used', 'Using')} ${rest.join('__') || 'a tool'}`, target: server };
  }
  return {
    verb: `${v('Used', 'Using')} ${name}`,
    target: oneLine(str(i.description) ?? str(i.file_path) ?? str(i.path) ?? str(i.command) ?? str(i.query)),
  };
}
