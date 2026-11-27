// The background service that starts Masthead at login, one implementation per platform.
// Everything that touches the system goes through `Deps`, so the generated files and the command
// sequences can be tested without running systemctl, launchctl or schtasks.

export interface InstallOptions {
  /** Absolute path of the node binary (process.execPath). */
  node: string;
  /** Absolute path of dist/server/main.js. */
  mainJs: string;
  /** The port to serve on; omitted or 7717 means the default. */
  port?: number;
  /** The environment to take PATH, XDG_* and MASTHEAD_*_DIR from (normally process.env). */
  env: Record<string, string | undefined>;
  /** The Claude Code found by the caller, passed on as MASTHEAD_CLAUDE. */
  claudePath?: string | null;
}

export interface ServiceStatus {
  installed: boolean;
  /** null when it cannot be told. */
  running: boolean | null;
  /** The port the service serves, when installed. */
  port: number | null;
  /** The data folder the installed service uses, when it can be told (not on Windows). */
  dataDir?: string;
  detail: string;
}

export interface ServiceManager {
  kind: 'systemd' | 'launchd' | 'taskscheduler';
  /** Writes the service, (re)starts it and returns human lines of what was done. Throws on failure. */
  install(o: InstallOptions): Promise<string[]>;
  uninstall(): Promise<string[]>;
  status(): Promise<ServiceStatus>;
  /** Whether the installed service is the one serving `port` (so `stop`/`open` go through it). */
  serves(port: number): boolean;
}

export interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

export interface ServiceFs {
  writeFile(path: string, data: string | Uint8Array): void;
  /** Recursive; no error when it exists. */
  mkdir(path: string): void;
  /** No error when it is missing. */
  rm(path: string): void;
  exists(path: string): boolean;
}

export interface Deps {
  /** spawnSync-like: never throws for a non-zero exit; status null when it could not start. */
  run(cmd: string, args: readonly string[]): RunResult;
  fs: ServiceFs;
  home: string;
  env: Record<string, string | undefined>;
  /** launchd only: the user id for gui/<uid>. Defaults to process.getuid?.(). */
  uid?: number;
  /** taskscheduler only: where the task XML is written before schtasks reads it. Defaults to os.tmpdir(). */
  tmpdir?: string;
}

export class ServiceError extends Error {}
