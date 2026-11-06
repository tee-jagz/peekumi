"""Save real API responses for the production pane preview. No scores are fabricated."""
import json
from pathlib import Path
import sys

from integration_e2e_test import IntegrationTests

out = Path(sys.argv[1])
out.mkdir(parents=True, exist_ok=True)
fixture = IntegrationTests()
fixture.setUp()
try:
    fixture.add_refund()
    cart = fixture.repo / "shop/ui/cart.py"
    cart.write_text("from shop.db.orders import save\n" + cart.read_text())
    incomplete = fixture.client.call("map",baseline=fixture.baseline)
    fixture.measurement()
    before = fixture.client.call("map",baseline=fixture.baseline)
    cart.write_text(cart.read_text().replace("from shop.db.orders import save\n", ""))
    tests = fixture.repo / "test_shop.py"
    tests.write_text(tests.read_text() + "\n\ndef test_refunds():\n    from shop.ui.cart import refund\n    assert [refund(i) for i in range(7)] == [0, 1, 2, 3, 4, 5, 0]\n")
    fixture.measurement()
    after = fixture.client.call("map",baseline=fixture.baseline)
    assert before["status"] == "findings", before
    assert after["status"] == "passed", after
    for name,value in [("before",before),("after",after),("incomplete",incomplete)]:
        value["peekumi_url"] = "http://127.0.0.1:4317"
        (out / (name + ".json")).write_text(json.dumps(value))
    print(json.dumps({"before":before["status"],"after":after["status"],"baseline_sha":before["baseline_sha"],"before_sha":before["snapshot_sha"],"after_sha":after["snapshot_sha"]}))
finally:
    fixture.doCleanups()
