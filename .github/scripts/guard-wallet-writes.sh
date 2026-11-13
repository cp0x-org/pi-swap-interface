#!/usr/bin/env bash
# The signing choke point (ARCHITECTURE.md D10), checked a second way next to the ESLint rule: no code outside
# src/execute/accounts/ may call a wallet write method, reach one through call/apply/bind or Reflect, name a signing
# RPC method or Wallet Standard feature (an EIP-1193 request({method}) needs no method call), or import a wagmi write
# hook or action. ESLint can be disabled with a comment. This grep cannot.
#   .github/scripts/guard-wallet-writes.sh [dir]      # from the repository root; dir defaults to src
set -euo pipefail
cd "$(dirname "$0")/../.."
DIR="${1:-src}"

# Same lists as WALLET_WRITES / RPC_WRITES in eslint.config.js.
WRITES='sendTransaction|sendRawTransaction|writeContract|signTypedData|signMessage|signTransaction|signAllTransactions|signAndSendTransaction|signAndSendAllTransactions|signAndSendTransactions|signDelegateActions|sendCalls|signData'
HOOKS='useSendTransaction|useWriteContract|useSignTypedData|useSignMessage|useSendCalls'
RPC='eth_sendTransaction|eth_sendRawTransaction|eth_signTransaction|eth_sign|personal_sign|eth_signTypedData(_v[134])?|wallet_sendCalls|solana:signAndSendTransaction|solana:signAndSendAllTransactions|solana:signTransaction|solana:signMessage|solana:signIn|tron_signTransaction|tron_signMessage'

# Member calls (x.signTypedData(...), x?.sendTransaction(...), x["signTransaction"](...)), .call/.apply/.bind on a
# write, Reflect.*, TronWeb's trx (tronWeb.trx.sign, ["trx"], a destructured {trx}: any unquoted `trx` but a type's
# optional `trx?:`), the RPC / feature names as string literals, and the hook names.
CALLS="(\??\.[[:space:]]*($WRITES)[[:space:]]*(\(|\.[[:space:]]*(call|apply|bind)[[:space:]]*\())|(\[[[:space:]]*[\"'\`]($WRITES)[\"'\`][[:space:]]*\])|\bReflect[[:space:]]*\.|(^|[^\"'\`[:alnum:]_\$])trx([^\"'\`[:alnum:]_\$?]|\?[^:]|$)|\[[[:space:]]*[\"'\`]trx[\"'\`][[:space:]]*\]|\b($HOOKS)\b"
LITERALS="[\"'\`]($RPC)[\"'\`]"

# Comment lines are skipped (doc comments name `solana:signTransaction` in backticks); a comment can't call anything.
hits=$(grep -rnE --include='*.ts' --include='*.tsx' "$CALLS|$LITERALS" "$DIR" | grep -v "^$DIR/execute/accounts/" | grep -vE '^[^:]+:[0-9]+:[[:space:]]*(\*|//|/\*)' || true)
if [ -n "$hits" ]; then
  echo "Wallet write calls outside $DIR/execute/accounts/ (ARCHITECTURE.md D10):"
  echo "$hits"
  exit 1
fi
echo "OK: wallet writes only in $DIR/execute/accounts/"
