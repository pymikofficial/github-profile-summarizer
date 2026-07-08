// Temporary diagnostic (foreground, synchronous): isolates whether requiring
// @netlify/blobs succeeds in the deployed bundle. Delete after infra checks pass.
exports.handler = async () => {
  try {
    const { getStore } = require('@netlify/blobs');
    const store = getStore({
      name: 'github-profile-summarizer',
      siteID: process.env.NETLIFY_SITE_ID,
      token: process.env.NETLIFY_BLOBS_TOKEN
    });
    await store.setJSON('diag-check', { ok: true, at: new Date().toISOString() });
    const readBack = await store.get('diag-check', { type: 'json' });
    return {
      statusCode: 200,
      body: JSON.stringify({
        requireOk: true,
        hasSiteId: !!process.env.NETLIFY_SITE_ID,
        hasBlobsToken: !!process.env.NETLIFY_BLOBS_TOKEN,
        hasAnthropicKey: !!process.env.ANTHROPIC_API_KEY,
        hasGithubToken: !!process.env.GITHUB_TOKEN,
        blobsWriteReadOk: readBack && readBack.ok === true
      })
    };
  } catch (err) {
    return {
      statusCode: 200,
      body: JSON.stringify({ requireOk: false, error: String(err && err.stack || err) })
    };
  }
};
