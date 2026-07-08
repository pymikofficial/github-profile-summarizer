// SCAFFOLD (infra-check phase): minimal version used only to validate the
// deploy pipeline, Blobs writes, and the GitHub API token before building out
// the full scoring/narrative pipeline. Netlify auto-responds 202 for
// "-background" suffixed functions, so this runs after the client is
// released; the client polls check-profile-summary.js with the same jobId.

const { getStore } = require('@netlify/blobs');

const BLOBS_CONFIG = {
  siteID: process.env.NETLIFY_SITE_ID,
  token: process.env.NETLIFY_BLOBS_TOKEN
};

exports.handler = async (event) => {
  const store = getStore({ name: 'github-profile-summarizer', ...BLOBS_CONFIG });
  let jobId = null;

  try {
    const body = JSON.parse(event.body || '{}');
    jobId = body.jobId;
    const username = body.username;
    if (!jobId) return;

    await store.setJSON(jobId, { status: 'pending' });

    if (!username) {
      await store.setJSON(jobId, { status: 'error', message: 'Missing username.' });
      return;
    }

    const res = await fetch(`https://api.github.com/users/${encodeURIComponent(username)}`, {
      headers: {
        Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
        'User-Agent': 'github-profile-summarizer',
        Accept: 'application/vnd.github+json'
      }
    });

    if (res.status === 404) {
      await store.setJSON(jobId, { status: 'error', message: `GitHub user "${username}" not found.` });
      return;
    }
    if (!res.ok) {
      const errText = await res.text();
      await store.setJSON(jobId, { status: 'error', message: `GitHub API ${res.status}: ${errText.slice(0, 300)}` });
      return;
    }

    const user = await res.json();
    await store.setJSON(jobId, {
      status: 'done',
      username: user.login,
      avatarUrl: user.avatar_url,
      publicRepoCount: user.public_repos
    });
  } catch (err) {
    console.error('generate-profile-summary error:', err);
    if (jobId) {
      try {
        await store.setJSON(jobId, { status: 'error', message: 'Profile summary failed. Try again in a minute.' });
      } catch (e) {}
    }
  }
};
