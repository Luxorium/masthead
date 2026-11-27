// Every word the page shows, in one place: plain language for anybody, no team jargon on first sight.
// No translations yet; keeping the text here makes wording reviews (and a later translation) one file.
// Functions take what varies (names, counts, times); everything else is a plain string.

import type { RemoteRole } from './remote/types.ts';

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
/** A date and time for lists (remote devices, activity). */
/** A device role in the page's words (the audit log stores the id). */
const roleWord = (role: string) => ({ full: 'everything', approve: 'answer approvals and stop work', read: 'only read' })[role] ?? role;
const when = (ts: number) => new Date(ts).toLocaleString([], { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });

export const T = {
  app: {
    name: 'Masthead',
  },

  signIn: {
    open: 'Open Masthead with the `masthead` command (or its launcher entry) to sign this browser in.',
    refused: "Masthead did not accept this browser's key. Open it with the `masthead` command to sign in again.",
    tryAgain: 'Try again',
  },

  firstRun: {
    title: 'Masthead needs Claude Code to work',
    body: 'Masthead runs the Claude Code already installed on this computer, signed in with your own account. It could not find it.',
    install: 'Install Claude Code, sign in once by running `claude` in a terminal, then restart Masthead.',
    detail: 'What Masthead saw',
    reload: 'Reload this page',
  },

  shell: {
    showChats: 'Show chats',
    hideChats: 'Hide chats',
    newChat: 'New chat',
    newChatTitle: 'New chat',
    chats: 'Chats',
    noChats: 'Your chats appear here.',
    deleteChat: 'Delete chat',
    confirmDelete: 'Delete?',
    rename: 'Rename',
    working: 'Working',
    needsAnswer: 'Needs your answer',
    disconnected: 'Not connected',
    reconnecting: 'Lost the connection to Masthead. Reconnecting…',
    team: (working: number) => (working > 0 ? `Team · ${working} working` : 'Team'),
    teamShort: (working: number) => (working > 0 ? `Team · ${working}` : 'Team'),
    skip: 'Skip to the message box',
    replied: (name: string) => `${name} replied.`,
    closePanel: 'Close the panel',
    teamTitle: 'Show the team',
    breadcrumb: 'Helper',
    backTo: (name: string) => `Back to ${name}`,
  },

  banner: {
    limitReached: "You've reached your Claude usage limit.",
    limitNear: 'You are close to your Claude usage limit.',
    resets: (when: string) => `It resets ${when}.`,
    dismiss: 'Dismiss',
  },

  empty: {
    heading: 'What are we working on?',
    intro: 'Ask in your own words. Masthead brings in helpers when the work calls for it.',
    examplesLabel: 'Examples',
    examples: [
      'Look through this folder and tell me what this project does.',
      'Find and fix the failing tests, then explain what was wrong.',
      'Write a short README for this project.',
    ],
    nothingYet: 'Nothing here yet.',
  },

  composer: {
    label: 'Message',
    labelTo: (name: string) => `Message to ${name}`,
    askAnything: 'Ask for anything',
    reply: (lead: string) => `Reply to ${lead}`,
    addTo: (lead: string) => `Add to what ${lead} is doing`,
    direct: (name: string, lead: string) => `Message ${name} directly, not ${lead}`,
    to: 'To',
    send: 'Send',
    sendTitle: 'Send (Enter)',
    stop: 'Stop',
    stopTitle: 'Stop this reply',
    stopAll: 'Stop all',
    attach: 'Attach pictures',
    removeImage: 'Remove picture',
    folder: 'Folder',
    folderTitle: 'The folder the agents work in',
    folderFirst: 'Agents can read and change files in this folder.',
    waiting: (name: string, from: string) => `${name} is waiting for an answer from ${from}. What you send here answers it.`,
    starting: 'Starting…',
    notImage: (name: string) => `Only pictures can be attached (PNG, JPEG, GIF, WebP). For ${name}, put it in the folder and mention it.`,
    tooBig: (name: string) => `${name} is still larger than 5 MB after shrinking it. Try a smaller picture.`,
    tooBigToShrink: (name: string) => `${name} is too large (over 40 MB).`,
    tooMuch: (name: string) => `${name} would take this message over 30 MB of pictures. Send it in another message.`,
    tooMany: (max: number) => `At most ${max} pictures per message.`,
    unreadable: (name: string) => `${name} could not be read.`,
    thatFile: 'that file',
    thatImage: 'That picture',
  },

  transcript: {
    jump: 'Jump to latest',
    earlierMore: 'Show earlier',
    earlier: (n: number) => `Show earlier (${plural(n, 'more item', 'more items')})`,
    askedBy: 'Asked by',
    finished: (name: string) => `${name} finished`,
    says: (name: string) => `${name} says`,
    show: 'Show',
    hide: 'Hide',
    showReport: 'Show the report',
    thought: 'Thought',
    thinking: 'Thinking…',
    working: 'Working…',
    waitingTurn: 'Waiting its turn…',
    waitingOn: (n: number) => `Waiting for ${plural(n, 'helper', 'helpers')}`,
    images: (n: number) => `${plural(n, 'picture', 'pictures')} attached`,
    input: 'Input',
    result: 'Result',
    empty: '(empty)',
    failed: 'failed',
  },

  status: {
    queued: 'Waiting its turn',
    running: 'Working',
    waiting: 'Waiting',
    idle: 'Idle',
    done: 'Done',
    failed: 'Failed',
    stopped: 'Stopped',
    waitingFor: (name: string) => `Waiting for an answer from ${name}`,
    paused: (time: string) => `Paused until ${time} · usage limit`,
    failedWith: (reason: string) => `Failed: ${reason}`,
    stoppedWith: (reason: string) => `Stopped · ${reason}`,
  },

  team: {
    title: 'Team',
    close: 'Close the team',
    showMap: 'Show as a map',
    showChat: 'Back to the chat',
    mainAssistant: 'Main assistant',
    memory: (pct: number) => `Memory used: ${pct}%`,
    memoryDetail: (used: string, max: string, out: string) => `${used} of ${max} tokens. All agents have written ${out}.`,
    folder: 'Folder',
    stop: (name: string) => `Stop ${name}`,
    stopTitle: 'Stop this helper and everything under it',
    stopWord: 'Stop',
    levels: 'Levels',
    levelsHelp: 'Each level can start helpers on the level below it.',
    startedBy: (name: string) => `Started by ${name}`,
    theOne: 'The one you talk to',
    atATime: 'Helpers at a time',
    working: (n: number) => `${n} working`,
    queued: (n: number) => `${n} waiting`,
    off: 'Off',
    fewer: (model: string) => `Fewer ${model} helpers`,
    more: (model: string) => `More ${model} helpers`,
    thinking: 'Thinking time',
    thinkingUpTo: 'Thinking time up to',
    openChat: (name: string) => `Open ${name}'s chat`,
    clickToOpen: 'Click to open the chat',
    task: 'Task',
    loading: 'Loading…',
    nothingYet: 'Nothing yet.',
    you: 'You',
  },

  usage: {
    title: 'Usage',
    none: 'No usage reported yet; it appears once an agent has run.',
    used: (pct: number) => `${pct}% used`,
    reached: 'limit reached',
    resets: (when: string) => `Resets ${when}`,
    names: {
      five_hour: 'This session (5 hours)',
      seven_day: 'This week, all models',
      seven_day_opus: 'This week, Opus',
      seven_day_sonnet: 'This week, Sonnet',
      seven_day_overage_included: 'This week, with extra usage',
      overage: 'Extra usage',
    } as Record<string, string>,
    other: 'Usage limit',
  },

  settings: {
    title: 'Settings',
    close: 'Close settings',
    general: 'General',
    about: 'About',
    themeLabel: 'Colours',
    keepAwake: 'Keep this computer awake while helpers are working',
    keepAwakeHelp: 'Stops the computer going to sleep on its own while agents work. Closing the lid or choosing Sleep still works.',
    theme: 'Appearance',
    themeSystem: 'Same as this device',
    themeLight: 'Light',
    themeDark: 'Dark',
    advanced: 'Show team controls',
    advancedHelp: 'Levels, helpers at a time and thinking time in the team panel. Off keeps things simple.',
    ask: 'When to ask you',
    askChoices: {
      inherit: 'As set in Claude Code',
      default: 'Always ask',
      acceptEdits: 'Ask, except for file edits',
      auto: 'Decide automatically',
      bypassPermissions: 'Never ask (risky)',
    } as Record<string, string>,
    askShort: {
      inherit: 'Claude Code settings',
      default: 'Always ask',
      acceptEdits: 'Ask except edits',
      auto: 'Automatic',
      bypassPermissions: 'Never ask',
    } as Record<string, string>,
    bypassWarning: 'Every agent can run any command and change any file without asking.',
    autoEffort: 'Let them decide how long to think',
    autoEffortHelp: 'Everyone starts with short thinking time; the main assistant raises its own, helpers ask the one above them.',
    leanOpus: 'Keep Opus helpers light',
    leanOpusHelp: 'They skip your connected services too.',
    leanSub: 'Keep Sonnet and Haiku helpers light',
    leanSubHelp: 'They skip your connected services, which keeps their memory small.',
    fold: 'Show helper reports as one line',
    foldHelp: 'Reports from helpers stay folded in a chat until you open them.',
    runLimit: 'Longest a helper may work',
    runLimitHelp: 'A helper still working after this long is stopped, and the one that started it is told.',
    noLimit: 'No limit',
    minutes: (m: number) => (m < 60 ? `${m} minutes` : m === 60 ? '1 hour' : `${m / 60} hours`),
    claude: (v: string) => `Claude Code ${v}`,
    claudeMissing: 'Claude Code not found',
  },

  effort: {
    low: 'Short',
    medium: 'Medium',
    high: 'Long',
    xhigh: 'Longest',
  } as Record<string, string>,

  images: {
    viewer: 'Picture',
    of: (i: number, n: number) => `${i} of ${n}`,
    openTab: 'Open in a new tab',
    close: 'Close the picture',
    prev: 'Previous picture',
    next: 'Next picture',
    open: (alt: string) => `Open ${alt}`,
    sent: 'Picture you sent',
    fromTool: 'Picture from a tool',
    uploading: 'Uploading…',
    failed: 'Upload failed',
  },

  card: {
    question: (name: string) => `Question from ${name}`,
    permission: (name: string) => `Permission request from ${name}`,
    asks: 'asks',
    other: 'Something else…',
    answer: 'Answer',
    skip: "Don't answer",
    deny: 'Deny',
    allow: 'Allow',
    always: 'Allow for this session',
    alwaysTitle: 'Allow, and stop asking for this in this session',
    showDetails: 'Show details',
    hideDetails: 'Hide details',
  },

  device: {
    title: 'This device',
    staysSignedIn: 'This browser stays signed in to Masthead until you forget it here, or the computer removes it.',
    forget: 'Forget this device',
    forgetHelp: 'Signs this browser out and removes it from the computer’s list. Use it on a phone or computer that is not yours.',
    roleRead: 'This device can follow the chats but not change anything.',
    roleApprove: 'This device can follow the chats and answer questions and permission requests, but not send messages or change settings.',
  },

  /** Remote access (web/src/lib/remote). */
  remote: {
  signIn: {
    title: 'Open Masthead on this device',
    checking: 'Checking this device…',
    withdrawn: 'This computer withdrew access for this device.',
    intro: (device: string) => `Masthead runs on another computer. To use it from ${device}, ask that computer to allow this device.`,
    ask: 'Ask for access',
    askAgain: 'Ask again',
    codeLead: 'Check that the same code shows on the computer, then allow this device there:',
    waiting: 'Waiting for approval…',
    notAllowed: 'This device was not allowed, or the request ran out.',
    tooMany: 'Too many requests from this device. Wait a minute, then ask again.',
    refused: (reason: string) => `This computer does not accept this device: ${reason}.`,
    offline: 'Could not reach the computer. Check that it is on and connected to Tailscale.',
  },
  request: {
    label: (device: string) => `${device} asks to use Masthead`,
    heading: (device: string) => `${device} wants to use Masthead`,
    from: (os: string, user: string | undefined, address: string) => [os, user, address].filter(Boolean).join(' · '),
    codeLead: 'Allow it only if this code shows on that device:',
    warning: 'Allowing this device lets it do everything you can do here, including running commands.',
    role: 'What it may do',
    allow: 'Allow',
    deny: 'Deny',
  },
  role: {
    full: 'Everything',
    approve: 'Answer approvals and stop work',
    read: 'Only read',
  } satisfies Record<RemoteRole, string>,
  section: {
    title: 'Remote access',
    intro: 'Use Masthead from your other devices on your own Tailscale network. Nothing is opened to the internet.',
    switch: 'Allow my other devices to connect',
    noTailscale: 'Tailscale is not available on this computer.',
    on: (url: string) => `On. Open this address on your other device: ${url}`,
    off: 'Off.',
    pending: 'Turning on…',
    command: 'Run this once in a terminal, then switch it on again:',
    copy: 'Copy',
    copied: 'Copied',
    port: 'Port',
    portLocked: 'Switch remote access off to change the port.',
    otherTailnets: 'Allow devices shared from other Tailscale networks',
    tagged: 'Allow devices without a user (tagged devices)',
    devices: 'Allowed devices',
    noDevices: 'No device is allowed yet.',
    device: (name: string) => `Device ${name}`,
    deviceRole: (name: string) => `What ${name} may do`,
    revoke: 'Remove',
    revokeLabel: (name: string) => `Remove ${name}`,
    seen: (ts: number) => `Last used ${when(ts)}`,
    expires: (ts: number) => `Allowed until ${when(ts)}, renewed when used`,
    audit: 'Recent activity',
    loadAudit: 'Show recent activity',
    noAudit: 'Nothing yet.',
  },
  event: (e: { event: string; nodeName?: string; detail?: string }) => {
    const who = e.nodeName ?? 'A device';
    switch (e.event) {
      case 'request':
        return `${who} asked for access`;
      case 'allow':
        return `${who} was allowed${e.detail ? ` (${roleWord(e.detail)})` : ''}`;
      case 'deny':
        return `${who} was turned down`;
      case 'collect':
        return `${who} received its access`;
      case 'connect':
        return `${who} connected`;
      case 'revoke':
        return `${who} was removed`;
      case 'expire':
        return `${who}'s access ran out`;
      case 'role':
        return `${who} may now: ${roleWord(e.detail ?? '')}`;
      case 'refuse':
        return `${who} was refused${e.detail ? `: ${e.detail}` : ''}`;
      case 'switch':
        return e.detail ? e.detail.charAt(0).toUpperCase() + e.detail.slice(1) : 'Remote access changed';
      case 'forget':
        return `${who} signed itself out`;
      default:
        return `${who}: access changed`;
    }
  },
  when,
},

  /** Teams and agent programs in the settings (web/src/lib/settings). */
  teams: {
  backends: {
    heading: 'Agents on this computer',
    intro: 'The AI coding programs Masthead can run your team on.',
    checkAgain: 'Check again',
    checking: 'Checking…',
    found: 'Ready',
    notFound: 'Not found',
    notReady: 'Not ready',
    version: (v: string) => `Version ${v}`,
    models: (n: number) => (n === 1 ? '1 model' : `${n} models`),
    install: (label: string) => `Install ${label}, then press “Check again”.`,
    signIn: (label: string) => `Sign in to ${label} in a terminal, then press “Check again”.`,
    tooOld: (label: string, min: string) => `This ${label} is too old. Update it to version ${min} or later, then press “Check again”.`,
    note: 'Note',
    none: 'No agent program was found on this computer yet.',
  },
  teams: {
    heading: 'Teams',
    intro: 'A team is the main assistant and the helpers it may bring in, one level each.',
    forNewChats: 'Team for new chats',
    edit: (name: string) => `Edit ${name}`,
    close: 'Done',
    duplicate: 'Make a copy',
    remove: 'Remove team',
    removeConfirm: (name: string) => `Remove the team “${name}”? Chats that used it keep their history.`,
    reset: 'Reset to the built-in team',
    resetDone: 'Restored the built-in team.',
    builtIn: 'Built in',
    copyOf: (name: string) => `${name} (copy)`,
    proposalTitle: 'A team for Codex is ready',
    proposalBody: 'Masthead put it together from the models your Codex offers. Use it as it is, or change it first.',
    useIt: 'Use it for new chats',
    changeFirst: 'Change it first',
    unusable: (backend: string) => `Needs ${backend}, which is not ready on this computer.`,
    save: 'Save team',
    saved: 'Team saved.',
    cancel: 'Cancel',
    teamName: 'Team name',
  },
  level: {
    title: (n: number, model: string) => (n === 1 ? `Main assistant: ${model}` : `Level ${n} helper: ${model}`),
    name: 'Name shown',
    program: 'Agent program',
    model: 'Model',
    thinking: 'Thinking time up to',
    helpers: 'Helpers at a time',
    helpersNone: 'The main assistant is always one.',
    light: 'Keep light',
    lightHint: 'Leaves out your own extra tools (MCP servers), so it starts faster and uses less.',
    colour: 'Colour',
    add: 'Add a helper level',
    removeLevel: 'Remove this level',
    moveUp: 'Move up',
    moveDown: 'Move down',
    thinkingLevel: { low: 'Short', medium: 'Medium', high: 'Long', xhigh: 'Longest' } as Record<string, string>,
    colourName: { amber: 'Amber', violet: 'Violet', blue: 'Blue', teal: 'Teal', rose: 'Rose', green: 'Green', slate: 'Slate', orange: 'Orange' } as Record<string, string>,
  },
  problems: {
    noName: 'Give the team a name.',
    nameTaken: 'Another team already has this name.',
    noLevels: 'A team needs at least the main assistant.',
    tooMany: (max: number) => `A team can have at most ${max} levels.`,
    noModel: (n: number) => `Choose a model for level ${n}.`,
    modelGone: (n: number, model: string) => `Level ${n} uses ${model}, which this program no longer offers. Choose another model.`,
    thinkingNotOffered: (n: number) => `The model of level ${n} does not offer that thinking time. Choose a shorter one.`,
    helpersRange: (n: number, max: number) => `Level ${n} may have from 0 to ${max} helpers at a time.`,
    helpersZero: (n: number) => `Level ${n} has 0 helpers at a time, so the levels after it would never start. Remove them or allow at least 1.`,
    oneProgram: 'Every level of a team uses the same agent program for now.',
    programNotReady: (label: string) => `${label} is not ready on this computer, so this team cannot start yet.`,
  },
  chip: {
    // Read by people who have never heard of teams: say which AI does the work.
    label: (name: string) => `Uses ${name}`,
    menu: 'Choose which AI works on this chat',
  },
},

  errors: {
    notConnected: "Masthead isn't answering. Check that it is running, then try again.",
  },
} as const;

/**
 * Server messages rewritten into plain words with one next action. Anything not listed is shown as
 * the server wrote it.
 */
export function friendlyError(message: string): string {
  const known: [RegExp, string][] = [
    [/^The message is too long\.?$/, 'That message is too long to send (over 400,000 characters). Put the text in a file in the folder and mention its name.'],
    [/^That conversation no longer exists\.?$/, 'This chat was deleted in another window. Pick another chat or start a new one.'],
    [/^The message is empty\.?$/, 'Type a message first.'],
    [/^Unsupported image\.?$/, 'That picture could not be used. Only PNG, JPEG, GIF and WebP pictures can be attached.'],
    [/is not a folder\.?$/, `${message.replace(/\.$/, '')}. Choose another folder under the message box.`],
  ];
  for (const [re, text] of known) if (re.test(message)) return text;
  return message;
}

/**
 * A program's name for people, when the server's list does not have it (not installed): never the id.
 */
export function programName(id: string, label?: string): string {
  if (label) return label;
  const known: Record<string, string> = { 'claude-code': 'Claude Code', codex: 'Codex', fake: 'the test program' };
  return known[id] ?? id.replace(/[-_]/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
}
