# Recorded Kalshi responses

Real API responses, used by adapter tests so that no test needs a socket.
Regenerate with `npm run sample:kalshi`.

Do not hand-edit these to make a test pass. If a fixture no longer matches the
live API, that is the finding — the adapter needs updating, not the fixture.

`candidates-page.json` — markets from a real `/markets` same-day close window,
sampled across filter outcomes rather than taken as a contiguous page. A
contiguous page is invariably 40 rungs of one untraded strike ladder, which
exercises a single code path. This one carries accepted markets, an untraded
ladder, multivariate combo markets, and markets under the volume floor.
