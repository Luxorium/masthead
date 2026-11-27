import { homedir } from 'node:os';
import { join, posix, win32 } from 'node:path';

export const DEFAULT_PORT = 7717;
export const HOME = homedir();

export interface AppDirs {
  config: string;
  data: string;
}

/**
 * Where settings and data live, per platform. Linux keeps the XDG folders it always had. macOS and
 * Windows use their native places (no Masthead install existed there before 0.2.0, so nothing moves).
 * On every platform MASTHEAD_CONFIG_DIR / MASTHEAD_DATA_DIR win, then XDG_CONFIG_HOME / XDG_DATA_HOME.
 */
export function appDirs(platform: NodeJS.Platform, env: Record<string, string | undefined>, home: string): AppDirs {
  const p = platform === 'win32' ? win32 : posix;
  let config: string;
  let data: string;
  if (platform === 'darwin') {
    config = data = p.join(home, 'Library', 'Application Support', 'Masthead');
  } else if (platform === 'win32') {
    config = p.join(env.APPDATA || p.join(home, 'AppData', 'Roaming'), 'Masthead');
    data = p.join(env.LOCALAPPDATA || p.join(home, 'AppData', 'Local'), 'Masthead');
  } else {
    config = p.join(home, '.config', 'masthead');
    data = p.join(home, '.local', 'share', 'masthead');
  }
  if (env.XDG_CONFIG_HOME) config = p.join(env.XDG_CONFIG_HOME, 'masthead');
  if (env.XDG_DATA_HOME) data = p.join(env.XDG_DATA_HOME, 'masthead');
  if (env.MASTHEAD_CONFIG_DIR) config = env.MASTHEAD_CONFIG_DIR;
  if (env.MASTHEAD_DATA_DIR) data = env.MASTHEAD_DATA_DIR;
  return { config, data };
}

const dirs = appDirs(process.platform, process.env, HOME);

export const CONFIG_DIR = dirs.config;
export const DATA_DIR = dirs.data;
export const SETTINGS_FILE = join(CONFIG_DIR, 'settings.json');
export const CONVERSATIONS_DIR = join(DATA_DIR, 'conversations');
/** The local server's secret. Only a browser signed in with it, or a program that can read this file, may drive Masthead. */
export const SECRET_FILE = join(DATA_DIR, 'secret');
