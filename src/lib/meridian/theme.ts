"use client";

import { useCallback, useSyncExternalStore } from "react";

export type Theme = "light" | "dark";

// One appearance preference shared by every public page and the desk.
const KEY = "meridian-theme";
const EVENT = "meridian-theme-change";

function read(): Theme | null {
  try {
    const t = window.localStorage.getItem(KEY);
    return t === "dark" || t === "light" ? t : null;
  } catch {
    return null;
  }
}

function subscribe(cb: () => void) {
  window.addEventListener(EVENT, cb);
  window.addEventListener("storage", cb);
  const mq = window.matchMedia("(prefers-color-scheme: dark)");
  mq.addEventListener("change", cb);
  return () => {
    window.removeEventListener(EVENT, cb);
    window.removeEventListener("storage", cb);
    mq.removeEventListener("change", cb);
  };
}

/**
 * The stored appearance, else `fallback`. With `followSystem`, an unset
 * preference follows the OS instead. The server (and hydration) always sees
 * `fallback`, so markup never mismatches.
 */
export function useTheme(fallback: Theme, followSystem = false): [Theme, () => void] {
  const theme = useSyncExternalStore(
    subscribe,
    () => {
      const t = read();
      if (t) return t;
      if (followSystem && window.matchMedia("(prefers-color-scheme: dark)").matches) return "dark";
      return fallback;
    },
    () => fallback,
  );
  const toggle = useCallback(() => {
    const next: Theme = theme === "dark" ? "light" : "dark";
    try {
      window.localStorage.setItem(KEY, next);
    } catch {
      /* storage blocked — nothing to persist the choice in */
    }
    window.dispatchEvent(new Event(EVENT));
  }, [theme]);
  return [theme, toggle];
}
