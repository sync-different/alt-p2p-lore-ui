import type { Settings } from "../lib/settings";

/**
 * App settings.
 *
 * One switch today, and structured as a list so the second one does not need a redesign.
 * Each row says what the setting does in terms of what appears on screen, not in terms of the
 * flag it sets — "show the commands the app runs" is checkable against reality; "enable debug
 * mode" is not.
 */
export function SettingsDialog({
  settings,
  onChange,
  onClose,
}: {
  settings: Settings;
  onChange: (next: Settings) => void;
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 z-30 flex items-center justify-center bg-black/50 p-6">
      <div className="max-h-full w-[30rem] overflow-auto rounded border border-line bg-surface-1 p-5">
        <h2 className="text-ink-0">Settings</h2>

        <label className="mt-4 flex items-start gap-2 text-ink-1">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={settings.debug}
            onChange={(e) => onChange({ ...settings, debug: e.target.checked })}
          />
          <span>
            Show debug messages in the console
            <span className="mt-0.5 block text-[11px] text-ink-2">
              Adds a line for every <span className="font-mono">lore</span> command the app runs,
              with how long it took and how it ended. Useful when reporting a problem.
              {/* Said explicitly because the opposite is the reasonable assumption, and it is
                  the difference between a switch that helps after a failure and one that only
                  helps people who turned it on beforehand. */}
              {" "}Commands are recorded even while this is off, so turning it on shows what
              already happened.
            </span>
          </span>
        </label>

        <p className="mt-4 text-[11px] text-ink-2">
          Passwords, keys and tokens are replaced with{" "}
          <span className="font-mono">***</span> before anything is shown or recorded.
        </p>

        <div className="mt-5 flex justify-end">
          <button
            onClick={onClose}
            className="rounded border border-line px-3 py-1 text-ink-1 hover:bg-surface-2"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
