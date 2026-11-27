// What the server sends about remote access (mirrors server/remote/access.ts RemoteState; the page
// cannot import server code).
export type RemoteRole = 'full' | 'approve' | 'read';

export interface RemoteDevice {
  nodeId: string;
  nodeName: string;
  os: string;
  user?: { login: string; name: string };
  address: string;
  role: RemoteRole;
  createdAt: number;
  lastSeen: number;
  expiresAt: number;
}

export interface RemoteRequest {
  id: string;
  nodeName: string;
  os: string;
  user?: { login: string; name: string };
  address: string;
  code: string;
  createdAt: number;
}

export interface RemoteState {
  enabled: boolean;
  port: number;
  available: boolean;
  url?: string;
  serve: 'off' | 'ours' | 'elsewhere' | 'funnel' | 'unknown';
  problem?: string;
  command?: string;
  target: 'socket' | 'loopback';
  warning?: string;
  allowOtherTailnets: boolean;
  allowTagged: boolean;
  devices: RemoteDevice[];
  requests: RemoteRequest[];
}

export interface AuditEntry {
  ts: number;
  event: string;
  nodeId?: string;
  nodeName?: string;
  user?: string;
  address?: string;
  detail?: string;
}

/** "482913" → "482 913", easier to compare by eye. */
export function spacedCode(code: string): string {
  return code.length === 6 ? `${code.slice(0, 3)} ${code.slice(3)}` : code;
}
