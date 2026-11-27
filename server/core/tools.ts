// The team tools, defined once and backend-neutral (backends/types.ts ToolDef). Each backend binds
// them its own way: Claude Code as an in-process MCP server (backends/claude/mcp.ts), Codex as
// dynamic tools (backends/codex). Every call goes through the conversation, which enforces the tiers
// and limits. Descriptions are paid for on every request: keep them as short as they are.
import type { BackendCaps, JSONSchema, ToolDef } from '../backends/types.js';
import { EFFORTS, type Effort, type Tier } from '../../shared/protocol.js';
import type { Agent } from '../runtime/agent.js';
import { withArticle } from './prompts.js';

/** What the tools can do; implemented by the conversation. Every method returns the text the agent sees. */
export interface TeamActions {
  spawn(parent: Agent, title: string, task: string, effort: Effort | undefined): string;
  message(from: Agent, to: string, text: string, wait?: boolean): string;
  list(viewer: Agent): string;
  stop(caller: Agent, name: string): string;
  setOwnEffort(agent: Agent, level: Effort, reason: string): string;
  setAgentEffort(caller: Agent, name: string, level: Effort): string;
  autoEffort(): boolean;
  label(tier: Tier): string;
  /** The tier an agent of `tier` may start, from its team profile; null for the last tier. */
  childTier(tier: Tier): Tier | null;
  /** The agent's backend capabilities; all on when the conversation does not say. */
  caps?(agent: Agent): Pick<BackendCaps, 'efforts'> | undefined;
}

const str = (min: number, max: number, description?: string): JSONSchema => ({ type: 'string', minLength: min, maxLength: max, ...(description ? { description } : {}) });
const object = (properties: Record<string, JSONSchema>, required: string[]): JSONSchema => ({ type: 'object', properties, required, additionalProperties: false });

/** Reads an argument the model sent; the schema already said what it must be, so this is a guard only. */
const s = (v: unknown) => (typeof v === 'string' ? v : '');

/** The tools one agent gets, bound to that agent. */
export function teamToolDefs(agent: Agent, team: TeamActions): ToolDef[] {
  const child = team.childTier(agent.tier);
  const isLead = agent.info.parentId === null;
  // Effort levels this agent's backend actually has; no effort tools when it has none.
  const levels = (team.caps?.(agent)?.efforts ?? [...EFFORTS]).filter((e) => EFFORTS.includes(e));
  const effort = (description?: string): JSONSchema => ({ type: 'string', enum: levels, ...(description ? { description } : {}) });
  const level = (v: unknown): Effort | undefined => (levels.includes(v as Effort) ? (v as Effort) : undefined);
  const defs: ToolDef[] = [];
  const add = (name: string, description: string, input: JSONSchema, run: (a: Record<string, unknown>) => string) =>
    defs.push({ name, description, input, run: async (raw) => run((raw ?? {}) as Record<string, unknown>) });

  add(
    'send_message',
    'Send a short message to another agent in this conversation by name, e.g. "charlie" ("lead" and "parent" also work). A finished agent resumes with its context to read it. Use it to ask a question, pass on a finding or answer a message. It returns once delivered; any answer arrives later as a message.',
    isLead
      ? object({ to: str(1, 80), message: str(1, 20_000) }, ['to', 'message'])
      : object(
          { to: str(1, 80), message: str(1, 20_000), wait: { type: 'boolean', description: 'You need the answer to continue: end your turn and you resume when it arrives. Parent or lead only' } },
          ['to', 'message'],
        ),
    (a) => team.message(agent, s(a.to), s(a.message), a.wait === true),
  );
  add('list_agents', 'List the agents in this conversation: name, tier, status, effort, who started each and its task.', object({}, []), () => team.list(agent));

  if (child) {
    add(
      'spawn_agent',
      `Start ${withArticle(team.label(child))} agent on a task. It knows only what you write in "task". It is given the next name from the phonetic alphabet (bravo, charlie, …); the reply tells you which. Returns at once; the agent's report arrives later as an <agent-report> message.`,
      object(
        {
          title: str(1, 60, 'A few words on its job, shown to the person, e.g. "Review the API layer"'),
          task: str(1, 60_000, 'Everything the agent needs: goal, paths, constraints, what to send back'),
          ...(levels.length ? { effort: effort('Thinking effort to start at. Leave out for low; raise only for work that needs careful reasoning') } : {}),
        },
        ['title', 'task'],
      ),
      (a) => team.spawn(agent, s(a.title), s(a.task), level(a.effort)),
    );
    add(
      'stop_agent',
      'Stop an agent you started, or one started below it, together with everything under it. Only for work that is no longer wanted: a stopped agent sends no report. Never use it to wait for or collect a result.',
      object({ name: str(1, 80) }, ['name']),
      (a) => team.stop(agent, s(a.name)),
    );
  }

  if (team.autoEffort() && levels.length > 0) {
    add(
      'set_effort',
      isLead
        ? 'Change your own thinking effort from your next step on. Low is right for most work. Raise it when the task needs careful multi-step reasoning, subtle debugging or a design decision, or when you catch yourself making mistakes; lower it again afterwards. Change it at the start of a piece of work, not repeatedly.'
        : 'Ask to change your own thinking effort. Low is right for most work. Lowering applies at once. Raising needs the approval of the agent that started you: this sends the request and returns; keep working at your current level. If approved, the new level applies by itself from your next step; no message is sent. list_agents shows your current effort.',
      object({ level: effort(), reason: str(1, 500, 'One sentence on why') }, ['level', 'reason']),
      (a) => (level(a.level) ? team.setOwnEffort(agent, level(a.level)!, s(a.reason)) : 'Error: unknown effort level.'),
    );
    if (child) {
      add(
        'set_agent_effort',
        'Set the thinking effort of an agent you started, or of one started below it. Use it to approve or adjust an effort request, or to raise or lower effort as the work changes.',
        object({ name: str(1, 80), level: effort() }, ['name', 'level']),
        (a) => (level(a.level) ? team.setAgentEffort(agent, s(a.name), level(a.level)!) : 'Error: unknown effort level.'),
      );
    }
  }
  return defs;
}
