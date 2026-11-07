"""Shop order calculations."""
from shop.db.orders import save


def total(amount):
    """Send an order amount to storage."""
    return save(amount)
