# Accessibility

Peekumi meets WCAG 2.2 AA. Some rules go further, because the owner works with one hand on a phone.

## Targets

- Every touch target is at least 44 × 44px (`tap`), with at least 8px between targets. This is above WCAG 2.5.8 (24px) and matches Apple's 44pt.
- Map cards have a 44px hit area, also when the drawn card is smaller.
- On a fine pointer (desktop), controls can be `control-fine` (32px) high.

## Contrast

- Text: 4.5:1. Large text (24px, or 19px at 600): 3:1.
- Icons, edges, control borders and focus rings that carry meaning: 3:1.
- Every token pair in **Colour** passes in all four themes.

## Colour

- Never use colour alone. Each status has a glyph, a line style or a word.
- Two colour-blind safe themes move added to blue and removed to orange.

## Focus

- A 2px `focus` ring with a 2px offset on every focusable part.
- A sticky header, the sheet or the composer never hides the focused part fully (WCAG 2.4.11). Use `scroll-padding`.

## Gestures

- Every drag has a single-tap alternative (WCAG 2.5.7): the grabber cycles the sheet heights, and the map has zoom and pan buttons.
- Back closes the open page or the raised sheet first.

## Screen readers

- The map has a list view of the same tree.
- Each card's accessible name gives the name, the kind, the status and the counts: "engine.rs, file, modified, 3 changed declarations, 2 rule breaks".
- Status changes (a run ends, an answer arrives) use a polite live region.
- Modal dialogs use `<dialog>` with `showModal()`, trap focus, close with Escape and return focus to their trigger.
- The visible label of a control is part of its accessible name (WCAG 2.5.3).

## Text

- Nothing is smaller than 12px. Text fields are 16px.
- The layout survives 200% text zoom and the WCAG 1.4.12 text spacing.
- Never block zoom.

## Motion

- Respect `prefers-reduced-motion`: cross-fades only, no loops.
- Nothing flashes more than three times a second.
