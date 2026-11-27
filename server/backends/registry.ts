/**
 * The agent backends this Masthead can use: Claude Code and Codex, or only the scripted fake when the
 * environment selects it on purpose (MASTHEAD_BACKEND=fake with MASTHEAD_ALLOW_FAKE=1; the page can
 * never choose it). Detection runs at start-up and on demand; its result, with each usable backend's
 * models, is what the page shows and what team profiles are built from.
 */
import { PALETTE, type Effort, type TeamProfile, type TierSpec } from '../../shared/protocol.js';
import type { ClaudeInfo } from './claude/env.js';
import { ClaudeBackend } from './claude/session.js';
import { CodexBackend, type CodexOptions } from './codex/index.js';
import { codexTeamModels } from './codex/families.js';
import { FakeBackend, fakeBackendSelected } from './fake/index.js';
import type { Backend, BackendInfo, ModelInfo } from './types.js';

/** What the page learns about one backend. */
export type BackendStatus = BackendInfo & { models: ModelInfo[] };

export interface RegistryOptions {
  env?: Record<string, string | undefined>;
  /** Claude Code as found at start-up. */
  claude?: ClaudeInfo;
  /** Looks for Claude Code again on each detectAll() (a real start passes findClaude). */
  findClaude?: () => ClaudeInfo;
  /** Options for the Codex backend (tests pass a fake CLI); false leaves Codex out. */
  codex?: CodexOptions | false;
}

export const CODEX_PROFILE = 'codex';

export class BackendRegistry {
  /** The fake backend when the environment selects it; it then stands in for every backend. */
  readonly fake: FakeBackend | null;
  private backends = new Map<string, Backend>();
  private statuses = new Map<string, BackendStatus>();

  constructor(opts: RegistryOptions = {}) {
    const env = opts.env ?? process.env;
    if (env.MASTHEAD_BACKEND === 'fake' && !fakeBackendSelected(env)) {
      throw new Error('MASTHEAD_BACKEND=fake is for tests only and also needs MASTHEAD_ALLOW_FAKE=1.');
    }
    this.fake = fakeBackendSelected(env) ? new FakeBackend({ stepMs: Number(env.MASTHEAD_FAKE_STEP_MS) || 20 }) : null;
    if (this.fake) {
      this.backends.set(this.fake.id, this.fake);
      this.statuses.set(this.fake.id, { id: this.fake.id, label: this.fake.label, available: true, path: null, version: 'fake-1', signedIn: true, models: [] });
      return;
    }
    const claude = opts.claude ?? { path: null, version: null };
    this.backends.set('claude-code', new ClaudeBackend({ path: claude.path, version: claude.version, error: claude.error, find: opts.findClaude }));
    // Until detectAll() has run, Claude Code is as it was found at start-up, and Codex is unknown.
    this.statuses.set('claude-code', {
      id: 'claude-code',
      label: 'Claude Code',
      available: claude.path !== null,
      path: claude.path,
      version: claude.version,
      signedIn: null,
      ...(claude.error ? { error: claude.error } : {}),
      models: [],
    });
    if (opts.codex !== false) this.backends.set('codex', new CodexBackend(opts.codex ?? {}));
  }

  /** Detects every backend and reads the models of the usable ones. Never throws. */
  async detectAll(): Promise<BackendStatus[]> {
    await Promise.all(
      [...this.backends.values()].map(async (b) => {
        let info: BackendInfo;
        try {
          info = await b.detect();
        } catch (e) {
          info = { id: b.id, label: b.label, available: false, path: null, version: null, signedIn: null, error: (e as Error)?.message || String(e) };
        }
        let models: ModelInfo[] = [];
        if (info.available) {
          try {
            models = await b.models();
          } catch (e) {
            info = { ...info, warning: `Its models could not be read: ${(e as Error)?.message || String(e)}` };
          }
        }
        this.statuses.set(b.id, { ...info, models });
      }),
    );
    return this.status();
  }

  status(): BackendStatus[] {
    return [...this.statuses.values()].map((s) => ({ ...s, models: s.models.map((m) => ({ ...m })) }));
  }

  /** The backend for `id` if it can be used now; the fake stands in for all when selected. */
  get(id: string): Backend | undefined {
    if (this.fake) return this.fake;
    if (this.statuses.get(id)?.available === false) return undefined;
    return this.backends.get(id);
  }

  /** Why `id` cannot be used, for the error an agent on it gets. */
  unavailableReason(id: string): string {
    const s = this.statuses.get(id);
    if (!s) return `There is no agent backend called "${id}".`;
    return s.error ?? `${s.label} cannot be used right now.`;
  }

  /** Claude Code as the latest detection saw it, in the shape the page's old `claude` field uses. */
  claudeInfo(): ClaudeInfo | null {
    const s = this.statuses.get('claude-code');
    return s ? { path: s.path, version: s.version, ...(s.error ? { error: s.error } : {}) } : null;
  }

  /** Team profiles built from what is installed: the Codex team when Codex is usable. */
  generatedProfiles(): TeamProfile[] {
    const codex = this.statuses.get('codex');
    if (this.fake || !codex?.available) return [];
    const p = codexProfile(codex.models);
    return p ? [p] : [];
  }

  async dispose(): Promise<void> {
    await Promise.all([...this.backends.values()].map((b) => b.dispose?.().catch(() => {})));
  }
}

const TIER_SHAPE: Array<{ effort: Effort; max: number; lean: boolean }> = [
  { effort: 'xhigh', max: 1, lean: false },
  { effort: 'xhigh', max: 3, lean: false },
  { effort: 'high', max: 4, lean: true },
  { effort: 'medium', max: 4, lean: true },
];

/** The highest level a model supports that is not above `want`. */
function effortFor(m: ModelInfo, want: Effort): Effort {
  const order: Effort[] = ['low', 'medium', 'high', 'xhigh'];
  for (let i = order.indexOf(want); i >= 0; i--) if (m.efforts.includes(order[i]!)) return order[i]!;
  return m.efforts[0] ?? 'low';
}

/**
 * The built-in Codex team, built from the installed Codex's model list: the lead on its most capable
 * model, then the lower ones (see codex/families.ts for the order), up to four tiers; one tier when
 * only one model is offered. A proposal the person can edit; nothing here names a model.
 */
export function codexProfile(models: ModelInfo[]): TeamProfile | null {
  const team = codexTeamModels(models).slice(0, TIER_SHAPE.length);
  if (team.length === 0) return null;
  const tiers: TierSpec[] = team.map((m, i) => ({
    id: `${CODEX_PROFILE}:${i}`,
    label: m.label,
    backend: 'codex',
    model: m.id,
    effort: effortFor(m, TIER_SHAPE[i]!.effort),
    max: TIER_SHAPE[i]!.max,
    lean: TIER_SHAPE[i]!.lean,
    colour: PALETTE[i % PALETTE.length]!,
  }));
  return {
    id: CODEX_PROFILE,
    label: 'Codex',
    builtIn: true,
    description: "Built from the installed Codex's model list. Change it in the settings.",
    tiers,
  };
}
