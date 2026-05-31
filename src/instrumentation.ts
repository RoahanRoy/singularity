/**
 * Next.js instrumentation hook — runs once when the server boots.
 *
 * We auto-start the operator-console responder so the assistant replies to
 * operator turns without anyone manually running `npm run agents:responder`.
 * Disable with MERIDIAN_AUTOSTART=0.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  // On Vercel (serverless) we can't spawn long-lived children and there's no
  // `claude login` session — the dispatcher owns agents there. Don't even try.
  if (process.env.VERCEL) return;
  if (process.env.MERIDIAN_AUTOSTART === "0") return;
  // Avoid double-spawn during Next dev's two-pass boot.
  if (process.env.MERIDIAN_SUPERVISED === "1") return;

  const { startAgent } = await import("@/lib/agents/supervisor");
  try {
    const s = startAgent("responder");
    console.log(`[meridian] auto-started responder pid=${s.pid}`);
  } catch (err) {
    console.warn(`[meridian] failed to auto-start responder: ${(err as Error).message}`);
  }
}
