#!/usr/bin/env bash
# Fail if a change adds content under data/ or media/img|gif.
#
# WHY A CHECK, WHEN .gitignore ALREADY COVERS THIS
# ------------------------------------------------
# It does not cover this. `.gitignore` governs which UNTRACKED files git will discover
# and stage on its own. It has no opinion about content arriving from a ref, so every
# one of these walks straight past it:
#
#     git add -f data/secret
#     git cherry-pick <an upstream commit that touches data/>
#     git checkout upstream/main -- data/
#
# That last one is precisely the move CLAUDE.md singles out: "Upstream's git history
# contains all three as real values, so never restore or cherry-pick a data/ path from
# upstream." The ignore file cannot stop it, because by the time the bytes arrive they
# are not untracked files being discovered - they are tracked content being written.
#
# What is at stake, from CLAUDE.md and NOTICE.md:
#   data/          the session secret, the VAPID PRIVATE key, users' passkey credentials
#   media/img|gif  ~137 MB of third-party exercise media that NOTICE.md states is not
#                  distributed here, fetched on first run instead
#
# Both keep a .gitkeep so the compose bind mounts stay valid, and that is the only thing
# either directory may contain in git. An EMPTY .gitkeep is allowed. A .gitkeep with
# content in it is not, because "put it in the file nobody looks at" is the obvious way
# around a path rule.
#
# WHAT THIS DOES NOT DO
# ---------------------
# - It does not scan content. It is a PATH rule. A key pasted into api/server.js or into
#   a commit message is not caught here, and nothing in this repo catches that today.
# - It guards the CHANGE, not history. Anything already in the base tree passes.
# - It cannot see a secret that never becomes a diff: a value typed into a running
#   container, or one sitting in an untracked file, is outside its reach entirely.
#
# Usage:  scripts/check-protected-paths.sh <base-ref> [head-ref]
#         scripts/check-protected-paths.sh HEAD~1
set -uo pipefail

BASE="${1:-}"
HEAD_REF="${2:-HEAD}"

if [ -z "$BASE" ]; then
  echo "COULD NOT VERIFY - no base ref given. usage: $0 <base-ref> [head-ref]" >&2
  exit 1
fi

# An unresolvable base means we cannot compute a diff, and a check that cannot reach its
# subject reports that rather than passing. Branch creation hands us the all-zero SHA;
# a force push hands us a SHA that no longer exists.
case "$BASE" in *[!0]*) ;; *) BASE="" ;; esac
if [ -z "$BASE" ] || ! git cat-file -e "${BASE}^{commit}" 2>/dev/null; then
  BASE=$(git rev-parse -q --verify "${HEAD_REF}^" 2>/dev/null || true)
  if [ -z "$BASE" ]; then
    echo "COULD NOT VERIFY - cannot resolve a base commit to diff against." >&2
    exit 1
  fi
  echo "note: base ref was unusable; falling back to ${BASE}"
fi

echo "diffing ${BASE}..${HEAD_REF}"

# --no-renames: a rename shows as add+delete, so moving a file INTO data/ is an add.
# --diff-filter=AM: additions and modifications. Deletions cannot publish anything.
mapfile -t touched < <(
  git diff --name-only --no-renames --diff-filter=AM "$BASE" "$HEAD_REF" -- \
    'data/' 'media/img/' 'media/gif/' 2>/dev/null
)

violations=()
for path in "${touched[@]}"; do
  [ -n "$path" ] || continue
  if [ "$(basename "$path")" = ".gitkeep" ]; then
    # Allowed only while empty. `git cat-file -s` gives the blob size in bytes.
    size=$(git cat-file -s "${HEAD_REF}:${path}" 2>/dev/null || echo 0)
    if [ "$size" -eq 0 ]; then
      continue
    fi
    violations+=("$path  (a .gitkeep is permitted, but this one carries ${size} bytes)")
    continue
  fi
  violations+=("$path")
done

if [ ${#violations[@]} -gt 0 ]; then
  echo
  echo "REFUSED - this change writes into a protected directory:"
  for v in "${violations[@]}"; do
    echo "  $v"
  done
  cat <<'MSG'

data/ holds the session secret, the VAPID PRIVATE key and users' passkey credentials.
media/img and media/gif hold ~137 MB of third-party exercise media that NOTICE.md states
is not distributed from this repository; `docker compose up` and scripts/fetch-media.sh
fetch it on first run.

Neither directory may carry anything but an empty .gitkeep.

If this arrived from upstream - a cherry-pick, or `git checkout upstream/main -- data/` -
drop it. CLAUDE.md: upstream's git history contains the session secret, the VAPID private
key and real passkey credentials as literal values. .gitignore did not stop this because
it never could: it governs which untracked files git discovers, not content written from
a ref.

If you believe a real secret has been committed anywhere, stop and flag it rather than
deleting the file - the value is in the history from that moment on and has to be
rotated, not tidied away.
MSG
  exit 1
fi

echo "OK - nothing added or modified under data/, media/img or media/gif"

# The carve-outs in .gitignore are policy, with their reasoning in comments, and
# CLAUDE.md forbids regenerating the file from a stock Node template. A stock template
# would silently drop all four lines, and the first symptom would be a secret in a diff.
# -F is load-bearing: these lines contain literal '*' and '!', and `grep -x` alone is
# still a REGEX match, so '/data/*' would be read as "/data" plus zero-or-more slashes
# and would not match the literal line it is meant to find. That false alarm is how this
# check first failed.
missing=()
while IFS= read -r rule; do
  grep -qxF -- "$rule" .gitignore || missing+=("$rule")
done <<'RULES'
/data/*
!/data/.gitkeep
/media/img/*
/media/gif/*
RULES
if [ ${#missing[@]} -gt 0 ]; then
  echo
  echo "REFUSED - .gitignore has lost its protective carve-outs:"
  for m in "${missing[@]}"; do echo "  missing: $m"; done
  echo
  echo "CLAUDE.md: never regenerate .gitignore from a stock Node template - it carries"
  echo "these as policy, with the reasoning in comments. Append to it; do not replace it."
  exit 1
fi
echo "OK - .gitignore still carries its four protective carve-outs"
