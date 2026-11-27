#!/usr/bin/env bash
# Checks the pinned toolchain (MER-01). Usage: scripts/doctor.sh <solana> <anchor>
set -u
want_solana="$1"; want_anchor="$2"; ok=1
check() { if [ "$2" = "$3" ]; then echo "ok   $1 $2"; else echo "FAIL $1: have '$2', want '$3'"; ok=0; fi; }
have_solana=$(cargo-build-sbf --version 2>/dev/null | awk '/cargo-build-sbf/{print $2}')
have_anchor=$(anchor --version 2>/dev/null | awk '{print $2}')
check "cargo-build-sbf (agave)" "${have_solana:-missing}" "$want_solana"
check "anchor-cli" "${have_anchor:-missing}" "$want_anchor"
if rustc --version >/dev/null 2>&1; then echo "ok   $(rustc --version)"; else echo "FAIL rustc missing"; ok=0; fi
if grep -RInE "api\.mainnet-beta|mainnet\.helius|mainnet-beta\.solana" --exclude-dir=target --exclude-dir=.git --exclude=doctor.sh . >/dev/null; then
  echo "FAIL a mainnet RPC URL appears in the repo"; ok=0
else
  echo "ok   no mainnet RPC URLs"
fi
[ "$ok" = 1 ] || exit 1
