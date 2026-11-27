/**
 * JSON-RPC 2.0 over newline-delimited JSON, as `codex app-server` speaks it on stdio. Both sides send
 * requests: the client starts threads and turns, the server asks for approvals and tool calls.
 */
import type { Readable, Writable } from 'node:stream';

export class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
  }
}

type Id = number | string;
interface Pending {
  resolve(v: unknown): void;
  reject(e: Error): void;
}

export type NotificationHandler = (method: string, params: any) => void;
/** Answers a server request; throw RpcError to answer with an error. */
export type RequestHandler = (method: string, params: any, id: Id) => Promise<unknown>;

export class RpcPeer {
  private nextId = 1;
  private pending = new Map<Id, Pending>();
  private buf = '';
  private closed = false;
  onNotification: NotificationHandler = () => {};
  onRequest: RequestHandler = async (method) => {
    throw new RpcError(-32601, `method not found: ${method}`);
  };

  constructor(
    private out: Writable,
    input: Readable,
  ) {
    input.setEncoding('utf8');
    input.on('data', (chunk: string) => this.data(chunk));
    // Writing to a process that just died must not crash the server.
    out.on('error', () => {});
  }

  request<T = any>(method: string, params?: unknown): Promise<T> {
    if (this.closed) return Promise.reject(new RpcError(-32000, 'Codex app-server is not running.'));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.write({ id, method, ...(params === undefined ? {} : { params }) });
    });
  }

  notify(method: string, params?: unknown): void {
    if (!this.closed) this.write({ method, ...(params === undefined ? {} : { params }) });
  }

  /** Fails every request still waiting; later calls fail at once. */
  close(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    for (const p of this.pending.values()) p.reject(new RpcError(-32000, reason));
    this.pending.clear();
  }

  private write(msg: unknown): void {
    this.out.write(JSON.stringify(msg) + '\n');
  }

  private data(chunk: string): void {
    this.buf += chunk;
    let n: number;
    while ((n = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, n).trim();
      this.buf = this.buf.slice(n + 1);
      if (!line) continue;
      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch {
        continue; // not protocol output
      }
      this.dispatch(msg);
    }
  }

  private dispatch(msg: any): void {
    if (msg && msg.method === undefined && msg.id !== undefined) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new RpcError(msg.error.code ?? -32000, String(msg.error.message ?? 'error'), msg.error.data));
      else p.resolve(msg.result);
      return;
    }
    if (typeof msg?.method !== 'string') return;
    if (msg.id === undefined) {
      this.onNotification(msg.method, msg.params);
      return;
    }
    const id = msg.id as Id;
    this.onRequest(msg.method, msg.params, id).then(
      (result) => !this.closed && this.write({ id, result: result ?? {} }),
      (e: unknown) => {
        if (this.closed) return;
        const err = e instanceof RpcError ? e : new RpcError(-32603, (e as Error)?.message ?? String(e));
        this.write({ id, error: { code: err.code, message: err.message } });
      },
    );
  }
}
