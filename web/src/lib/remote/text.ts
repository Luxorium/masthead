// Page text for remote access. Plain words; merged into web/src/lib/text.ts later.
import type { RemoteRole } from './types.ts';

const when = (ts: number) => new Date(ts).toLocaleString([], { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });

export const RT = {
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
        return `${who} was allowed${e.detail ? ` (${e.detail})` : ''}`;
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
        return `${who} may now: ${e.detail ?? ''}`;
      case 'refuse':
        return `${who} was refused${e.detail ? `: ${e.detail}` : ''}`;
      case 'switch':
        return e.detail ? e.detail.charAt(0).toUpperCase() + e.detail.slice(1) : 'Remote access changed';
      default:
        return `${who}: ${e.event}`;
    }
  },
  when,
};
