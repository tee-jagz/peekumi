# Product and engineering documentation

This directory records the product scope, the architecture, the validation results and the original design context of Peekumi. It explains the mobile experience for repository inspection and the engineering decisions for that experience.

- `USER-GUIDE.md`: How to use all parts of the interface, with labelled screenshots and an icon reference. The images are in `guide/`, and `scripts/guide-screenshots.mjs` generates them again.
- `SETUP.md`: Installation, phone pairing, devices and pull requests.
- `DEVELOPMENT.md`: The build, how to run a checkout, tests, benchmarks and analysis limits.
- `MVP.md`: The scope and the interaction contract.
- `ARCHITECTURE.md`: Runtime components, the API and the read-only boundaries.
- `EXTENDING.md`: How to add a language adapter or an agent provider: the contract, the steps and the definition of done.
- `RELATIONSHIPS.md`: The supported static relationships, the configuration of dependency rules and the analysis limits.
- `WORKFLOW.md`: Comments, runs, reports, verification and operational boundaries.
- `VALIDATION.md`: The recorded evidence from tests and benchmarks.
- `design/`: The design system: principles, tokens, components, rules and mockups. Each interface change must obey its rules.
- `brand/`: The artwork for the Peek mascot and the Peekumi app icon, with colours and how to use them.
- `context/`: The original specification and the archive of the visual prototype.
