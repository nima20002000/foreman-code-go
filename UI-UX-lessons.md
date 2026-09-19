# UI/UX lessons

This file is the project's accumulated UI/UX judgment.

It is **not a changelog**. Do not record every screen, component, commit, or visual tweak here. Record the reason a UI/UX problem happened, what the project learned from fixing it, and the rule future work should follow so the same class of problem does not return.

Before changing UI or UX, read this file. When a fix teaches a reusable lesson, update this file in the same change.

## 1. The interface must reflect the real source of truth

The UI has repeatedly become confusing when local presentation state looked more authoritative than the real product state.

A saved server object, an editable draft, a URL selection, an in-flight request, and temporary local interaction state are different things. Do not blur them together just because one component can hold all of them.

**Project rule:**

- TanStack Query data is server truth and request lifecycle state.
- The URL owns linkable navigation, filters, selected views, and other state that should survive sharing/reload.
- Zustand/local component state owns temporary interaction state only when it does not belong to the server or URL.
- Never make a local override look persisted if the server rejected it.
- Never let an older refetch replace a newer accepted revision in the UI.

This lesson is behind fixes that preserved server-owned agent settings, retained failed edits without pretending they were saved, and protected newer revisions from stale query results.

Evidence: `d92d49f` (`fix(web): persist agent settings and lock Start through accepted run completion`), `94a235e` (`fix PR17 usability findings 16 through 31`).

## 2. Navigation has to answer one question clearly: “Where am I?”

Navigation became unstable when expansion, activation, routing, and drag behavior were mixed together. A workspace row that both navigated and expanded was ambiguous, multiple workspaces could look active at once, and nested drag gestures could accidentally arm parent reordering.

**Project rule:**

- Active state must come from route/product context, not from a second competing selection state.
- Only the current workspace should look active. Expanding a tree item is not the same as activating it.
- Separate navigation actions from disclosure actions when one control would otherwise do two jobs.
- Persist useful disclosure state, but do not let stale expanded sections compete with the current route.
- Nested drag/reorder surfaces must not trigger parent reordering.
- Linkable navigation belongs in the URL and needs stable deep links.

Evidence: `1e31e31` (`fix: stabilize workspace navigation state`), `710cc2f` (`fix: keep one workspace active`), `35dc7c6` (`feat(settings): add workspace detail navigation`).

## 3. Do not create relationships the user did not ask for

Adding two agents used to connect them automatically. That made a convenient guess on the user's behalf, but it changed workflow meaning without an explicit handoff action.

**Project rule:** adding an object and connecting objects are separate intentions. New agents/nodes should be added in a neutral state unless the user explicitly chose a relationship or the product contract guarantees one.

This applies beyond graph edges: do not silently assign reviewers, permissions, defaults with side effects, or cross-object relationships just because they are common.

Evidence: `3ecdde0` (`fix: keep added agents disconnected`).

## 4. Make the common safe path short; keep advanced configuration available after it

The graph originally forced a configuration step just to add a default Codex/OpenCode agent. The fix made the provider choice itself add the default profile in one action. Advanced settings still exist, but they are no longer a toll booth in front of the common path.

**Project rule:** if a safe, valid project default already exists, let the common action use it directly. Do not force users through advanced configuration before they can perform the basic action. Advanced settings should remain discoverable and editable afterward.

The shortcut must never invent unsafe permissions or hide a meaningful choice. “Use the default” is only valid when the default is already an accepted product configuration.

Evidence: `6f78537` (`fix: add default harness agents in one step`).

## 5. Controls should appear because there is something meaningful to do

A save control that is always present suggests that something needs saving even when nothing changed. It also hides which edits actually make a workflow dirty.

**Project rule:**

- Save/Discard controls should appear or enable only for meaningful unsaved changes.
- Dirty state must include every change that affects what will be persisted, including nested agent settings or cleanup caused by removed entities.
- Do not fabricate a draft just to make a control available.
- If an action depends on a clean/persisted state, explain what must be saved instead of exposing unrelated save buttons.

Evidence: `4ab9e58` (`fix: show graph save controls only for changes`).

## 6. Preserve user work across navigation, failures, and conflicts

Settings fixes repeatedly came from the same root problem: forms treated mount/unmount, save failures, refetches, or revision conflicts as permission to throw away the user's draft.

**Project rule:**

- Unsaved edits should survive normal navigation-style unmount/remount when the user reasonably expects to come back.
- A failed save must keep the attempted values visible and editable.
- An uncertain request must not be silently re-sent as though it definitely failed.
- Revision conflicts need explicit review. Show what changed on the server and what changed locally, then let the user reapply or discard deliberately.
- Do not merge ordered arrays (for example permission rules) by index as though they were independent fields.
- Provider-specific drafts may be cached for editing, but only the active provider configuration should be serialized.

Evidence: `6295a01` (`fix: preserve settings drafts and mobile approvals`), `d92d49f`, `94a235e`.

## 7. Editable drafts and accepted executable configuration are different contracts

Approval settings exposed a UX problem when validation required a final orchestrator choice too early. Users need to be able to choose “orchestrator” first and designate the exact agent next; the intermediate draft is incomplete but still valid as an editing state.

**Project rule:** do not make every intermediate editing state satisfy the final executable schema. Use a draft contract for forms and a stricter accepted contract at the save/run boundary. Validate the final requirement at the moment it becomes product truth.

This keeps forms usable without weakening execution safety.

Evidence: `e67e191` (`fix: separate draft and accepted approval settings`).

## 8. Long-running actions must follow the durable lifecycle, not the click lifecycle

The Start button was once vulnerable to becoming available again while a run was still loading/queued, and cancellation/recovery states were not fully surfaced.

**Project rule:** button state must follow the durable operation lifecycle. Once an action is accepted, keep conflicting actions locked until the product says the operation is actually complete, canceled, failed, or otherwise safe to retry. Initial status loading and queued states count as active states.

For destructive or expensive actions, protect against double submission with both UI state and an in-flight guard. Do not rely only on a button's current render.

Evidence: `d92d49f`.

## 9. Approvals are decision-support UI, not a dump of backend records

The Approval Inbox improved when it stopped leading with IDs and raw JSON and started showing human names, the operation being requested, the workflow, the assigned reviewer, response scope, delivery state, and warnings about persistent/provider-wide effects.

**Project rule:**

- Put the information needed for the decision first; put raw IDs and provider payloads under technical details.
- Show readable workspace/workflow/agent names when available. If unavailable, say that honestly instead of showing a misleading placeholder as though it were a real name.
- Explain what each approval choice applies to and whether it changes persistent policy or other pending requests.
- A monitoring view and permission to respond are separate capabilities. Never infer response authority from the fact that a user can see a request.
- Keep Pending, Delivery problems, and History conceptually separate.
- Counts and filtered queues must be based on the authoritative dataset, not “whatever happened to be in the first page of history.”
- Surface pending approvals near the workflow that needs attention so the user does not have to discover them by accident.

Evidence: `94a235e`, `89ae09c` (`feat: show pending approval workflow badges`).

## 10. Loading, empty, error, stale, and retry states are part of the design

Blank space and generic failures made several surfaces harder to understand than the underlying backend failure required.

**Project rule:** every server-backed surface should deliberately handle:

- initial loading;
- empty success;
- refresh failure while existing data is still useful;
- hard error with no usable data;
- retry/in-flight feedback;
- success/acknowledgement when it matters.

Do not erase usable stale content just because a refresh failed. Error messages should say what remains available and what the user can do next.

The Nocturne migration moved these states into shared `LoadingState`, `EmptyState`, `ErrorState`, `Alert`, and button-loading patterns so behavior stays consistent instead of each screen inventing its own version.

Evidence: `9afe3a5` (`feat(web): complete Nocturne UI migration`), `94a235e`.

## 11. Responsive behavior must be designed as a different interaction layout, not just narrower CSS

Mobile fixes were needed because desktop structures remained technically present but became awkward or unreachable on narrow screens.

**Project rule:**

- Collapse navigation automatically when entering phone widths when that gives the main task enough room.
- Two-pane selection/detail layouts should become an intentional one-column flow on narrow screens.
- When opening detail on mobile, move focus to the detail. When closing it, return focus to the item that opened it when possible.
- Important actions should wrap or become full-width when horizontal space disappears.
- Long settings panels and popovers need bounded height and scrolling rather than overflowing the viewport.
- Test narrow viewports for collision and reachability, not only for CSS snapshots.

Evidence: `6295a01`, `94a235e`.

## 12. Focus and keyboard behavior are product behavior

A number of fixes added or corrected focus return, stable `aria-controls`, inert hidden panels, keyboard reordering, visible labels, and dialog behavior. These are not cleanup details; they determine whether the interface has a coherent interaction model.

**Project rule:**

- Opening a dialog/drawer/popover should place focus at the useful starting control.
- Closing it should return focus to the trigger when that trigger still exists.
- Hidden/collapsed interactive content must not remain keyboard reachable. Use `inert`/equivalent behavior where appropriate.
- `aria-controls` should refer to a stable element ID, not disappear just because the controlled region is collapsed.
- Reordering needs keyboard controls, not pointer-only drag behavior.
- Validation should be attached to the field, expose the message via `aria-describedby`, and focus/reveal the first invalid field after submit/check.
- Status cannot depend on color alone; pair color with text/icon/shape.
- Respect reduced-motion preferences. Animation should explain change, not gate understanding.

Evidence: `1e31e31`, `94a235e`, `b99d422` (`feat(web): adopt Nocturne UI foundation`).

## 13. Reusable UI primitives should encode behavior, not only visual style

The Nocturne work was most valuable where it replaced one-off behavior with consistent components: dialogs, drawers, menus, fields, alerts, loading/error/empty states, status badges, buttons, tooltips, command UI, and workflow primitives.

**Project rule:** a design-system component is not “done” because it looks consistent. It should also carry the project's expected focus, keyboard, disabled, loading, validation, dismissal, status, and responsive behavior.

When fixing a repeated interaction problem, prefer repairing the shared primitive when the same behavior exists in multiple consumers. Keep feature-specific semantics in the feature instead of making the design system know business rules.

Evidence: `b99d422`, `9afe3a5`.

## 14. Embedded surfaces must not duplicate page chrome

The Approval Inbox looked wrong when a full standalone page header/padding was rendered inside a Settings detail page that already provided its own header and layout.

**Project rule:** reusable full-page features that can also be embedded need an explicit embedded presentation mode or a composition boundary that lets the parent own page chrome. Do not stack duplicate headings, max-width containers, or padding just because both layers are valid in isolation.

Evidence: `fcbf550` (`fix(settings): align approval inbox layout`).

## 15. Give complex settings their own route and clear way back

Workspace settings became easier to navigate when execution location and browser settings stopped sharing one overloaded page state and became dedicated detail routes with a clear “Back to settings” path.

**Project rule:** if a settings area has enough content or state to be a task of its own, give it a stable route. The overview should help users choose a destination; the detail page should focus on that task and preserve a clear return path.

Do not simulate detail navigation with hidden local tabs when the state should be linkable, refreshable, and shareable.

Evidence: `35dc7c6`.

## 16. Full-height workspaces need an unbroken flex/min-size contract

The workflow graph lost its intended height when an execution-location wrapper was inserted without becoming part of the flex column chain. The child was correct, but an ancestor stopped allowing it to grow/shrink.

**Project rule:** for full-height editors/canvases, every wrapper between the shell and the editor must preserve the layout contract: appropriate `display:flex`, `flex:1`, direction, and `min-width:0` / `min-height:0` where overflow needs to shrink inside the viewport.

When a canvas suddenly collapses or overflows after adding a wrapper, inspect the ancestor chain before changing the canvas itself.

Evidence: `fa60dc0` (`fix workflow graph execution wrapper layout`).

## 17. Configuration changes must remove incompatible hidden state

Provider and sandbox settings can make previously valid nested fields meaningless or unsafe. Keeping those values hidden in the draft can cause surprising behavior when the user saves or switches back later.

**Project rule:** when a controlling choice makes dependent settings invalid, clear or normalize the incompatible dependent state deliberately and explain the consequence near the control when it is important. Do not silently retain permissions that the newly selected mode cannot honor.

Likewise, if provider presets/options fail to load, do not silently substitute built-in values and make them look authoritative. Tell the user the real source is unavailable and require an explicit fallback choice.

Evidence: `94a235e`, `e90c6e1` (`fix: harden workflow settings and approval UI`).

## 18. Demo and preview UI must be unmistakably non-production

The UI toolkit intentionally labels preview data and preview actions so a polished demo cannot be mistaken for a real run or a saved backend change.

**Project rule:** if a component showcase, preview, fixture, or offline lab contains actions that look real, label the environment and the result clearly. Replay controls, preview saves, sample runs, and demo notifications must not imply that they operated real agents or changed production settings.

Evidence: `b99d422`.

## 19. Tests should protect the UX reason, not incidental markup

The useful UI regression tests in the history assert things such as: exactly one workspace is active; failed edits stay visible; Save controls do not appear when clean; mobile focus moves to the detail; nested drags do not reorder a parent; hidden content is not interactive; and a full-height wrapper remains a flex column.

**Project rule:** write tests around the product promise that caused the fix. Prefer roles, accessible names, route state, focus, persisted/draft state, and meaningful layout contracts over brittle class snapshots or exact internal markup.

A test should make it obvious why reverting the behavior would hurt the user.

Evidence: the regression coverage added with `1e31e31`, `710cc2f`, `4ab9e58`, `6295a01`, `d92d49f`, `94a235e`, `fa60dc0`.

---

## How future agents should update this file

When a UI/UX fix teaches something reusable, update this file before handing off the work.

1. Identify the underlying reason the old behavior was wrong. Avoid “button moved left” or “changed padding” unless the spacing problem reveals a broader layout rule.
2. Find an existing lesson with the same cause and add the new evidence there. Create a new lesson only when future design decisions would change because of it.
3. State a durable project rule in plain language.
4. Add the relevant regression-test idea or behavior that should prevent the mistake from returning.
5. Add commit evidence when a commit already exists. If the change is not committed yet, name the affected behavior/files and let the integration agent replace that with the final commit reference if useful.
6. Keep the file about lessons. Do not append a chronological “what changed today” section.

The goal is that each round of UI work starts with more project-specific judgment than the last one.
