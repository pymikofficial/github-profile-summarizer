# GitHub Profile Summarizer

Paste a GitHub username, see what someone's actually shipped: language breakdown, active vs. stale repos, and flagged repos with real README excerpts.

**Live:** [github-profile-summarizer.netlify.app](https://github-profile-summarizer.netlify.app)

Part of the [cosmik.work](https://cosmik.work) Business OS suite. Pairs well with Hiring Screener: check a resume-to-role fit, then verify the candidate's GitHub backs it up.

## The machinery

Single-page frontend, two Netlify Functions, Netlify Blobs for job state and the daily usage counter. Same background-function + polling pattern as the rest of this suite.

1. Frontend generates a `jobId` and POSTs the username to `generate-profile-summary-background.js`.
2. The background function paginates `GET /users/{username}/repos` (capped at 20 pages), computes a language breakdown, an active/stale split (pushed in the last 180 days or not), and scores every non-fork repo to pick the top 3 to flag, all in plain JS from data GitHub already returned. Only the top 3 repos get a README fetch.
3. **The one sentence Claude writes is checked against those same facts before it ships**: `validateNarrative()` rejects the model's output if it contains any capitalized word or repo-name-shaped token that isn't one of the actual usernames, repo names, or language names computed in step 2. A rejected narrative gets one retry with a stricter prompt, then falls back to a plain template if it still doesn't pass. The model never gets to introduce a fact, it can only phrase facts that were already computed.

## Guardrails

- **Daily rate limit, global and per-IP**: this is the only endpoint in the suite that fans out into up to 20 paginated GitHub calls plus a Claude call per request, so it's capped the same way the others are.
- **Username format validated** against GitHub's actual username rules before it's used in any API call.
- **GitHub token never reaches the client**: all GitHub API calls happen server-side in the background function.

## Environment variables (all required)

| Variable | What it is |
|---|---|
| `ANTHROPIC_API_KEY` | Shared Anthropic API key (reused across cosmik.work tools) |
| `GITHUB_TOKEN` | GitHub personal access token, raises the API rate limit from 60/hr (unauthenticated) to 5,000/hr |
| `NETLIFY_SITE_ID` | This site's ID, from Project details |
| `NETLIFY_BLOBS_TOKEN` | Netlify Personal Access Token (shared) |
| `DAILY_CAP` | Optional, defaults to 30 |
| `DAILY_CAP_PER_IP` | Optional, defaults to 8 |

Note: `getStore()` must be called with explicit `siteID` and `token`. Relying on ambient environment configuration throws `"The environment has not been configured to use Netlify Blobs"` in this deployment setup.

## Run it locally

1. Clone this repo.
2. `npm install`
3. `netlify dev` (with the env vars above set)

Built by [Soumik Chatterjee](https://cosmik.work).
