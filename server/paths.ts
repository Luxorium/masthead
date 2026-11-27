import { homedir } from 'node:os';
import { join } from 'node:path';

export const DEFAULT_PORT = 7717;
export const HOME = homedir();

export const CONFIG_DIR = join(process.env.XDG_CONFIG_HOME || join(HOME, '.config'), 'masthead');
export const DATA_DIR = join(process.env.XDG_DATA_HOME || join(HOME, '.local', 'share'), 'masthead');
export const SETTINGS_FILE = join(CONFIG_DIR, 'settings.json');
export const CONVERSATIONS_DIR = join(DATA_DIR, 'conversations');
/** The local server's secret. Only a browser signed in with it, or a program that can read this file, may drive Masthead. */
export const SECRET_FILE = join(DATA_DIR, 'secret');
