# Reference implementation

This directory keeps the earlier Node backend as a regression oracle and a performance baseline. Production uses the Rust backend. These modules are for comparison tests of the original Python and TypeScript behavior.

Separate tests check the new directory documentation and adapter discovery, because these functions extend the original API. The reference implementation does not extract Rust syntax.

`timeline.mjs` is a frozen copy of the session parser that the app used before the server read conversations. `test/conversation.test.mjs` compares the server's items with it on the same logs.
