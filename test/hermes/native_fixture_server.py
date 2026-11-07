"""Keep a disposable Peekumi fixture alive while the native Desktop demo runs."""
import json
import sys
from integration_e2e_test import IntegrationTests, REFUND

fixture = IntegrationTests()
fixture.setUp()
try:
    print(json.dumps({"repository":str(fixture.repo),"repo":fixture.repo_id,"url":fixture.url,
        "token":fixture.client.token,"python":fixture.measure_python,
        "cart":(fixture.repo/"shop/ui/cart.py").read_text(),"tests":(fixture.repo/"test_shop.py").read_text(),"refund":REFUND}),flush=True)
    sys.stdin.readline()
finally:
    fixture.doCleanups()
