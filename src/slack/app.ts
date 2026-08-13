import { App } from "@slack/bolt"
import type { App as AppType } from "@slack/bolt"
import type {
  ApprovalStore,
  AuthStore,
  RosterStore,
  RuleVoteStore,
  SeasonStore,
} from "../store/types.js"
import type { SlackEnv } from "./env.js"
import { handleMessageEvent, handleReactionEvent, type IngestDeps } from "./handlers.js"
import { handleLoginCommand } from "./login.js"
import { handleNameCommand } from "./name.js"
import type { Directory } from "./post.js"

export interface SlackAppDeps {
  env: SlackEnv
  store: ApprovalStore & RosterStore & AuthStore & RuleVoteStore & SeasonStore
  /** Whether the board has been dealt, which is what gates self-service joining. */
  seasonId: string
  /**
   * Reads channel membership for `/login`'s join branch.
   *
   * Injected by the entrypoint rather than built here: `createDirectory` lives
   * in `post.ts`, the one file allowed to import the Web API client, and
   * constructing it here would pull that client into the import graph of every
   * test that builds an app. The type import below is erased at compile time.
   */
  directory: Directory
  log: (msg: string) => void
}

/**
 * The Events webhook. Validates scope, writes rows, and does nothing else.
 *
 * Bolt verifies X-Slack-Signature and rejects a request whose
 * X-Slack-Request-Timestamp is more than five minutes old
 * (requestTimestampMaxDeltaMin in receivers/verify-request.js). Both are on by
 * default; `signatureVerification` must never be set to false here.
 */
export function createSlackApp(deps: SlackAppDeps): AppType {
  if (deps.env.signingSecret === "") {
    throw new Error("createSlackApp: refusing to start without a signing secret")
  }

  const app = new App({
    signingSecret: deps.env.signingSecret,
    token: deps.env.botToken,
    // The constructor would otherwise call auth.test, which makes every test
    // that builds an app a network test. The entrypoint calls init() itself.
    deferInitialization: true,
    // Handlers are synchronous SQLite writes measured in microseconds, so the
    // work is done well inside Slack's 3-second ack window either way. Doing it
    // before the response means a write that throws is visible as a 500 in the
    // Slack app's event log rather than only in ours.
    processBeforeResponse: true,
  })

  const ingest: IngestDeps = {
    store: deps.store,
    scope: { teamId: deps.env.teamId, channelId: deps.env.channelId },
    log: deps.log,
  }

  // The `as never` casts are load-bearing but ugly: Bolt's
  // SlackEventMiddlewareArgs<"message"> is a seventeen-member union, while the
  // handlers accept a narrow structural shape whose every field is optional and
  // validated before use. Do not widen the handler signatures to Bolt's types —
  // that would put @slack/bolt in the import graph of every test in this plan.
  // A slash command, not an event. Bolt verifies the same signature and hands
  // over a trusted user_id; the handler is pure and returns the reply text.
  app.command("/login", async ({ command, ack, respond }) => {
    await ack()
    const text = await handleLoginCommand(
      { userId: command.user_id, teamId: command.team_id },
      {
        store: deps.store,
        seasonId: deps.seasonId,
        webUrl: deps.env.webUrl,
        now: new Date(),
        directory: deps.directory,
        channelId: deps.env.channelId,
        log: deps.log,
      },
    )
    // Ephemeral: only the invoker ever sees it, even when /login is run in a
    // public channel.
    await respond({ text, response_type: "ephemeral" })
  })

  // Renaming has no season gate, unlike joining: every display site resolves
  // the name from the roster at render time, so a change lands immediately.
  app.command("/name", async ({ command, ack, respond }) => {
    await ack()
    const text = handleNameCommand(
      { userId: command.user_id, text: command.text ?? "" },
      { store: deps.store, log: deps.log },
    )
    await respond({ text, response_type: "ephemeral" })
  })

  app.event("message", async ({ body, event }) => {
    handleMessageEvent(
      { eventId: body.event_id, teamId: body.team_id, event: event as never },
      ingest,
    )
  })

  for (const name of ["reaction_added", "reaction_removed"] as const) {
    app.event(name, async ({ body, event }) => {
      handleReactionEvent(
        { eventId: body.event_id, teamId: body.team_id, event: event as never },
        ingest,
      )
    })
  }

  // Never let an exception's text reach Slack. Log it locally and let Bolt
  // return its generic 500.
  app.error(async (error) => {
    deps.log(`slack handler error: ${error.stack ?? String(error)}`)
  })

  return app
}
