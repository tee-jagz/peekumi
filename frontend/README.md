# Frontend

The browser interface lets you explore repository structure, compare commits, follow dependencies, and inspect source from a phone. It renders the SVG map and the glass review panel using JavaScript, HTML and CSS.

- `app.js`: navigation, API requests, revision controls and the review panel.
- `ask.js`: scope-specific conversations and explicit suggestion-to-draft actions.
- `workflow.js`: comments, task preparation, run progress, agent evidence and verification.
- `model.js`: directory hierarchy, dependency aggregation and symbol diff filtering.
- `icons.js`: original rounded-stroke SVGs shared by object types, Git status and input/output indicators, with accessible names and tooltips.
- `canvas.js`: SVG pan, pinch, zoom and card positioning.
- `index.html` and `style.css`: page structure and responsive appearance.

The phone sheet expands from a compact selection summary to half or full height using pointer or keyboard controls. Details, Source, Changes, Relations and Discussion are direct views, while the Ask/Comment composer remains independent at the bottom. The dock follows the visual viewport when a phone keyboard opens. A single SVG graph remains the navigation surface; commit mini cards appear only in Time mode. Glass styling is shared by the sheet, buttons, tabs, inputs and revision selects (native select popups follow the browser).

The frontend displays committed documentation as plain text. It does not execute code from inspected repositories. The backend embeds these assets when built.

The sheet follows pointer movement continuously and animates to a snap height on release; reduced-motion settings disable settling animation. Height changes preserve the graph DOM and transform. The canvas Legend explains Git colours and static relationship line styles, with text appropriate to the active colour lens.

Both Time and Diff follow the selected commit’s first parent by default, independent of the launch-time base. Selecting a base pins it while changing heads, refreshing or switching modes. The revision picker’s automatic option or “Use previous commit” clears that override. Explicit comment/run inspection preserves its requested comparison range.

The compact phone sheet shows the selection description and available input/output types, without inspection controls. Half and full heights reveal navigation and complete declaration details; missing types remain explicitly unspecified. Legend lives beside the canvas zoom controls and opens upward over the graph.

Selection status, review lists and the legend use shape-distinct coloured SVG icons without badge borders or backgrounds, and the contract uses entering/leaving arrows for inputs/outputs. Icons have accessible names and tooltips; the canvas legend explains them. Modified items use orange in both themes.

Tasks are reachable directly from the persistent composer. Draft selection, a readable task preview, agent updates, results and review share one task view. Raw event streams and generated prompts are diagnostics. Unified diffs show before/after line numbers and hide Git transport headers. Reviewing records owner verification only; the interface explicitly distinguishes this from applying or deploying changes. Git ancestry determines whether task commits have been applied to the watched branch; deployment is not inferred from that status.

The header branch picker inspects local and already-fetched remote-tracking refs without checking out or fetching branches. History follows the selected branch and the selection survives reload in the URL. Completed tasks expose Review agent branch; Tasks shows a ready count until review. Dispatch still targets the configured watched branch, identified in the task preview.

Map cards use one neutral object-type icon beside the name, derived from adapter metadata. Folders, file groups, files/modules, classes/structs, functions/methods, interfaces/traits and enums have distinct icon families. Exact types remain available through accessible names and tooltips. Card tint carries Git status; redundant status dots are omitted from card titles and filename previews. Descriptions, counts and symbol-change previews remain intact.
