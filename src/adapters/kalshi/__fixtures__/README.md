# Recorded Kalshi responses

Real API responses, used by adapter tests so that no test needs a socket.
Regenerate with `npm run sample:kalshi`.

Do not hand-edit these to make a test pass. If a fixture no longer matches the
live API, that is the finding — the adapter needs updating, not the fixture.

Both files are sampled across filter outcomes rather than taken as a contiguous
page. A contiguous page is invariably 40 rungs of one untraded strike ladder,
which exercises a single code path.

`candidates-page.json` — a real **same-day** close window. Every market in it
has a lifetime of an hour or less, which is not an accident of sampling: run
late in the ET day, the only markets still closing before 21:00 are Kalshi's
15-minute crypto ladders. Since `MIN_MARKET_HOURS` it accepts nothing, and that
is the point — it is the fixture for the short-lived path.

`candidates-nextday.json` — a real **next-day** 09:00–21:00 window, which is
what the 08:00 publish job actually sees. This is the one that spans outcomes:
accepted markets, multivariate combos, markets under the volume floor, and
markets outside the price band. Recorded 2026-08-12 for the 2026-08-13 window.
