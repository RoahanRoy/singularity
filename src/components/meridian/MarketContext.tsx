"use client";

import { ReactNode, createContext, useCallback, useContext, useState } from "react";
import type { Market } from "@/lib/meridian/format";

const STORAGE_KEY = "meridian_market";
const COOKIE_KEY = "meridian_market";

type MarketState = { market: Market; setMarket: (m: Market) => void };

const MarketCtx = createContext<MarketState>({ market: "US", setMarket: () => {} });

export function useMarket(): MarketState {
  return useContext(MarketCtx);
}

function readInitial(): Market {
  if (typeof window === "undefined") return "US";
  // URL hint wins (e.g. a link to /desk?market=IN), then storage.
  const fromUrl = new URLSearchParams(window.location.search).get("market");
  if (fromUrl === "IN" || fromUrl === "US") return fromUrl;
  const stored = window.localStorage.getItem(STORAGE_KEY);
  return stored === "IN" ? "IN" : "US";
}

function persist(m: Market) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(STORAGE_KEY, m);
  // Cookie so server route handlers / agents can read the active desk.
  document.cookie = `${COOKIE_KEY}=${m}; path=/; max-age=${60 * 60 * 24 * 365}; SameSite=Lax`;
  // The address carries the desk, so a copied link opens the same one.
  const u = new URL(window.location.href);
  if (u.searchParams.get("market") !== m) {
    u.searchParams.set("market", m);
    window.history.replaceState(window.history.state, "", u);
  }
}

export function MarketProvider({ children }: { children: ReactNode }) {
  // Mounted only under AuthGate, after the client has checked the sign-in, so
  // there is no server render to match: read the desk once, up front, and
  // load nothing for the other desk first.
  const [market, setMarketState] = useState<Market>(() => {
    const initial = readInitial();
    persist(initial);
    return initial;
  });

  const setMarket = useCallback((m: Market) => {
    setMarketState(m);
    persist(m);
  }, []);

  return <MarketCtx.Provider value={{ market, setMarket }}>{children}</MarketCtx.Provider>;
}
