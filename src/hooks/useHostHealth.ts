import { useCallback, useEffect, useRef, useState } from "react";
import { probeHost, type HostProbe } from "../lib/hosts";

/**
 * Keeps an eye on hosts that have no process to watch.
 *
 * Only **direct** hosts are probed: a P2P host's tunnel already reports its own phase, and
 * probing the loopback port a tunnel forwards would tell us about the tunnel rather than about
 * the host behind it.
 *
 * Two failures from one afternoon are the reason this exists. A host that was switched off
 * still showed green, and a host that fell asleep was discovered only by a repository
 * operation failing — so the news arrived as an error about something the user had just tried,
 * rather than as a fact about the host.
 */

/**
 * How often to re-probe.
 *
 * Long enough that a fleet of hosts costs nothing, short enough that coming back is noticed
 * before the user tries to work. A probe is one TCP connect with a 3s ceiling, so even the
 * slowest case cannot overlap the next tick.
 */
export const PROBE_INTERVAL_MS = 15_000;

export interface ProbeTarget {
  id: string;
  baseUrl: string;
}

export function useHostHealth(targets: ProbeTarget[], intervalMs = PROBE_INTERVAL_MS) {
  const [health, setHealth] = useState<Map<string, HostProbe>>(new Map());

  // The targets are rebuilt on every render by the caller, so depending on the array itself
  // would restart the timer constantly. The identity that matters is which hosts, at which
  // addresses — nothing else here changes what to probe.
  const key = targets.map((t) => `${t.id}@${t.baseUrl}`).join("|");
  const targetsRef = useRef(targets);
  targetsRef.current = targets;

  const probeAll = useCallback(async () => {
    const current = targetsRef.current;
    if (current.length === 0) return;
    const results = await Promise.all(
      current.map(async (t) => [t.id, await probeHost(t.baseUrl).catch(() => "unreachable" as const)] as const),
    );
    setHealth((prev) => {
      const next = new Map(prev);
      for (const [id, p] of results) next.set(id, p);
      // Forget hosts that no longer exist, or a deleted one lingers as a green dot in any
      // view that reads this map by id.
      for (const id of next.keys()) {
        if (!current.some((t) => t.id === id)) next.delete(id);
      }
      return next;
    });
  }, []);

  useEffect(() => {
    void probeAll();
    const timer = setInterval(() => void probeAll(), intervalMs);
    // Coming back to the window is the moment the answer matters most: the user has probably
    // been away, which is exactly when a host goes to sleep.
    const onFocus = () => void probeAll();
    window.addEventListener("focus", onFocus);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [key, intervalMs, probeAll]);

  return { health, refresh: probeAll };
}
