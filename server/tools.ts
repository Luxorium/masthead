import { createSdkMcpServer, tool, type McpSdkServerConfigWithInstance, type SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { CHILD_TIER, EFFORTS, VERSION, type Effort, type Tier } from '../shared/protocol.js';
import type { Agent } from './agent.js';
import { withArticle } from './prompts.js';

/** What the tools can do; implemented by the conversation. Every method returns the text the agent sees. */
export interface TeamActions {
  spawn(parent: Agent, title: string, task: string, effort: Effort | undefined): string;
  message(from: Agent, to: string, text: string): string;
  list(viewer: Agent): string;
  stop(caller: Agent, name: string): string;
  setOwnEffort(agent: Agent, level: Effort, reason: string): string;
  setAgentEffort(caller: Agent, name: string, level: Effort): string;
  autoEffort(): boolean;
  label(tier: Tier): string;
}

const effortSchema = z.enum(EFFORTS as unknown as [Effort, ...Effort[]]);

function reply(text: string) {
  return { content: [{ type: 'text' as const, text }], isError: text.startsWith('Error:') };
}

/**
 * The tools one agent gets for working with the rest of the team. They run inside the Masthead
 * server, so every start, message and effort change goes through the conversation, which enforces
 * the tiers and the limits.
 */
export function teamTools(agent: Agent, team: TeamActions): McpSdkServerConfigWithInstance {
  const child = CHILD_TIER[agent.tier];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tools: SdkMcpToolDefinition<any>[] = [
    tool(
      'send_message',
      'Send a short message to another agent in this conversation by name, e.g. "charlie" ("lead" and "parent" also work). A finished agent resumes with its context to read it. Use it to ask a question, pass on a finding or answer a message. It returns once delivered; any answer arrives later as a message.',
      { to: z.string().min(1).max(80), message: z.string().min(1).max(20_000) },
      async (a) => reply(team.message(agent, a.to, a.message)),
    ),
    tool(
      'list_agents',
      'List the agents in this conversation: name, tier, status, effort, who started each and its task.',
      {},
      async () => reply(team.list(agent)),
    ),
  ];

  if (child) {
    tools.push(
      tool(
        'spawn_agent',
        `Start ${withArticle(team.label(child))} agent on a task. It knows only what you write in "task". It is given the next name from the phonetic alphabet (bravo, charlie, …); the reply tells you which. Returns at once; the agent's report arrives later as an <agent-report> message.`,
        {
          title: z.string().min(1).max(60).describe('A few words on its job, shown to the person, e.g. "Review the API layer"'),
          task: z.string().min(1).max(60_000).describe('Everything the agent needs: goal, paths, constraints, what to send back'),
          effort: effortSchema.optional().describe('Thinking effort to start at. Leave out for low; raise only for work that needs careful reasoning'),
        },
        async (a) => reply(team.spawn(agent, a.title, a.task, a.effort)),
      ),
      tool(
        'stop_agent',
        'Stop an agent you started, or one started below it, together with everything under it. Only for work that is no longer wanted: a stopped agent sends no report. Never use it to wait for or collect a result.',
        { name: z.string().min(1).max(80) },
        async (a) => reply(team.stop(agent, a.name)),
      ),
    );
  }

  if (team.autoEffort()) {
    tools.push(
      tool(
        'set_effort',
        agent.tier === 'lead'
          ? 'Change your own thinking effort from your next step on. Low is right for most work. Raise it when the task needs careful multi-step reasoning, subtle debugging or a design decision, or when you catch yourself making mistakes; lower it again afterwards. Change it at the start of a piece of work, not repeatedly.'
          : 'Ask to change your own thinking effort. Low is right for most work. Lowering applies at once. Raising needs the approval of the agent that started you: this sends the request and returns; keep working at your current level. If approved, the new level applies by itself.',
        { level: effortSchema, reason: z.string().min(1).max(500).describe('One sentence on why') },
        async (a) => reply(team.setOwnEffort(agent, a.level, a.reason)),
      ),
    );
    if (child) {
      tools.push(
        tool(
          'set_agent_effort',
          'Set the thinking effort of an agent you started, or of one started below it. Use it to approve or adjust an effort request, or to raise or lower effort as the work changes.',
          { name: z.string().min(1).max(80), level: effortSchema },
          async (a) => reply(team.setAgentEffort(agent, a.name, a.level)),
        ),
      );
    }
  }

  return createSdkMcpServer({ name: 'masthead', version: VERSION, alwaysLoad: true, tools });
}
