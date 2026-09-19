# UI/UX lessons

Read this file before changing UI or UX. It captures reusable design judgment: why an interaction fails, what works better, and how to protect that improvement. Examples illustrate principles; they are not an action history or a claim that every check below has just been run.

## 1. Make persistence and state ownership unambiguous

**Lesson:** Users must be able to distinguish saved truth from edits and temporary interaction state. Competing sources of truth produce false success and lost work.

**Bad UX:** A rejected setting still looks saved, a refetch overwrites newer accepted values, or two workspaces appear active because local selection disagrees with the route.

**Good UX:** TanStack Query owns server data and request lifecycle; the URL owns linkable navigation, filters, and selected views; local state/Zustand owns temporary interaction state. Keep drafts distinct from accepted values and reject stale revisions. After creation, make the accepted object available to the route's query projection before selecting it; if opening fails, retry Open without repeating Create.

**Protect it:** Check rejected saves, stale refetches, reload/deep links, and creation followed by navigation. Accepted values and route selection must remain consistent.

## 2. Give each navigation gesture one meaning

**Lesson:** Navigation, disclosure, and reordering are separate intentions. Combining them makes location and movement unpredictable.

**Bad UX:** Expanding a workspace changes the route, dragging a child reorders its parent, or Back leads to an unrelated page from browser history.

**Good UX:** Separate disclosure from activation, derive active styling from the route, and isolate nested drag gestures. Preserve useful expansion without making expanded items look active. Workspace names open that workspace’s settings; keep disclosure separate and avoid a duplicate settings child in the sidebar. Give substantial settings tasks stable detail routes and one Back link to the immediate product parent, available during loading and errors. Send dirty navigation through the shared leave guard.

**Protect it:** Check one active workspace, independent expansion, nested reordering, direct detail links, and parent navigation with clean and dirty forms.

## 3. Shorten the safe path without inventing intent

**Lesson:** Defaults should remove unnecessary decisions, not silently make consequential ones.

**Bad UX:** Adding an agent requires an advanced setup form, or automatically connects it to another agent and changes workflow meaning.

**Good UX:** A provider choice can add an agent with an accepted safe default, with advanced settings available afterward. Adding and connecting remain separate actions. Never silently assign reviewers, broaden permissions, or create relationships. In creation forms, show inherited defaults and preview consequential results such as the new folder path; apply changing defaults only to untouched fields, never to existing objects.

**Protect it:** Check default creation, explicit relationships, preservation of touched fields and existing locations, and required provisioning authority.

## 4. Make browsing reversible and confirmation decisive

**Lesson:** Exploration must not commit a choice. Once the user confirms, redundant confirmations and ambiguous save boundaries undermine confidence.

**Bad UX:** Users must type an absolute path; Back selects a folder; Create and use requires another selection and another Save; a save failure causes retry to create the folder again.

**Good UX:** Offer a keyboard-accessible folder field that opens browsing, with a trailing folder icon rather than a duplicate Browse action. Identify the owning machine and restrict browsing to approved roots. Start at the selected allowed folder. Back restores the prior browsing location, including root/page changes, without changing the selection; without history it reaches the parent, stays available after navigation errors, and is disabled at the root. Reset transient history on reopen.

Use one New folder entry point and one Create and use confirmation while naming, with no duplicate cancel row. Preserve the name on failure and reject collisions. Make the commit boundary explicit: a draft picker changes only its owning form's draft; the workspace execution-location picker saves on confirmation and closes only after acknowledgement. Cancel preserves the prior value. Keep errors in the modal and lock conflicting actions while pending. If creation succeeded but saving failed, retry saving that same folder; uncertain retries retain command identity. A workspace location applies to its workflows without repeated setup.

**Protect it:** Check drill-down/Back, cancellation, root boundaries, pagination, failed listings, keyboard activation, creation collisions, and partial-success retries. Existing coverage anchors include `WorkspaceExecutionLocationSettings.test.tsx`, folder-picker regressions, and authenticated Operator MCP folder permission/readback tests.

## 5. Match controls to meaningful work

**Lesson:** Controls communicate available actions and unfinished work. Redundant or misplaced controls obscure both.

**Bad UI:** A clean graph shows Save/Discard, preferences sit in the action footer, or a form repeats fixed IDs and a separate validation step that confirmation already performs.

**Good UI:** Graph Save/Discard appears only for actual local edits or a publishable shared draft, never initial hydration. A persistent settings Save button is disabled when clean. Include nested edits and removal cleanup in dirty detection. Put preferences in their relevant section, use the shared switch for binary choices, and keep footers for actions. Show editable choices and relevant feedback; explain save prerequisites where the dependent action lives.

**Protect it:** Check clean/dirty transitions, nested edits, removed entities, and keyboard-accessible preferences. Never fabricate a draft merely to enable an action.

## 6. Preserve drafts and resolve leaving deliberately

**Lesson:** Navigation, refetches, and failed requests do not mean the user intended to abandon work.

**Bad UX:** A failed save resets fields, switching sections loses edits, or leaving during an uncertain save offers Discard as though nothing may have persisted.

**Good UX:** Preserve expected drafts across unmount/remount and keep failed values editable. The shared leave dialog offers Save and Discard; closing it or pressing Escape keeps editing and restores focus without a redundant Keep editing button. Resume the original destination only after resolution, block repeated navigation while deciding, and await save acknowledgement. Preserve validation failures and newer edits; never offer Discard for in-flight or unconfirmed commands. Use the browser warning for refresh/tab close.

Show conflicts for deliberate reapply/discard, distinguishing server and local changes; do not merge ordered rules by index. Cache provider drafts only for editing and serialize only the active provider. Keep failed-message reasons attached to their durable request identity across reloads, clearing them on receipt without automatic retry.

**Protect it:** Check navigation, dismissal/Escape, focus return, remounts, failed saves, conflicts, uncertain requests, and edits made while saving.

## 7. Validate at the right commitment boundary

**Lesson:** An incomplete editing step can be legitimate even when it is not executable. Premature final validation prevents users from reaching a valid configuration.

**Bad UX:** Choosing orchestrator approval is impossible until an orchestrator is already selected, or an invalid-graph warning persists throughout ordinary editing.

**Good UX:** Allow intermediate states through a draft contract and enforce the stricter accepted contract at save/run. After submission, show actionable structured errors near the relevant fields, retain the draft, and keep retry available. Focus/reveal the first invalid field and associate its error using `aria-describedby`; secondary actions such as Rename follow the same rule and send no mutation for an empty name.

**Protect it:** Check incomplete-to-valid editing, invalid submission, field focus, retained input, and executable validation at acceptance.

## 8. Follow durable operations through to their actual outcome

**Lesson:** A click finishing is not an operation finishing, and completion is not necessarily success.

**Bad UX:** Start becomes available while a run is queued, a canceled run turns green after reload, or an uncertain request is resent as a new command.

**Good UX:** Lock conflicting actions throughout loading, queued, running, and unresolved states. Use both UI state and an in-flight guard against duplicate expensive/destructive submissions. Restore durable succeeded/failed/canceled outcomes after reload. Preserve command identity on uncertain retries; creation and location persistence must share an operation contract that cannot silently adopt an existing folder.

**Protect it:** Check double clicks, status loading, queueing, cancellation, reload, uncertain retries, and partial failures. Existing creation coverage: `workspace-creation-location.integration.test.ts`.

## 9. Present decisions in human terms with honest scope

**Lesson:** Users need consequences and context to make decisions; raw records and guessed details create false confidence.

**Bad UI:** An approval leads with JSON and IDs, hides persistent policy effects, or treats missing change counts as zero.

**Good UI:** Lead with readable names, requested operation, reviewer, scope, delivery status, and persistent/provider-wide effects; put technical payloads under details. Mark unavailable context as unknown. Correlate native change context only with exact recorded session/turn/item identity, using bounded redacted structure rather than patch contents or guessed targets. Separate monitoring from response permission, and Pending from Delivery problems and History. Use authoritative queue counts and show pending attention near its workflow.

**Protect it:** Check missing context, response permissions, persistent choices, delivery failures, and counts beyond the first history page.

## 10. Design loading, failure, and recovery as part of the task

**Lesson:** Blank or misleadingly usable surfaces leave users to discover missing prerequisites and invent recovery steps.

**Bad UX:** An unusable board sits beneath a warning, a refresh failure erases useful data, or every background poll produces a toast.

**Good UX:** Deliberately distinguish initial loading, empty success, stale usable data with refresh failure, hard error, pending retry, and acknowledged success. Gate a task on its selected workspace's actual prerequisites and offer setup/retry; another workspace's cached status cannot unlock it. Keep usable stale content and explain what remains available. Show structured save errors without dropping edits. Toasts acknowledge requested operations; inline status can describe the accepted current revision without competing with controls or hiding newer drafts.

Diagnostics state exactly what was checked. Installation, qualification, authentication, policy, and execution readiness are distinct; a schema pass cannot imply all of them. Keep the last diagnostic report on refresh failure and allow independent status visibility without overwriting settings drafts.

**Protect it:** Check each applicable state and workspace switching. Existing anchors: `WorkspaceExecutionLocationSetup.test.tsx` and `HarnessCompatibilityPanel.test.tsx`.

## 11. Adapt the interaction to the viewport

**Lesson:** Narrow screens need usable task flows, not merely compressed desktop geometry.

**Bad UI:** Two panes squeeze each other, primary actions overflow, or a tall popover leaves its confirmation unreachable.

**Good UI:** Collapse navigation when needed, turn selection/detail panes into a deliberate one-column flow, wrap or widen actions, and bound scrolling panels to the viewport. Move focus into opened detail and return it to the originating item on close.

**Protect it:** Check narrow-screen collision, scrolling, action reachability, and focus transitions rather than CSS snapshots alone.

## 12. Make keyboard, focus, and status behavior coherent

**Lesson:** A visible control is not usable if users cannot reach, operate, or understand it without a pointer or color cues.

**Bad UX:** Focus disappears on dialog close, hidden panels remain tabbable, or drag is the only way to reorder.

**Good UX:** Focus the useful starting control on open and return focus to the surviving trigger on close. Make hidden content inert, keep `aria-controls` targets stable, offer keyboard reordering, and label controls visibly. Pair status color with text/icon/shape and respect reduced motion; animation must not gate understanding.

**Protect it:** Check keyboard-only completion, focus return, hidden content, stable relationships, and status readability without color or motion.

## 13. Share interaction behavior and assign visual ownership

**Lesson:** Visual consistency alone does not prevent inconsistent interactions; composing full pages can also duplicate their visual hierarchy.

**Bad UI:** Matching dialogs dismiss differently, or an embedded feature brings a second heading, padding layer, and page container into Settings.

**Good UI:** Shared primitives carry focus, keyboard, disabled/loading, validation, dismissal, status, and responsive behavior. Repair repeated behavior there while keeping business rules in features. Let the parent own page chrome through an embedded presentation or composition boundary. Preserve the established card treatment when showing workflow objects in another context; concise copy should not turn selectable objects into an undifferentiated text list. Place diagnostics in the settings section that owns them, with concise status and repair detail on demand.

**Protect it:** Check shared behavior across consumers and embedded versus standalone hierarchy, including the route placement of diagnostics.

## 14. Preserve the whole layout contract

**Lesson:** A full-height editor depends on its ancestors, not just its own dimensions.

**Bad UI:** Adding a prerequisite wrapper collapses the graph, and arbitrary canvas heights hide the cause.

**Good UI:** Keep the flex column/grow/shrink contract intact between shell and editor, including `min-width: 0` and `min-height: 0` where overflow must shrink inside the viewport. Inspect the ancestor chain when wrappers introduce collapse or overflow.

**Protect it:** Check editor height and internal scrolling with prerequisite/loading wrappers and narrow viewports; assert meaningful layout constraints rather than incidental class lists.

## 15. Keep hidden configuration compatible and honest

**Lesson:** Hidden values and invented fallbacks can make the saved result contradict the visible choices.

**Bad UX:** Switching sandbox mode retains incompatible permissions, or failed provider discovery silently supplies built-in options as though they came from the provider.

**Good UX:** Deliberately clear or normalize incompatible dependent fields when the controlling choice changes, explaining consequential effects nearby. Distinguish cached editable drafts from serialized active configuration. When authoritative options are unavailable, explain the failure and require an explicit fallback choice.

**Protect it:** Check controlling-choice changes, switching back, serialized values, discovery failure, and explicit fallback selection.

## 16. Label demonstrations by their real effect

**Lesson:** Polish can make simulated actions look authoritative.

**Bad UX:** A preview Save or sample run implies that it changed production settings or operated real agents.

**Good UX:** Clearly label preview environments, data, actions, and results so replay, demo notifications, and simulated saves cannot be mistaken for persisted work.

**Protect it:** Check the environment label and action feedback together, including success states.

## 17. Test the user promise behind the fix

**Lesson:** Markup can remain stable while behavior breaks, or change harmlessly while a brittle test fails.

**Bad verification:** A snapshot passes even though edits disappear, two workspaces look active, or keyboard focus is stranded.

**Good verification:** Assert the reason the change matters using roles, accessible names, route state, focus, persisted/draft values, and necessary layout contracts. For critical product capabilities, also protect Operator MCP parity with authenticated allowed/denied calls and persisted readback; UI coverage alone cannot establish that contract.

**Protect it:** A regression check should fail when the harmful behavior returns and make the resulting user problem clear.

## How to maintain these lessons

Update this file only when a change teaches a reusable principle or adds meaningful evidence to one. Do not submit every action, screen edit, implementation detail, or commit as a new lesson.

Use the existing structure: **Lesson** (cause and durable rule), **Bad UX/UI** (concrete failure), **Good UX/UI** (better behavior and why), and **Protect it** (observable regression criterion, with a focused evidence pointer when useful). These examples are contrasts, not a chronological before/after report.

Merge by underlying cause. Add a section only when it changes future design or verification decisions. Keep important distinctions between server truth, drafts, URL state, and local interaction. Cover relevant clean/dirty, loading, empty, error, conflict, pending, success, narrow-screen, keyboard, and focus states without copying the entire checklist into every lesson.

Keep evidence subordinate to the principle: a relevant test or observed behavior is useful; a growing list of commits and files is not. Do not claim a suggested check has passed without running it. Preserve evidence-based rules, reconcile contradictions when behavior changes, and omit cosmetic edits that teach nothing reusable.
