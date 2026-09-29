# Reference implementation

The earlier Node backend is retained as a regression oracle and performance baseline. Production runs the Rust backend; these modules support comparison tests for the original Python and TypeScript behavior.

New directory documentation and adapter discovery are tested separately because they extend the original API. The reference implementation does not extract Rust syntax.
