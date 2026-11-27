// Page-only state that is not the server's business: Simple or Advanced, theme, screen size and which
// panels are open. Kept per device in localStorage: a phone and a desktop may want different things.

const ADVANCED_KEY = 'masthead.advanced';
const THEME_KEY = 'masthead.theme';

export type Theme = 'system' | 'light' | 'dark';

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Private mode: the choice lasts for this page load.
  }
}

/** A media query as live state; false where matchMedia is missing (tests). */
function media(query: string, onChange: (on: boolean) => void): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  const m = window.matchMedia(query);
  m.addEventListener?.('change', (e) => onChange(e.matches));
  return m.matches;
}

/** Applies a theme to the page: `data-theme` on <html>, none for the system setting. */
export function applyTheme(theme: Theme): void {
  if (typeof document === 'undefined') return;
  if (theme === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
}

class Ui {
  /** Advanced shows the team controls (levels, helpers at a time, thinking time). Simple is the default. */
  advanced = $state(read(ADVANCED_KEY) === '1');
  theme = $state<Theme>((['light', 'dark'] as const).find((t) => t === read(THEME_KEY)) ?? 'system');
  /** Whether the team panel is open. It only shows once the main assistant has started a helper. */
  teamOpen = $state(false);
  /** Whether the person has opened or closed the team panel themselves; then it is left alone. */
  teamTouched = false;
  /** Under 900 px: the side columns become drawers over the chat. */
  narrow = $state(media('(max-width: 899px)', (on) => (this.narrow = on)));
  /** 1280 px and wider: room for the team panel beside the chat. */
  wide = $state(media('(min-width: 1280px)', (on) => (this.wide = on)));
  /** Under 600 px: a phone. */
  phone = $state(media('(max-width: 599px)', (on) => (this.phone = on)));
  /** Whether the chat list is shown; on narrow screens it is a drawer and starts closed. */
  sidebarOpen = $state(!media('(max-width: 899px)', () => {}));

  constructor() {
    applyTheme(this.theme);
  }

  /** The settings view is shown in place of the chat. */
  settingsOpen = $state(false);

  openSettings(): void {
    this.settingsOpen = true;
    if (this.narrow) this.sidebarOpen = false;
  }

  /** Back to the chat; focus returns to the settings button. */
  closeSettings(): void {
    this.settingsOpen = false;
    queueMicrotask(() => document.getElementById('settings-gear')?.focus());
  }

  setAdvanced(on: boolean): void {
    this.advanced = on;
    write(ADVANCED_KEY, on ? '1' : '0');
  }

  setTheme(theme: Theme): void {
    this.theme = theme;
    write(THEME_KEY, theme);
    applyTheme(theme);
  }

  toggleTeam(open = !this.teamOpen): void {
    this.teamOpen = open;
    this.teamTouched = true;
  }
}

export const ui = new Ui();
