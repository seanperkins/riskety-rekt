The plan is not implementation-ready. Several stated guarantees cannot be implemented from the interfaces and state model, and a few rules are internally contradictory.

1. Tick idempotency and races

The plan says “state is immutable” and that a bad tick can be rerun, but `Store` only exposes:

```ts
loadState(day)
saveState(state)
loadOrders(day)
saveOrder(day, order)
```

There is no persisted tick lock, transaction, unique constraint, or compare-and-swap. Two systemd invocations, a retry after timeout, or an operator rerun can both read day N−1 and write day N. This can duplicate payouts, IRL grants, and recap posts.

Orders are also “freely editable until the tick locks them,” but no lock operation exists. A request racing with the 21:00 tick can be included nondeterministically, or be written after the tick and appear in a later rerun.

Add an atomic per-day lock/claim, a database transaction, and an immutable input snapshot. Enforce the order cutoff in SQLite, not only in the web app.

2. Recovery is not actually deterministic

Rerunning from day N−1 requires the exact historical inputs, but the state does not persist:

- the day’s market slate and snapshotted prices;
- approval events and the cutoff-time view;
- settlement responses and their retrieval time;
- configuration such as the volume floor and payout rules;
- the engine version or ruleset identifier;
- random setup seed, if setup is regenerated.

`loadOrders(day)` alone is insufficient. A rerun could see changed market settlements, revised Slack approval data, changed configuration, or a different adapter response. Persist a complete `TickInput` record and make recovery consume that record exclusively.

3. Settlement handling is underspecified and can double-charge

The plan says step 1 should “Credit or debit reserves,” while wager stakes were already debited during step 5. A losing wager must not debit the stake a second time. The exact meaning of a winning “payout” is also unclear: does `floor(stake / p * 1.1)` include the original stake or represent profit?

The `pending` shape has only:

```ts
{factionId, marketId, side, stake, price, placedOnDay}
```

It has no settlement status, settlement day, refund deadline, outcome, or payout-applied marker. Therefore “roll forward” and “refund after 48 hours” cannot be implemented idempotently. The same pending wager can be paid repeatedly on retries.

Add wager IDs, unique market/faction constraints, status transitions, settlement timestamps, and an atomic payout/refund ledger.

4. The tick still depends on an outside system

The failure-mode section says the tick “never calls the Slack API,” but the pipeline explicitly requires “yesterday’s settlements,” and `MarketAdapter.getSettlements()` is a network-facing interface. If settlement data is unavailable at 21:00, the tick can block or fail unless settlements are cached continuously or queried with a strict timeout and a local fallback.

The plan needs a local settlement-event cache and a rule such as: “the tick only reads settlement records already persisted before lock time.” Otherwise the stated “must never be blocked by an outside system” guarantee is false.

5. Slack approval data cannot support the rules

`getApprovedActions()` returns only:

```ts
{playerId, approvedAt}
```

That cannot determine:

- whether there were one or two actions;
- whether two approvals came from distinct other players;
- whether a player reacted to their own post;
- whether duplicate reactions/events were counted;
- which Slack message/action was approved;
- whether a reaction was later removed;
- whether the approval happened before the cutoff;
- which action won Early Bird or Under the Wire.

The event cache must store message/action IDs, submitting player, approving user IDs, event timestamps, reaction add/remove state, channel, and deduplication IDs. Define whether Slack event time or ingestion time controls the cutoff. Two approvals with identical timestamps also need a deterministic tie-breaker, not just a timestamp.

6. Combat resolution is not implementable as written

The multi-attacker rule is ambiguous:

> “every attacker takes losses against the defender. The largest surviving force takes the territory.”

It does not define how defense is allocated. If each attack independently compares against the full defense, the defender is effectively duplicated. If attackers share defense, the allocation algorithm is missing. Ties for “largest surviving force” are also unspecified.

Other unresolved cases will produce divergent implementations:

- multiple outgoing attacks from one origin can collectively exceed `garrison(from) − 1`, even though each individual attack satisfies the constraint;
- an origin territory can be captured while it sends attacks;
- an attack can target a territory that another attack captures in the same tick;
- mutual attacks combined with third-party attacks are undefined;
- protection can remove one side of a mutual attack, changing the combat type;
- “an attack that wins with zero survivors” contradicts `Attack > defense`, which necessarily leaves at least one survivor for integer troop counts.

Define a single simultaneous-resolution algorithm over a snapshot of ownership/garrisons, including outgoing troop reservation, origin capture behavior, multi-attacker defense allocation, ties, and conservation accounting.

7. Wager and order validation has important edge cases

The plan says malformed orders are “silently discarded,” but does not say whether that means the entire order or only the malformed component. Runtime validation must also reject non-integers, negative counts, `NaN`, infinities, unknown IDs, duplicate deploy entries, duplicate attacks, duplicate markets, and wagers on unavailable/final-day markets.

Without aggregation, two valid-looking deploy entries can collectively exceed reserves. Multiple attacks from one territory can violate the origin garrison constraint in aggregate. Multiple wagers can stake more than the remaining reserve unless all components are normalized and validated together.

System errors must still propagate. “Invalid orders never throw” must not become “database or engine errors are swallowed and the tick is marked successful.”

8. Season-end and eliminated-faction accounting are incomplete

A faction eliminated during resolution may still have reserves or pending wagers. The plan says eliminated factions cannot deploy or attack, but does not specify whether they may place wagers, whether future winnings accumulate, or whether their reserves count toward the day-21 troop tiebreaker.

Similarly, “total troops” in the final tiebreaker is not defined: garrisons only, or garrisons plus reserves plus escrowed wagers? Pending wagers are currently outside `reserves`, so the result depends on accounting interpretation.

Specify elimination-time handling and freeze/settle all outstanding wagers before applying final rankings.

9. Daily scheduling needs explicit DST and duplicate-run behavior

“21:00 America/New_York” is a civil-time requirement, but systemd timer configuration is not shown. A UTC timer will drift across daylight-saving transitions; a timezone-aware timer may behave differently on DST transition days. Also define what happens if the 08:00 job or 21:00 tick is missed, delayed, or run twice.

10. Market publication is not durable enough

There is no store interface for the slate. `Market` has `priceYes`, while wagers contain `side` and `price`; the plan never defines how NO prices are derived or snapshotted. A partially fetched slate, duplicate publication, changed market metadata, or a second 08:00 run can produce inconsistent wager validation.

Persist one immutable daily slate with candidate IDs, both side prices, close times, publication status, and a deterministic selection order.

VERDICT: REVISE