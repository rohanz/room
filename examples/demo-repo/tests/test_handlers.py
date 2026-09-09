import pytest

from api.handlers import BadRequest, create_order


def test_create_order_returns_json():
    out = create_order({"customer": "ada", "items": ["tea"]})
    assert out["customer"] == "ada"
    assert out["items"] == ["tea"]


def test_missing_customer_is_bad_request():
    with pytest.raises(BadRequest):
        create_order({"items": ["tea"]})
