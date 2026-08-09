**Architect Review: Riskety Rekt**

**1. The Pure Engine Boundary is Incomplete (Missing Inputs)**
Your core engine signature—`resolve(state, orders, settlements)`—is structurally incapable of executing your game rules. 
- Step 2 (Grant IRL actions) and Step 6 (Protection parity) depend on knowing who posted approved workouts and at what exact time.
- Step 5 (Escrow new wagers) requires the 08:00 market slate to validate the wagers and capture the snapshot `price` into the `pending` state.
None of this data crosses the engine boundary. To keep the engine pure and deterministic, its API must be expanded to accept a `DailyContext` object containing the `Slate` and `ApprovedActions`. 

**2. The Persistence Boundary (Store) is Missing the External World**
The `Store` interface defines storage for `GameState` and `Order`. It provides no storage for the day's market `Slate` or the `ApprovedActions`. If the 08:00 scheduler publishes a slate that the Next.js app needs to render all day, and the Slack bot is continuously caching reactions, they must write to the `Store`. Without these interfaces, your adapters are orphaned, and your "golden-file replay" testing strategy is impossible, as you cannot replay a tick without persisting the prices and timestamps that occurred that day.

**3. Hidden Coupling / Contradiction in the Slack Adapter**
The `SlackAdapter` interface exposes a `getApprovedActions(day)` read method, yet your Failure Modes section explicitly states: "The bot writes reaction events to the DB continuously... At 21:00 the tick reads local state and never calls the Slack API." 
This is a boundary contradiction. The Slack integration should act as an ingress webhook that writes to the `Store`. At 21:00, the outer tick runner should read those actions from the `Store`, entirely bypassing the `SlackAdapter`.

**4. Timeline Phase Inversion (Fatal)**
You have divided the daily phases in the wrong place. You mandate that market candidates "must close before 21:00 ET", but orders are "freely editable until the tick locks them" at 21:00. This phase overlap allows players to wait until a market resolves in the real world (e.g., at 16:00), log into the web app at 20:00, and bet their entire reserve on a guaranteed, known outcome. The Order Lock phase must strictly precede the Market Close phase, or the slate must only contain markets that close after 21:00.

**Most Expensive Decision to Reverse:**
**Excluding the Daily Context (Slate and Actions) from the Immutable Input Model.**
If you proceed with the belief that the engine only needs `(state, orders, settlements)`, you will build your database schema, your web app, and your entire suite of synthetic tests around a domain model that is missing half of the game's reality. When you discover you cannot calculate wager payouts because you didn't pass the 08:00 snapshot prices into the engine, or that you cannot replay yesterday's tick because you didn't persist the workout timestamps, you will have to tear open the core engine signature, rewrite the `Store` schema, and refactor every single test.

VERDICT: REVISE
