/**
 * The suite is offline, and this is what enforces it rather than asserts it.
 *
 * "None of these tests touch the network" was true by construction and by
 * review — Bolt's App is built with deferInitialization, only post.ts imports
 * the Web API client, the adapters take an injected fetch — but every one of
 * those is a convention a future test can quietly break, and the failure looks
 * like a slow or flaky test rather than a rule violation.
 *
 * Replacing fetch turns that into an immediate, named failure. A test that
 * genuinely needs to reach the network does not belong in `npm test`; it
 * belongs behind a script, like `npm run sample:kalshi`.
 *
 * It throws SYNCHRONOUSLY, where real `fetch` returns a rejected promise. That
 * is deliberate — an unawaited call still fails the test rather than becoming an
 * unhandled rejection — but it means the failure surfaces at the call site, not
 * at the `await`.
 */
const blocked = ((input: unknown) => {
  const where =
    typeof input === "string" ? input : input instanceof URL ? input.href : "an unknown URL"
  throw new Error(
    `no test may make a network call (attempted fetch to ${where}). ` +
      `Inject a stub adapter, or move the check behind a script.`,
  )
}) as typeof fetch

globalThis.fetch = blocked
