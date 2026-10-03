# Reference implementation

This directory keeps the earlier Node backend as a regression oracle and a performance baseline. Production uses the Rust backend. These modules are for comparison tests of the original Python and TypeScript behavior.

Separate tests check the new directory documentation and adapter discovery, because these functions extend the original API. The reference implementation does not extract Rust syntax.
