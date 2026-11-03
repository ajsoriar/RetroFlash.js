# RetroFlash.js Functional Priorities

This document gathers the features discussed as possible next steps for improving practical SWF compatibility. The priorities and effort estimates are an initial assessment; validate them against a representative collection of target SWFs before committing to a roadmap.

## Recommended order

| Order | Area | Priority | Estimated effort |
|---:|---|---|---|
| 1 | Basic local `SharedObject` | High | Medium |
| 2 | Editing existing text fields | High | Medium-high |
| 3 | `Stage` API for scale, size, and viewport changes | Medium-high | Low-medium |
| 4 | Loading movies into `_level1` and above | Medium-high | High |
| 5 | ActionScript-created `TextField` and `TextFormat` | Medium-high | High |
| 6 | `MovieClip` drawing API | Medium | High |
| 7 | `LocalConnection` between movies | Medium | Medium-high |
| 8 | Blend modes and graphic filters | Medium | High |

## 1. Basic local `SharedObject`

This lets games save scores, settings, and progress between sessions. Without persistence, an SWF can play but loses its state when the application closes.

**Suggested initial scope:** `SharedObject.getLocal()`, access to `data`, `flush()`, and `clear()`, with storage isolated by movie and origin. Leave `remote` out of the first iteration.

**Effort:** Medium. The basic API is bounded; compatible serialization, storage limits, privacy, and quota errors require explicit decisions.

**Reference:** [LIMITATIONS.md, SharedObject](../../LIMITATIONS.md#L59).

## 2. Editing existing text fields

`DefineEditText` fields are rendered but do not accept input. Enabling them would let users type into fields already included in an SWF, such as names, answers, or login details.

**Suggested initial scope:** focus, keyboard input, caret, selection, insertion and deletion, basic length limits, and updating the bound variable. Defer IME and composed text to a later iteration.

**Effort:** Medium-high. Text input must integrate with canvas focus, keyboard events, selection, and the existing text model.

**Reference:** [LIMITATIONS.md, text fields](../../LIMITATIONS.md#L26).

## 3. `Stage` API

The player can adjust visual scaling, but ActionScript does not receive accurate `Stage.scaleMode`, `Stage.width`, `Stage.height`, or resize events. Fixing this matters for games that adapt their interface to the available viewport.

**Suggested initial scope:** expose the effective scale and dimensions through the ActionScript API, dispatch a resize event when the viewport changes, and document when `resize()` must be called if code changes the canvas size.

**Effort:** Low-medium compared with the other areas; it requires aligning the player's layout with the API exposed to the SWF.

**Reference:** [LIMITATIONS.md, scaling and Stage](../../LIMITATIONS.md#L11).

## 4. Levels `_level1` and above

`loadMovieNum(url, n)` and equivalent calls can overlay other movies without replacing `_level0`. This is used to split sites or games across separate SWFs and load menus, modules, or overlays.

**Suggested initial scope:** non-negative integer levels, SWF loading and unloading, independent playback, drawing in level order, and basic `_levelN` paths. Start with SWFs; image loading and full Flash semantics can follow later.

**Effort:** High. The current architecture starts from a single root; multiple roots require coordinated loading, updates, drawing, lifecycle, and path resolution.

**Reference:** [LIMITATIONS.md, loading into levels](../../LIMITATIONS.md#L55).

## 5. ActionScript-created `TextField` and `TextFormat`

Allowing ActionScript to create and format fields would support interfaces that build labels, prompts, or input fields at runtime instead of including them as `DefineEditText` in the SWF.

**Suggested initial scope:** `createTextField`, basic `TextField` properties, static and dynamic text, common formatting, and field removal. Defer advanced HTML, stylesheets, and full selection integration.

**Effort:** High; this expands both the AVM1 runtime and the object and text-layout systems.

**Reference:** [LIMITATIONS.md, TextField](../../LIMITATIONS.md#L32).

## 6. `MovieClip` drawing API

The `beginFill`, `lineStyle`, `moveTo`, `lineTo`, `curveTo`, and `clear` methods let ActionScript generate graphics at runtime. This matters for games and interfaces drawn from code.

**Suggested initial scope:** solid fills and basic strokes; add gradients, fill rules, and other details after validating the first use cases.

**Effort:** High. Commands need a representation as dynamic content, rendering, and consistent transforms, bounds, ordering, and lifecycle.

**Reference:** [LIMITATIONS.md, MovieClip](../../LIMITATIONS.md#L41).

## 7. `LocalConnection` between movies

This lets SWF movies exchange messages over a named channel. It is useful for separate modules and can complement multiple levels, though it can also connect independent player instances.

**Suggested initial scope:** local connections within the same page context, channel registration and closing, message sending, and calls to the receiver method. Leave cross-process communication out of the first iteration.

**Effort:** Medium-high. The implementation needs clear rules for instance isolation, connection names, serialization, and closed connections or missing methods.

**Reference:** [LIMITATIONS.md, interoperability](../../LIMITATIONS.md#L58).

## 8. Blend modes and graphic filters

Blend modes and filters (shadows, blur, glow, bevel, and others) improve visual fidelity for movies that use them. They matter for appearance, but are usually less likely to block functional flows than persistence, text, or levels.

**Suggested initial scope:** implement the most common blend modes and filters separately, with visual tests. Avoid trying to cover every filter in one release.

**Effort:** High, especially for filters with parameters, masks, groups, and effects that need intermediate surfaces.

**Reference:** [LIMITATIONS.md, blend modes and filters](../../LIMITATIONS.md#L13).

## Choosing the final order

- For standalone games: prioritize `SharedObject`, text input, and `Stage`.
- For portals or projects composed of multiple SWFs: move levels earlier, followed by `LocalConnection`.
- For content drawn from code: move the `MovieClip` drawing API and dynamic `TextField` earlier.
- For primarily visual improvements: implement blend modes and filters in small increments.

Before starting a large area, use a target collection to measure which features occur and which ones prevent a complete user flow.
