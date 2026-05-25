"use client";

import { ReactNode } from "react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { lookup } from "@/lib/meridian/glossary";

export function GlossTerm({ term, children }: { term?: string; children: ReactNode }) {
  const key = term ?? (typeof children === "string" ? children : "");
  const entry = lookup(key);
  if (!entry) return <span className="gloss">{children}</span>;
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger
          render={(props) => (
            <span {...props} className="gloss">
              {children}
            </span>
          )}
        />
        <TooltipContent
          side="top"
          className="max-w-xs border border-white/10 bg-zinc-950/95 text-zinc-100 backdrop-blur"
        >
          <div className="font-medium text-[12px] leading-tight">{entry.title}</div>
          <div className="mt-1 text-[11px] leading-snug text-zinc-300">{entry.body}</div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
