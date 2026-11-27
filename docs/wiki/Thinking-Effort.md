# Thinking effort

**Effort** is a setting Claude Code passes to the model that controls how much it reasons before acting. Higher effort is slower and uses more tokens; lower is faster and cheaper. Masthead manages effort per agent. This page explains the rules and where they live.

## Levels

`Effort` in `shared/protocol.ts` is `'low' | 'medium' | 'high' | 'xhigh'`, shown as Low, Medium, High and Extra (`EFFORT_LABEL`). Claude Code also knows a `max` level; Masthead deliberately leaves it out, so no agent can reach it. `effortRank()` orders the levels and `capEffort(wanted, ceiling)` returns the lower of two.

## Two modes: automatic effort on or off

The settings field `autoEffort` (default on) chooses the mode. Each tier also has an `effort` value in the settings, which means different things in the two modes:

| | Automatic effort **on** | Automatic effort **off** |
|---|---|---|
| Tier `effort` setting | The **ceiling**: the highest level an agent of that tier may reach. | The level every agent of that tier runs at. |
| Starting level | `low` (the lead) or what the parent asked for, capped (sub-agents). | The tier's level. |
| `set_effort` / `set_agent_effort` tools | Given to agents. | Not given; and the conversation refuses them if called. |
| Prompt text about effort | Included, naming the level the agent runs at. | Left out. |

Default ceilings (`defaultSettings()` in `server/config.ts`): lead `xhigh`, Opus `xhigh`, Sonnet `high`, Haiku `medium`. In the team panel each tier has a selector labelled "Effort up to" (automatic effort on) or "Effort" (off), and an "Automatic effort" checkbox.

## Rules with automatic effort on

1. **Agents start low unless their parent says otherwise.** The lead is created at `low` (`Conversation.create()`). A sub-agent starts at the `effort` argument its parent gave `spawn_agent`, or `low` if none, capped at its tier's ceiling (`spawn()`). So a parent can start a child above low without anyone's approval; that is one way the rule "agents higher up set the effort of those below" shows up. The system prompt tells each agent its real level ("You run at high thinking effort; …", `systemAppend()` gets `effort: info.effort` from `launch()`), so an agent started high knows that asking for medium would lower it.
2. **The lead changes its own effort.** `set_effort` from the lead applies at once (`setOwnEffort()`: no parent, so no approval step).
3. **Any agent may lower its own effort** at once. The reply says which way it went and from where: "Effort lowered from medium to low, from your next step on."
4. **Other agents must ask to raise it.** `set_effort` from a sub-agent with a higher level sends an *effort request* message to its parent and returns "Asked "bravo" to raise you from low to high. Keep working at low; if approved, the change applies by itself." The parent must be the lead or live, otherwise the request is refused.
5. **Agents above can set anyone below.** `set_agent_effort` works on any descendant (checked with `isAncestor()`), not just direct children. It is how a parent approves a request, picks a different level, or changes effort as work changes. Only agents that can start others get this tool.
6. **Ceilings always apply.** Both tools refuse a level above the target tier's ceiling ("The person sets that limit"); `set_effort`'s refusal also names the agent's current level.
7. **Approval is silent.** `set_agent_effort` changes the level and adds a notice to the target's transcript ("Effort set to high by "bravo" (was low)."); it sends the target no message. A message would make the agent run one more turn, whose reply ("Noted") could become its report. The caller's reply says ""charlie" raised from low to high effort."

## How a change reaches Claude Code

`Agent.setEffort(level)` updates `info.effort`, broadcasts the change, and calls `q.applyFlagSettings({ effortLevel: level })` on the live process so it applies "from the next step on". If there is no process, or that call fails, the stored level is used the next time the process is launched: `launch()` passes `effort: info.effort` (capped at the ceiling) in the SDK options.

## An effort request, end to end

```mermaid
sequenceDiagram
  participant S as Sonnet "charlie" (running, low)
  participant C as Conversation
  participant O as Opus "bravo" (its parent)
  S->>C: set_effort(level "high", reason)
  C->>C: setOwnEffort(): raising, has parent,<br/>parent live, high ≤ Sonnet ceiling
  C->>O: inbound item + <agent-message> "Effort request: … Approve with set_agent_effort …"
  C-->>S: "Asked bravo to raise you from low to high. Keep working at low…"
  Note over O: wakes (if waiting) or reads it mid-turn
  alt approve
    O->>C: set_agent_effort(name "charlie", level "high")
    C->>S: setEffort("high") → applyFlagSettings
    C->>S: notice in its transcript (no message)
    C-->>O: "charlie raised from low to high effort."
  else decline
    O->>C: send_message(to "charlie", "stay at low")
  end
```

Walkthrough with every function: [An effort request](Walkthrough-Effort-Request.md).

## Known limitations

These are deliberate for 0.1.1, to be revisited in a later version:

- **Effort does not drop back to low on its own.** Effort is part of `AgentInfo` and is saved, so it persists across turns and across a restart. Nothing resets an agent to low after a task; the prompt only asks agents to "go back down afterwards". Likewise, if automatic effort is turned off, `launch()` sets each agent's stored effort to its tier level, and turning it back on later only caps that level at the ceiling.
- **Lowering a ceiling does not affect agents already running.** The new ceiling applies the next time each agent's process is launched, and to the tools from then on.

## Related pages

[Team rules](Team-Rules.md) · [server/conversation.ts](Source-Conversation.md) · [server/tools.ts](Source-Tools.md) · [Configuration and settings](Configuration-and-Settings.md)
