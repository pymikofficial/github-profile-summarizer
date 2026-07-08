// Temporary diagnostic (foreground, synchronous): isolates the GitHub API
// fetch call used by the background function. Delete after infra checks pass.
exports.handler = async () => {
  try {
    const res = await fetch('https://api.github.com/users/pymikofficial', {
      headers: {
        Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
        'User-Agent': 'github-profile-summarizer',
        Accept: 'application/vnd.github+json'
      }
    });
    const text = await res.text();
    return {
      statusCode: 200,
      body: JSON.stringify({ fetchOk: true, status: res.status, bodyPreview: text.slice(0, 200) })
    };
  } catch (err) {
    return {
      statusCode: 200,
      body: JSON.stringify({ fetchOk: false, error: String(err && err.stack || err) })
    };
  }
};
