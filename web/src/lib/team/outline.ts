// The team as rows for the outline: one per agent, helpers under whoever started them, with
// collapsed branches left out and (when "Hide finished" is on) each parent's finished helpers folded
// into one row. Pure, so it can be tested without a page.
import type { AgentInfo } from '../../../../shared/protocol.ts';

export type OutlineRow =
  | { kind: 'agent'; agent: AgentInfo; depth: number; hasChildren: boolean; expanded: boolean; parentId: string | null }
  | { kind: 'folded'; parentId: string; depth: number; agents: AgentInfo[]; key: string };

const FINISHED = new Set(['done', 'stopped']);

export interface OutlineOptions {
  /** Branches the person closed (agent ids). */
  collapsed: ReadonlySet<string>;
  /** Fold each parent's finished helpers (done, stopped; never failed) into one row. */
  hideFinished: boolean;
  /** Folded groups the person opened (parent ids). */
  openGroups: ReadonlySet<string>;
}

/** The rows to show, top to bottom, starting from the lead (depth 1). */
export function outlineRows(agents: AgentInfo[], opts: OutlineOptions): OutlineRow[] {
  const byParent = new Map<string | null, AgentInfo[]>();
  for (const a of [...agents].sort((x, y) => x.createdAt - y.createdAt)) {
    const list = byParent.get(a.parentId) ?? [];
    list.push(a);
    byParent.set(a.parentId, list);
  }
  const rows: OutlineRow[] = [];
  const walk = (a: AgentInfo, depth: number) => {
    const kids = byParent.get(a.id) ?? [];
    const expanded = !opts.collapsed.has(a.id);
    rows.push({ kind: 'agent', agent: a, depth, hasChildren: kids.length > 0, expanded, parentId: a.parentId });
    if (!expanded) return;
    const fold = opts.hideFinished && !opts.openGroups.has(a.id);
    const finished = fold ? kids.filter((k) => FINISHED.has(k.status) && !(byParent.get(k.id) ?? []).some(isLiveOrFailed(byParent))) : [];
    for (const k of kids) if (!finished.includes(k)) walk(k, depth + 1);
    if (finished.length) rows.push({ kind: 'folded', parentId: a.id, depth: depth + 1, agents: finished, key: `folded-${a.id}` });
  };
  for (const root of byParent.get(null) ?? []) walk(root, 1);
  return rows;
}

/** Whether an agent, or anything under it, is still working or failed (and so must stay in view). */
function isLiveOrFailed(byParent: Map<string | null, AgentInfo[]>) {
  const check = (a: AgentInfo): boolean => !FINISHED.has(a.status) || (byParent.get(a.id) ?? []).some(check);
  return check;
}

/**
 * Left padding for a row at `depth`: 16 px a level for the first three, then 6 px, so text keeps most
 * of a narrow panel at depth 4 and 5.
 */
export function indent(depth: number): number {
  const d = Math.max(0, depth - 1);
  return Math.min(d, 3) * 16 + Math.max(0, d - 3) * 6;
}

export type OutlineNode =
  | { kind: 'agent'; agent: AgentInfo; depth: number; hasChildren: boolean; expanded: boolean; children: OutlineNode[] }
  | { kind: 'folded'; parentId: string; depth: number; agents: AgentInfo[]; key: string };

/**
 * The same outline as nested nodes, for drawing: each parent's children sit in one group, so the tree
 * guide can be drawn on the group and nothing between rows can break it.
 */
export function outlineTree(agents: AgentInfo[], opts: OutlineOptions): OutlineNode[] {
  const rows = outlineRows(agents, opts);
  const roots: OutlineNode[] = [];
  const stack: { depth: number; node: Extract<OutlineNode, { kind: 'agent' }> }[] = [];
  for (const r of rows) {
    const node: OutlineNode = r.kind === 'agent' ? { ...r, children: [] } : r;
    while (stack.length && stack[stack.length - 1]!.depth >= r.depth) stack.pop();
    const parent = stack[stack.length - 1];
    (parent ? parent.node.children : roots).push(node);
    if (node.kind === 'agent') stack.push({ depth: r.depth, node });
  }
  return roots;
}
