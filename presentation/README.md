# Durable Workflow Engine — Visual Walkthrough

A self-contained, 17-slide presentation about the workflow engine in this
repository. It uses only HTML, CSS, and a small local JavaScript file — no
build step, no external fonts, no CDN, and no network access.

## What it covers

The deck builds the mental model in this order:

1. **Idempotency** — repeating an operation has the same effect as doing it once.
2. **Saga** — completed steps are undone in reverse after a permanent failure.
3. **Steps** — the durable unit of work that makes both guarantees concrete.

After that it walks through the architecture, data model, lifecycle, recovery,
fencing, retries, the demo, the API, verification, and trade-offs.

## Open it

Open `presentation/index.html` directly in a browser.

If you prefer to serve it locally:

```sh
python3 -m http.server 8765 --directory presentation
# then open http://localhost:8765/
```

## Present it

| Key | Action |
| --- | --- |
| `→` / `Space` / `PageDown` | Next slide |
| `←` / `PageUp` | Previous slide |
| `Home` / `End` | First / last slide |
| `N` | Toggle speaker notes |
| `D` | Toggle document mode (all slides stacked) |
| `F` | Toggle fullscreen |

The on-screen controls in the bottom-right corner expose the same actions.
Swipe left/right on a touch screen to navigate.

Speaker notes are stored as `<aside class="notes">` in the HTML, one per slide.
They are visible only when notes are toggled on.

## Read it as a document

Press `D` to show every slide in a single scrollable page. The counter and
progress bar follow the scroll position. Press `D` again to return to
presentation mode.

If JavaScript is unavailable, the deck falls back to the same stacked document
layout automatically.

## Print or export to PDF

Use the browser's print dialog (`Ctrl+P` / `Cmd+P`) and choose **Save as PDF**.
The stylesheet forces one landscape page per slide and hides controls, notes,
and the progress bar. The result should be 17 pages.

## Editing

- `index.html` — slide markup and speaker notes
- `styles.css` — theme, layouts, diagrams, document mode, responsive rules,
  and print rules
- `script.js` — navigation, hash routing, notes/document/fullscreen toggles

All content lives in this folder and is safe to move or archive as a unit.
