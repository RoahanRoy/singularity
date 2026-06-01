"use client";

import { ReactNode, createContext, useCallback, useContext, useEffect, useState } from "react";
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
  // URL hint wins (e.g. the Kite callback redirects to /?market=IN), then storage.
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
}

export function MarketProvider({ children }: { children: ReactNode }) {
  // Start "US" on both server and first client render to avoid a hydration
  // mismatch; reconcile to the persisted value in an effect.
  const [market, setMarketState] = useState<Market>("US");

  useEffect(() => {
    const initial = readInitial();
    setMarketState(initial);
    persist(initial);
  }, []);

  const setMarket = useCallback((m: Market) => {
    setMarketState(m);
    persist(m);
  }, []);

  return <MarketCtx.Provider value={{ market, setMarket }}>{children}</MarketCtx.Provider>;
}
