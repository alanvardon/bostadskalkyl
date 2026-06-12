# Hemma / bostadskalkyl

A local-first family hub. `index.html` is **Hemma**, the homepage that links out to the household tools; more tools will land there over time.

The first tool is **Bostadskalkyl** (`bostadskalkyl.html`): a web calculator for buying a house in Sweden. Models lagfart, pantbrev, amortisation, ränteavdrag, bank rate comparisons, and driftkostnad — with saved scenarios and payoff charts.

No build step — plain HTML/CSS/JS. Storage is localStorage behind the async `App.storage` facade (`storage.js`), ready to swap for Supabase later. Design tokens are duplicated between `styles.css` (calculator) and `home.css` (hub) by design.
