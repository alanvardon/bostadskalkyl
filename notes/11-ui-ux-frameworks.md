# UI/UX frameworks to consider

**Verdict:** The Supabase decision in [[09-remote-sharing-with-partner]]
makes a reactive framework worth seriously considering for the first
time. Recommended pick: **Svelte** (or Solid). React is the wrong shape
for this app.

## Why the calculus changed

Before Supabase, the app was an imperative `calc()` over local
inputs — re-run on every change, write to localStorage, done.
Frameworks were overkill.

With Supabase realtime subscriptions, inputs can change from outside
the local DOM:
- Partner edits a scenario on their device → our browser receives a
  subscription event → our inputs and derived values need to update
- Optimistic local writes need to reconcile with server state when the
  subscription echoes back
- Auth state changes (sign-in, sign-out, household switch) need to
  re-render large sections of the UI

Doing this on top of imperative `calc()` means manually re-applying
remote diffs to DOM inputs and re-running the whole calculation tree.
A reactive component model handles this natively — that's the entire
job description of Svelte/Solid.

## Why not React

- Needs a build step + JSX (kills the single-file property without
  buying much over Svelte)
- Heavier runtime than this app warrants
- Virtual DOM is overkill — there's no list rendering of thousands of
  rows, no deep tree diffing to optimise
- Ecosystem complexity (state libraries, effect rules, hooks
  discipline) is a tax that doesn't pay off at this scale

## Why Svelte (or Solid)

- **Svelte** — compiles to vanilla JS, tiny runtime, components feel
  close to HTML. The "open and it works" spirit is mostly preserved
  after a build step. Strong fit for this app's shape (a few sections,
  several modals, a summary panel).
- **Solid** — fine-grained reactivity without a virtual DOM. Closer to
  the imperative mental model of the current code; signals map well to
  Supabase subscriptions. Slightly less mature ecosystem than Svelte.

Either works. Svelte is the safer default; Solid is the better fit if
fine-grained reactivity on individual inputs matters.

## What "improve UI/UX" might still mean

Pin this down independently from the framework question:

1. **Visual polish** — spacing, hierarchy, focus states, mobile layout
2. **Component consistency** — every modal, every sum-card, every input
   group looks/behaves identically
3. **Interaction quality** — micro-animations, keyboard shortcuts,
   undo/redo on input changes
4. **Information density** — make the summary panel scannable at a
   glance; collapse rarely-used sections

A framework helps most with (2) and (3). (1) and (4) are CSS/design
work that lands the same with or without a framework.

## Where the current design actually hurts

- Modals: five of them, each with a slightly different open/close
  function. A component model collapses this to one `<Modal>`.
- `sum-card` is reused well — design tokens already exist in `:root`.
  Less pain than expected.
- Mobile: the two-column layout assumes desktop. Worth fixing
  regardless of framework choice.
- Inputs: currency vs number inputs have different focus/blur
  behaviour. A shared `<CurrencyInput>` / `<NumberInput>` component
  would unify this.

## Sequencing with the Supabase work

The framework decision and the Supabase decision are linked but can be
sequenced:

1. **Land the async DAL first** (step 2 in [[09-remote-sharing-with-partner]]).
   This works with the current imperative code.
2. **Then refactor to Svelte/Solid** as part of Tier 3 in
   [[10-refactor-out-of-single-html]]. The DAL becomes the data layer
   the components subscribe to.
3. Don't try to do both in one shot — too much surface area moving at
   once.

## Tradeoffs / risks

- **Build step is non-negotiable.** Svelte/Solid both compile.
  `index.html` becomes a build output, not a hand-edited file.
  Deployment becomes "build then upload `dist/`" instead of "upload one
  file."
- **CLAUDE.md needs a substantial rewrite.** "Single-file HTML
  application" stops being true. Agents that reason about "the inline
  `<script>` block" need new mental models.
- **Multi-week project.** Converting `calc()` from imperative to
  reactive touches every input and every derived value. Plan it as a
  branch that lands once, not a gradual migration.
- **Reactivity bugs are different from imperative bugs.** Stale
  closures, missed dependencies, infinite update loops. Budget for a
  learning curve even if the framework is small.

## Tailwind / styling layer (independent question)

Whether to adopt Tailwind or stay handwritten is orthogonal to the
framework question. Either works with Svelte/Solid. Decide based on
how much spacing/utility churn the current CSS has — currently not
much, since design tokens are already in `:root`.

## Rough plan

1. Finish the async DAL work from [[09-remote-sharing-with-partner]]
2. Stand up a scratch Svelte (or Solid) project; port one section
   (e.g. Section 3 monthly costs) end-to-end as a proof of concept
3. Decide framework based on that experience, not on planning docs
4. Plan the full migration as a dedicated branch with a clear cutover

## Related

- [[09-remote-sharing-with-partner]] — Supabase + realtime is the
  reason this question changed
- [[10-refactor-out-of-single-html]] — framework adoption is the Tier
  3 refactor described there
