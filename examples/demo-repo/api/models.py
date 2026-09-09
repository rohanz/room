from dataclasses import dataclass, field


@dataclass
class Payload:
    customer: str
    items: list[str]
    errors: list[str] = field(default_factory=list)

    @property
    def valid(self) -> bool:
        return not self.errors


@dataclass
class Order:
    id: int
    customer: str
    items: list[str]

    @classmethod
    def from_payload(cls, payload: Payload) -> "Order":
        return cls(id=Order.next_id(), customer=payload.customer, items=list(payload.items))

    _counter = 0

    @classmethod
    def next_id(cls) -> int:
        Order._counter += 1
        return Order._counter

    def to_json(self) -> dict:
        return {"id": self.id, "customer": self.customer, "items": self.items}
