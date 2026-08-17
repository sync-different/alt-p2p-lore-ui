import { useCallback, useEffect, useRef, useState } from "react";

/**
 * A horizontal strip that scrolls instead of letting its contents fall off the screen.
 *
 * Born from a real report: with ten workspaces open, the tabs past the window's edge simply
 * ceased to exist — no arrows, no scrollbar — and the buttons after them went too. Any row that
 * grows with user data (workspace tabs, hosts) gets this treatment; fixed controls stay outside.
 *
 * - Native trackpad/wheel scrolling, scrollbar hidden (it would add a row of height).
 * - Paging arrows that render only while something is actually hidden on that side — a strip
 *   that fits shows nothing new.
 * - `scrollToKey`: the child carrying `data-scroll-key=<value>` is kept scrolled into view —
 *   selecting a tab from code or opening a new one at the end must not land off-screen.
 */
export function ArrowScroller({
  children,
  scrollToKey,
  className = "",
}: {
  children: React.ReactNode;
  scrollToKey?: string | null;
  /** Classes for the scrollable strip itself (spacing, padding). */
  className?: string;
}) {
  const strip = useRef<HTMLDivElement | null>(null);
  // Split rather than one "overflowing" flag so each arrow can retire at its own end.
  const [canLeft, setCanLeft] = useState(false);
  const [canRight, setCanRight] = useState(false);

  const update = useCallback(() => {
    const el = strip.current;
    if (!el) return;
    setCanLeft(el.scrollLeft > 1);
    // -1 absorbs fractional pixel widths, which otherwise leave a permanently-lit arrow.
    setCanRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 1);
  }, []);

  // Re-measure on any size change of the strip or its contents — window resizes, tabs coming
  // and going, a long name arriving. Observing the element covers all of them.
  useEffect(() => {
    update();
    const el = strip.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(update);
    ro.observe(el);
    for (const child of Array.from(el.children)) ro.observe(child);
    return () => ro.disconnect();
  }, [update, children]);

  useEffect(() => {
    if (!scrollToKey) return;
    const el = strip.current?.querySelector<HTMLElement>(
      `[data-scroll-key="${CSS.escape(scrollToKey)}"]`,
    );
    el?.scrollIntoView({ inline: "nearest", block: "nearest" });
    update();
  }, [scrollToKey, update]);

  const nudge = (dir: -1 | 1) => {
    // Most of a viewport per press: enough to feel like paging, small enough to keep context.
    strip.current?.scrollBy({
      left: dir * Math.max(160, (strip.current.clientWidth * 2) / 3),
      behavior: "smooth",
    });
  };

  const arrowClass = (enabled: boolean) =>
    `shrink-0 self-stretch px-1 text-ink-2 ${
      enabled ? "hover:bg-surface-1 hover:text-ink-0" : "pointer-events-none opacity-0"
    }`;

  return (
    <>
      <button
        onClick={() => nudge(-1)}
        aria-label="Scroll left"
        aria-hidden={!canLeft}
        tabIndex={canLeft ? 0 : -1}
        className={arrowClass(canLeft)}
      >
        ‹
      </button>
      <div
        ref={strip}
        onScroll={update}
        className={`flex min-w-0 flex-1 items-center overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden ${className}`}
      >
        {children}
      </div>
      <button
        onClick={() => nudge(1)}
        aria-label="Scroll right"
        aria-hidden={!canRight}
        tabIndex={canRight ? 0 : -1}
        className={arrowClass(canRight)}
      >
        ›
      </button>
    </>
  );
}
