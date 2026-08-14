import { useCallback, useRef, useState } from "react";
import type { Notice, NoticeLevel } from "../types/app";

/**
 * The Activity feed.
 *
 * Capped, because this is fed by long-lived work in an app meant to stay open all day —
 * an unbounded array here is a slow memory leak, and the sibling transfer app has exactly
 * that problem with its log buffer.
 *
 * Newest first, so the list never has to be scrolled to see what just happened.
 */

export const MAX_NOTICES = 500;

export function useNotices() {
  const [notices, setNotices] = useState<Notice[]>([]);
  // Ids must be unique across a session without depending on the clock: several events can
  // land in the same millisecond, and React keys that collide render the wrong rows.
  const seq = useRef(0);

  const push = useCallback(
    (level: NoticeLevel, message: string, source?: string) => {
      const notice: Notice = {
        id: `n${++seq.current}`,
        level,
        at: Date.now(),
        message,
        source,
      };
      setNotices((prev) => [notice, ...prev].slice(0, MAX_NOTICES));
      return notice;
    },
    [],
  );

  const clear = useCallback(() => setNotices([]), []);

  return { notices, push, clear };
}

export type NoticePush = ReturnType<typeof useNotices>["push"];
