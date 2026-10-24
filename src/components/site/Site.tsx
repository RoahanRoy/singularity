"use client";

// Shared chrome for the public pages: the paper tokens from the desk, plus the
// brand, theme button, top nav and footer every public page carries.

import "@/app/desk/desk.css";
import "./site.css";
import type { ReactNode } from "react";
import Link from "next/link";
import type { Theme } from "@/lib/meridian/theme";

export function Brand({ href = "/" }: { href?: string }) {
  return (
    <Link href={href} className="s-brand">
      <span className="m-mark" aria-hidden />
      <b>Meridian</b>
    </Link>
  );
}

export function ThemeButton({ theme, toggle }: { theme: Theme; toggle: () => void }) {
  return (
    <button className="m-sq" onClick={toggle} aria-label={theme === "dark" ? "Switch to light" : "Switch to dark"}>
      <span className="m-icon" aria-hidden>
        {theme === "dark" ? "light_mode" : "dark_mode"}
      </span>
    </button>
  );
}

/** Sticky top bar: brand, an optional middle slot, then theme + `end`. */
export function SiteNav({
  theme,
  toggle,
  middle,
  end,
  wide,
}: {
  theme: Theme;
  toggle: () => void;
  middle?: ReactNode;
  end?: ReactNode;
  wide?: boolean;
}) {
  return (
    <header className="s-nav">
      <div className="s-wrap s-nav-in" style={wide ? { maxWidth: "none" } : undefined}>
        <Brand />
        {middle}
        <div className="s-nav-end">
          <ThemeButton theme={theme} toggle={toggle} />
          {end}
        </div>
      </div>
    </header>
  );
}

export function SiteFooter({ links }: { links: [string, string][] }) {
  return (
    <footer className="s-foot">
      <div className="s-wrap s-foot-in">
        <span>© 2026 Meridian Capital Intelligence</span>
        {links.map(([label, href]) => (
          <Link key={href} href={href}>
            {label}
          </Link>
        ))}
      </div>
    </footer>
  );
}
