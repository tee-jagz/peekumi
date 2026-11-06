"""Shop cart presentation."""
from shop.services.orders import total


def cart_total(amount):
    """Return the order total for the cart."""
    return total(amount)
