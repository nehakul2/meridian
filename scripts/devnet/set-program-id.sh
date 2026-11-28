#!/usr/bin/env bash
# Switches the program id to the public key of a keypair you hold (needed once for a devnet deploy
# when you do not have the keypair for the current declare_id!). Rewrites declare_id!, Anchor.toml
# and the committed IDL address, then rebuilds. Commit the result; keep the keypair out of git.
#   scripts/devnet/set-program-id.sh path/to/program-keypair.json
set -euo pipefail
kp="${1:?usage: set-program-id.sh <program-keypair.json>}"
root="$(cd "$(dirname "$0")/../.." && pwd)"
new="$(solana-keygen pubkey "$kp")"
# sed, not grep -P: macOS grep has no -P.
old="$(sed -nE 's/.*declare_id!\("([1-9A-HJ-NP-Za-km-z]+)"\).*/\1/p' "$root/programs/meridian/src/lib.rs")"
[ -n "$old" ] || { echo "declare_id! not found in programs/meridian/src/lib.rs" >&2; exit 1; }
[ "$old" = "$new" ] && { echo "program id already $new"; exit 0; }
grep -rl "$old" "$root/programs/meridian/src/lib.rs" "$root/Anchor.toml" "$root/programs/meridian/idl/meridian.json" \
  | xargs sed -i.bak "s/$old/$new/g"
find "$root" -name '*.bak' -path '*meridian*' -o -name 'Anchor.toml.bak' | xargs rm -f
cp "$kp" "$root/target/deploy/meridian-keypair.json" 2>/dev/null || true
echo "program id $old -> $new; rebuilding"
make -C "$root" build
