from api.models import Order, Payload
from api.store import db


class BadRequest(Exception):
    pass


def parse(req: dict) -> Payload:
    errors = []
    if not req.get("customer"):
        errors.append("customer is required")
    if not req.get("items"):
        errors.append("at least one item is required")
    return Payload(customer=req.get("customer", ""), items=list(req.get("items", [])), errors=errors)


def create_order(req: dict) -> dict:
    payload = parse(req)
    if not payload.valid:
        raise BadRequest(payload.errors)
    order = Order.from_payload(payload)
    db.save(order)
    return order.to_json()
