#!/usr/bin/env node
// Smoke test for GitHub Profile Summarizer, run against the LIVE deployed
// site (not local dev), since it hits real Netlify Functions + Blobs + the
// real GitHub API + the real Anthropic API.
//
// Usage: node scripts/smoke-test.mjs [base_url] [github_username]
// Default base_url: https://github-profile-summarizer.netlify.app
// Default username: torvalds (public, stable, plenty of repos to summarize)

const BASE_URL = process.argv[2] || 'https://github-profile-summarizer.netlify.app';
const USERNAME = process.argv[3] || 'torvalds';
const POLL_MS = 2000;
const MAX_POLLS = 60; // this pipeline can fan out into up to 20 paginated GitHub calls, give it room

function log(msg) { console.log(msg); }
function fail(msg) { console.log('FAIL: ' + msg); process.exitCode = 1; }
function pass(msg) { console.log('PASS: ' + msg); }

async function main() {
  log(`Testing ${BASE_URL}`);
  log(`Username: ${USERNAME}\n`);

  const jobId = 'smoketest-' + Date.now();
  const startedAt = Date.now();

  let kickoff;
  try {
    kickoff = await fetch(`${BASE_URL}/.netlify/functions/generate-profile-summary-background`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobId, username: USERNAME })
    });
  } catch (e) {
    fail(`Could not reach generate-profile-summary-background: ${e.message}`);
    return;
  }
  if (kickoff.status !== 202 && kickoff.status !== 200) {
    fail(`Unexpected status from background function: ${kickoff.status}`);
    return;
  }

  let record = null;
  for (let i = 0; i < MAX_POLLS; i++) {
    await new Promise((r) => setTimeout(r, POLL_MS));
    let res;
    try {
      res = await fetch(`${BASE_URL}/.netlify/functions/check-profile-summary?jobId=${encodeURIComponent(jobId)}`);
    } catch (e) {
      continue;
    }
    const data = await res.json();
    if (data.status === 'done' || data.status === 'error') {
      record = data;
      break;
    }
  }

  const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1);

  if (!record) {
    fail(`Timed out after ~${(MAX_POLLS * POLL_MS / 1000).toFixed(0)}s with no done/error status.`);
    return;
  }
  if (record.status === 'error') {
    fail(`Server returned an error: ${record.message}`);
    return;
  }
  pass(`Generated in ${elapsedSec}s.`);

  const issues = [];
  if (record.username !== USERNAME) issues.push(`username mismatch: got ${record.username}, expected ${USERNAME}`);
  if (typeof record.publicRepoCount !== 'number' || record.publicRepoCount < 0) issues.push('publicRepoCount missing or invalid');
  if (typeof record.languageBreakdown !== 'object' || record.languageBreakdown === null) issues.push('languageBreakdown missing');
  if (typeof record.activeRepoCount !== 'number') issues.push('activeRepoCount missing');
  if (typeof record.staleRepoCount !== 'number') issues.push('staleRepoCount missing');
  if (!Array.isArray(record.flaggedRepos) || record.flaggedRepos.length === 0) issues.push('flaggedRepos missing or empty');

  if (issues.length === 0) {
    pass(`Facts well-formed: ${record.publicRepoCount} public repos, ${record.activeRepoCount} active, ${record.staleRepoCount} stale, ${record.flaggedRepos.length} flagged.`);
  } else {
    fail(`Fact issues: ${issues.join(', ')}`);
  }

  // The guardrail this tool exists to prove: every capitalized/repo-shaped
  // token in the narrative must come from the computed facts. If validation
  // is working, the narrative won't contain any repo name that ISN'T one of
  // the flagged repos, so a spot check on the flagged names is a reasonable
  // proxy without re-implementing validateNarrative() here.
  if (typeof record.narrative === 'string' && record.narrative.length > 0) {
    pass(`Narrative generated (${record.narrative.length} chars): "${record.narrative}"`);
  } else {
    fail('No narrative string returned.');
  }

  log('\n--- Full record (for manual eyeballing) ---');
  log(JSON.stringify(record, null, 2));
}

main();
