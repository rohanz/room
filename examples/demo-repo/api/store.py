class _Store:
    def __init__(self) -> None:
        self.orders: dict[int, object] = {}

    def save(self, order) -> None:
        self.orders[order.id] = order


db = _Store()
