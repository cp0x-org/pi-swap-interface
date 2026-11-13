/** A controllable window.matchMedia for jsdom (which has none): min-width queries against a settable width. */
type Listener = (e: MediaQueryListEvent) => void;

export interface FakeViewport {
  setWidth(width: number): void;
  restore(): void;
}

export function installMatchMedia(initialWidth: number): FakeViewport {
  let width = initialWidth;
  const lists: {query: string; min: number; listeners: Set<Listener>; last: boolean}[] = [];
  const matches = (min: number) => width >= min;
  const original = window.matchMedia;
  window.matchMedia = (query: string): MediaQueryList => {
    const min = Number(/min-width:\s*(\d+)px/.exec(query)?.[1] ?? 0);
    const entry = {query, min, listeners: new Set<Listener>(), last: matches(min)};
    lists.push(entry);
    return {
      get matches() {
        return matches(min);
      },
      media: query,
      onchange: null,
      addEventListener: (_: string, l: Listener) => entry.listeners.add(l),
      removeEventListener: (_: string, l: Listener) => entry.listeners.delete(l),
      addListener: (l: Listener) => entry.listeners.add(l),
      removeListener: (l: Listener) => entry.listeners.delete(l),
      dispatchEvent: () => true,
    } as unknown as MediaQueryList;
  };
  return {
    setWidth(next) {
      width = next;
      for (const e of lists) {
        const now = matches(e.min);
        if (now === e.last) continue;
        e.last = now;
        for (const l of e.listeners) l({matches: now, media: e.query} as MediaQueryListEvent);
      }
    },
    restore() {
      window.matchMedia = original;
    },
  };
}
