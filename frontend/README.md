# Frontend

The browser interface lets you explore repository structure, compare commits, follow dependencies, and inspect source from a phone. It renders the SVG map and the glass review panel using JavaScript, HTML and CSS.

- `app.js`: navigation, API requests, revision controls and the review panel.
- `ask.js`: scope-specific conversations and explicit suggestion-to-draft actions.
- `workflow.js`: comments, task preparation, run progress, agent evidence and verification.
- `model.js`: directory hierarchy, dependency aggregation and symbol diff filtering.
- `canvas.js`: SVG pan, pinch, zoom and card positioning.
- `index.html` and `style.css`: page structure and responsive appearance.

The phone sheet expands from a compact selection summary to half or full height using pointer or keyboard controls. Details, Source, Changes, Relations and Discussion are direct views, while the Ask/Comment composer remains independent at the bottom. The dock follows the visual viewport when a phone keyboard opens. A single SVG graph remains the navigation surface; commit mini cards appear only in Time mode. Glass styling is shared by the sheet, buttons, tabs, inputs and revision selects (native select popups follow the browser).

The frontend displays committed documentation as plain text. It does not execute code from inspected repositories. The backend embeds these assets when built.

The sheet follows pointer movement continuously and animates to a snap height on release; reduced-motion settings disable settling animation. Height changes preserve the graph DOM and transform. The canvas Legend explains Git colours and static relationship line styles, with text appropriate to the active colour lens.

Both Time and Diff follow the selected commit’s first parent by default, independent of the launch-time base. Selecting a base pins it while changing heads, refreshing or switching modes. The revision picker’s automatic option or “Use previous commit” clears that override. Explicit comment/run inspection preserves its requested comparison range.

The compact phone sheet shows the selection description and available input/output types, without inspection controls. Half and full heights reveal navigation and complete declaration details; missing types remain explicitly unspecified. Legend lives beside the canvas zoom controls and opens upward over the graph.
