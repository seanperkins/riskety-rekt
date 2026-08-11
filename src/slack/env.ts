export interface SlackEnv {
  signingSecret: string
  botToken: string
  teamId: string
  channelId: string
  webUrl: string
}

type Env = Record<string, string | undefined>

/** Substrings that mark a variable as carrying a secret. */
const SECRET_MARKERS = ["SECRET", "TOKEN", "KEY", "PASSWORD"]

function required(env: Env, name: string): string {
  const v = env[name]
  // "" and undefined are both absent. A systemd EnvironmentFile line with no
  // value yields "", and treating that as present is exactly how a service
  // boots with signature verification silently disabled.
  if (v === undefined || v === "") {
    throw new Error(`${name} is not set — refusing to start. See deploy/README.md.`)
  }
  return v
}

/**
 * Load and validate the Slack environment. Throws on anything missing.
 *
 * Called at module scope by the bot entrypoint on purpose: a missing signing
 * secret must kill the process, never degrade into an unverified handler.
 */
export function loadSlackEnv(env: Env = process.env): SlackEnv {
  for (const key of Object.keys(env).sort()) {
    if (!key.startsWith("NEXT_PUBLIC_")) continue
    if (SECRET_MARKERS.some((m) => key.includes(m))) {
      throw new Error(
        `${key} is exposed to the client bundle — Next.js inlines every ` +
          `NEXT_PUBLIC_ variable into browser JavaScript. Rename it.`,
      )
    }
  }

  return {
    signingSecret: required(env, "SLACK_SIGNING_SECRET"),
    botToken: required(env, "SLACK_BOT_TOKEN"),
    teamId: required(env, "SLACK_TEAM_ID"),
    channelId: required(env, "SLACK_CHANNEL_ID"),
    // The origin the /login link is built from. No trailing slash.
    webUrl: required(env, "RR_WEB_URL"),
  }
}
