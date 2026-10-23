#!/usr/bin/env bash
#
# Entry point for the scheduled cloud routines (Claude Code cloud environment,
# where LLM calls run on the account's Claude subscription login — no API key).
# Every step is a separate short command so none outlives the sandbox's
# per-command timeout:
#
#   bash scripts/cloud-run.sh us prep      deps, Appwrite check, Horizon book sync, news + filings sweep, retention
#   bash scripts/cloud-run.sh us cycle     one analyst-chain cycle on the US desk
#   bash scripts/cloud-run.sh us quant     ~8 min of the daily quant sweep
#   bash scripts/cloud-run.sh india prep|cycle|quant
#
# `cycle` exit codes: 0 ran · 3 market closed (stop for today) ·
#                     4 subscription usage limit hit (stop for today) · other = failed
# `quant` exit codes: 0 every name fresh · 5 names left (run it again) ·
#                     4 subscription usage limit hit (stop for today) ·
#                     6 quant data hosts not allowlisted · other = failed
#
# One-time setup of the cloud environment (claude.ai → Code → environment settings):
#   network access  Custom, keep the default list, and add www.sec.gov data.sec.gov
#                   www.nseindia.com news.google.com query1.finance.yahoo.com
#                   fra.cloud.appwrite.io singularity-gules-ten.vercel.app
#                   (quant desk: also query2.finance.yahoo.com
#                   fc.yahoo.com fred.stlouisfed.org mba.tuck.dartmouth.edu cdn-api.cboe.com)
#   network secret  host fra.cloud.appwrite.io, header X-Appwrite-Key, value = the
#                   APPWRITE_API_KEY from .env.local (the key never enters the session)
#   network secret  host singularity-gules-ten.vercel.app, header Authorization,
#                   value = "Bearer " + the CRON_SECRET from .env.local (Horizon book sync)
#
set -uo pipefail
cd "$(dirname "$0")/.."

desk="${1:-}"; step="${2:-}"
case "$desk" in
  us)    market=US; loop=tech-loop;  prefix=MERIDIAN_TECH ;;
  india) market=IN; loop=india-loop; prefix=MERIDIAN_INDIA ;;
  *) echo "usage: $0 us|india prep|cycle|quant" >&2; exit 64 ;;
esac

# The sandbox egresses through its HTTPS proxy, which Node's fetch ignores
# unless told to use it (appwrite.ts also unpins the Appwrite SDK's dispatcher
# under this flag, so its requests get the proxy-added key).
export NODE_USE_ENV_PROXY=1
# Fresh checkout every run → cursors/watermarks live in Appwrite (agent_state).
export MERIDIAN_STATE_STORE=appwrite
# The proxy attaches X-Appwrite-Key itself (network secret above).
export MERIDIAN_APPWRITE_KEY_VIA_PROXY=1
export NEXT_PUBLIC_APPWRITE_ENDPOINT="${NEXT_PUBLIC_APPWRITE_ENDPOINT:-https://fra.cloud.appwrite.io/v1}"
export NEXT_PUBLIC_APPWRITE_DATABASE_ID="${NEXT_PUBLIC_APPWRITE_DATABASE_ID:-meridian}"
export MERIDIAN_SYNC_BASE="${MERIDIAN_SYNC_BASE:-https://singularity-gules-ten.vercel.app}"
# The quant desk's 38 agents need the extra hosts listed above and add about
# 4 minutes and 7 LLM calls to an analysed cycle, so it stays off in the cloud
# until those hosts are allowlisted. Set MERIDIAN_QUANT=1 to turn it on.
export MERIDIAN_QUANT="${MERIDIAN_QUANT:-0}"
[ -d node_modules ] || npm ci --no-audit --no-fund --loglevel=error || exit 1
export NEXT_PUBLIC_APPWRITE_PROJECT_ID="${NEXT_PUBLIC_APPWRITE_PROJECT_ID:-$(node -p "require('./appwrite.json').projectId")}"

case "$step" in
  prep)
    # Fail fast, with a pointer to the setup, if Appwrite isn't reachable/authorised.
    # Goes through the agents' own client so it takes the same (proxied) route.
    if ! npx tsx --eval "
      const { db, DB } = require('./scripts/agents/appwrite.ts');
      db.listDocuments(DB, 'agent_state', []).catch((e) => {
        console.error('[cloud] appwrite check: ' + (e.code ?? e.cause?.code ?? '') + ' ' + e.message); process.exit(1);
      });
    " >/dev/null; then
      echo "[cloud] Appwrite unreachable or unauthorised: check the network allowlist and the X-Appwrite-Key network secret" >&2
      exit 2
    fi
    echo "[cloud] appwrite ok"
    # Re-pull the real book from Horizon so the sweeps below cover today's holdings.
    # The proxy attaches the app's bearer (network secret above). Best-effort.
    code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 90 -X POST "$MERIDIAN_SYNC_BASE/api/horizon/sync")
    case "$code" in
      200) echo "[cloud] horizon sync ok" ;;
      401) echo "[cloud] horizon sync unauthorised: check the Authorization network secret (continuing)" >&2 ;;
      *)   echo "[cloud] horizon sync failed: HTTP $code (continuing)" >&2 ;;
    esac
    MERIDIAN_NEWS_ONCE=1 MERIDIAN_NEWS_MARKETS="$market" npx tsx scripts/agents/news.ts 2>&1 | grep -v "^\[dotenv" | tail -4
    MERIDIAN_INGEST_ONCE=1 npx tsx scripts/agents/ingest-held.ts 2>&1 | grep -v "^\[dotenv" | tail -6
    # Trim old quant_reports so the Free plan's 2 GB storage never fills.
    npx tsx scripts/agents/retention.ts --apply 2>&1 | grep "^\[retention\]"
    ;;
  cycle)
    # MERIDIAN_IGNORE_MARKET_HOURS=1 runs anyway (weekend check on the last close).
    if [ "${MERIDIAN_IGNORE_MARKET_HOURS:-}" != 1 ]; then
      label=$(npx tsx --eval "const s = require('./scripts/agents/market-hours.ts').marketState('$market'); console.log(s.label); process.exit(s.open ? 0 : 3);")
      if [ $? -ne 0 ]; then echo "[cloud] $market market closed ($label): skipping"; exit 3; fi
    fi
    log="$(mktemp)"
    env "${prefix}_ONCE=1" npx tsx "scripts/agents/${loop}.ts" >"$log" 2>&1
    rc=$?
    # Keep the routine transcript short: the ticker header, decisions, problems.
    grep -E "^=== |^\[(trade|memo|alert|handoff)\]|[Ee]rror|failed" "$log" | head -40
    echo "--- last lines ---"; tail -5 "$log"
    if grep -qiE "usage limit|limit reached" "$log"; then
      echo "[cloud] subscription usage limit reached: stop for today"; exit 4
    fi
    exit $rc
    ;;
  quant)
    # Refresh the quant desk for every covered name on this desk, oldest first.
    # Resumable, so the routine repeats this step while it exits 5. Runs the
    # quant desk regardless of MERIDIAN_QUANT, which only gates desk cycles.
    # Check the quant data hosts first: a blocked host fails every name slowly.
    blocked=""
    for h in query2.finance.yahoo.com fc.yahoo.com fred.stlouisfed.org mba.tuck.dartmouth.edu cdn-api.cboe.com; do
      [ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "https://$h/")" = 000 ] && blocked="$blocked $h"
    done
    if [ -n "$blocked" ]; then
      echo "[cloud] quant hosts unreachable:$blocked (add them to the environment's network allowlist)" >&2
      exit 6
    fi
    MERIDIAN_QUANT=1 MERIDIAN_QUANT_SWEEP_MARKETS="$market" \
    MERIDIAN_QUANT_SWEEP_BUDGET_MS="${MERIDIAN_QUANT_SWEEP_BUDGET_MS:-480000}" \
      npx tsx scripts/agents/quant-sweep.ts 2>&1 | grep -E "^\[sweep\]|^=== |[Ee]rror" | tail -30
    exit "${PIPESTATUS[0]}"
    ;;
  *) echo "usage: $0 us|india prep|cycle|quant" >&2; exit 64 ;;
esac
