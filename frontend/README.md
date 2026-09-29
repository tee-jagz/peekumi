# Frontend

The browser interface lets you explore repository structure, compare commits, follow dependencies, and inspect source from a phone. It renders the SVG map and the glass review panel using JavaScript, HTML and CSS.

- `app.js`: navigation, API requests, revision controls and the Details panel.
- `workflow.js`: comments, task preparation, run progress, agent evidence and verification.
- `model.js`: directory hierarchy, dependency aggregation and symbol diff filtering.
- `canvas.js`: SVG pan, pinch, zoom and card positioning.
- `index.html` and `style.css`: page structure and responsive appearance.

The frontend displays committed documentation as plain text. It does not execute code from inspected repositories. The backend embeds these assets when built.
