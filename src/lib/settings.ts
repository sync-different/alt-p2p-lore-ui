/**
 * App settings.
 *
 * Kept in `localStorage` rather than beside `sessions.json`, because none of it is a secret,
 * none of it is shared with another program, and losing it costs a checkbox. The things that
 * *would* hurt to lose — hosts, workspaces, keys — already live in the backend precisely
 * because they are not like this.
 *
 * Read defensively: a settings file written by a newer build, hand-edited, or corrupted must
 * degrade to defaults rather than take the window down with it. An app that will not start
 * because of a preference is worse than one that forgot a preference.
 */

export interface Settings {
  /**
   * Show the `lore` commands the app runs, in the console.
   *
   * Off by default: it is a developer's view of somebody else's tool, and for an artist it is
   * noise. It stays *recorded* regardless — see `useLoreTrace` — so turning it on after
   * something went wrong still shows what led there.
   */
  debug: boolean;
}

export const DEFAULTS: Settings = { debug: false };

const KEY = "alt-lore.settings";

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULTS };
    return normalise(JSON.parse(raw));
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    // A full or disabled store is not worth an error dialog over a checkbox.
  }
}

/**
 * Coerce anything into a valid Settings.
 *
 * Every field is checked for *type*, not merely presence: `{"debug": "false"}` is truthy in
 * JavaScript, so a string from a hand-edited file would silently enable what it says is off.
 */
export function normalise(value: unknown): Settings {
  const v = (value ?? {}) as Record<string, unknown>;
  return {
    debug: typeof v.debug === "boolean" ? v.debug : DEFAULTS.debug,
  };
}
