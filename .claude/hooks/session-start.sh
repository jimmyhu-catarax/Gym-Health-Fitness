#!/usr/bin/env bash
# SessionStart hook for Claude Code on the web / any Linux container.
#
# SESSION_SETUP.md opens with "run first, every session" and, until this file existed,
# there was no .claude/ directory at all — so nothing executed it. An instruction with no
# executor is a hope. This is the executor.
#
# Two jobs, and the second matters more than the first:
#   1. Get the container to the point where `npm test` and `npm run build` can run.
#   2. State plainly what this environment CANNOT verify, so a cloud session never
#      reports a Docker, media or mobile-shell behaviour as tested.
#
# Idempotent: safe to run on every session start. Never exits non-zero — a hook that
# fails the session start is worse than one that reports a degraded environment, so
# everything here reports and continues.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT" || exit 0

# ── Node: the floor is 22.5, and the reason is specific ──────────────────────────────
# sqlite.test.js and import-health.test.js build their fixtures with the built-in
# node:sqlite, which older Node does not have. A failure there says nothing about the
# code under test, so it is worth naming before the suite is ever run.
NODE_OK=0
if command -v node >/dev/null 2>&1; then
  NODE_V="$(node -v)"
  if node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit((a>22||(a===22&&b>=5))?0:1)'; then
    NODE_OK=1
  else
    echo "[session-start] node $NODE_V is BELOW the 22.5 floor — sqlite.test.js and"
    echo "[session-start] import-health.test.js will fail on node:sqlite, for a reason that"
    echo "[session-start] has nothing to do with the code. Do not report that as a test failure."
  fi
else
  echo "[session-start] node not found — nothing npm can run in this session."
fi

# ── Dependencies: everything npm lives in frontend/, there is no root package.json ────
if [ "$NODE_OK" = "1" ]; then
  if [ ! -d frontend/node_modules ] || [ frontend/package-lock.json -nt frontend/node_modules ]; then
    echo "[session-start] installing frontend dependencies (npm ci)"
    if ! (cd frontend && npm ci --no-audit --no-fund >/dev/null 2>&1); then
      echo "[session-start] npm ci FAILED — run it by hand in frontend/ to see why."
    fi
  fi
fi

# ── Media: absent, and its absence is normal ─────────────────────────────────────────
MEDIA_STATE="NOT fetched (normal)"
if [ -n "$(ls -A media/img 2>/dev/null | grep -v '^\.gitkeep$' || true)" ]; then
  MEDIA_STATE="present"
fi

cat <<EOF
[session-start] Gym-Health-Fitness — $(git branch --show-current 2>/dev/null || echo "detached")

  Read first:     SESSION_SETUP.md, then CLAUDE.md. Reconcile the Environment Record
                  against git — the Record is a cache, and git is the truth.

  Runs here:      cd frontend && npm test   (vitest, needs node >= 22.5)
                  cd frontend && npm run build
                  VITE_DEMO=1 npm run dev   (guest mode, seeded example history)
                  node scripts/build-instructions.mjs

  Media:          $MEDIA_STATE. In \`npm run dev\`, /img/* and /gif/* return 502 and
                  THAT IS EXPECTED — Vite proxies them to a media server that only
                  exists once ~137 MB has been fetched. The app renders fine without it.

  Does NOT run here — nothing in this list may be marked verified from a cloud session:
    - docker compose up            (and note: after a git pull it restarts the OLD
                                    image and nothing errors — pass --build)
    - the passkey / push API end to end   needs real VAPID keys and a secure origin
    - Capacitor Android / iOS shells      need the platform SDKs
    - anything reading real data/          it holds live user state at runtime and is
                                           empty here except .gitkeep

  Hard rules this environment cannot enforce for you:
    - NEVER commit data/ or media/. .gitignore does not stop \`git add -f\`, a
      cherry-pick, or \`git checkout upstream/main -- data/\`. CI's \`secrets\` job does;
      run it locally with:  scripts/check-protected-paths.sh <base-ref>
    - Upstream's git history contains the session secret, the VAPID PRIVATE key and real
      passkey credentials as literal values. Never restore or cherry-pick a data/ path
      from upstream. If you see a real secret in a diff, stop and flag it — it has to be
      rotated, not deleted.
    - New dependencies are a hard sell (CONTRIBUTING.md). Propose and wait.
    - Ask before \`rm\` against data/, \`docker compose down -v\`, or any history rewrite.
    - website/ is upstream's marketing site and is left alone until issue #6 lands.
EOF

exit 0
