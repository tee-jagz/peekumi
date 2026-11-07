"""Check the existing cart path. Refund tests are added during the repair."""
from shop.ui.cart import cart_total


def test_cart():
    assert cart_total(5) == 5
