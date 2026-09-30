#!/usr/bin/env bash
# Three independent tasks in one file; each can be assigned to a separate worker.
set -euo pipefail
bash "$(dirname "$0")/shop.sh"
mkdir -p api
cat > api/handlers.py <<'PY'
def validate_coupon(code: str) -> bool:
    return bool(code)


def refund_total(cents: int, fee: int) -> int:
    return cents - fee


def shipping_quote(subtotal: int, shipping: int) -> int:
    return subtotal + shipping


def charge_total(cents: int, tax: int) -> int:
    return cents + tax


def checkout_total(cents: int, tax: int) -> int:
    return charge_total(cents, tax)
PY
cat >> README.md <<'MD'

## Same-file handler tickets

All three tickets touch `api/handlers.py`, but edit different functions:

- Coupons: reject blank and whitespace-only codes in `validate_coupon`.
- Refunds: clamp `refund_total` at zero when the fee exceeds the payment.
- Shipping: make `shipping_quote` reject a negative shipping charge.

Two independent bugs are the coupons and refunds tickets. A separate contract
change would rename `charge_total` to `payment_total` in its definition and
`checkout_total` call, and add a
`discount` parameter to that same function. Do those dependent edits together.
MD
