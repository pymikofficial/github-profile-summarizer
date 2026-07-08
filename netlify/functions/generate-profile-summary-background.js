// GitHub Profile Summarizer ~ background function.
// Netlify auto-responds 202 for "-background" suffixed functions, so the slow
// work (GitHub API calls + one Claude call) happens after the client has
// already been released. The client polls check-profile-summary.js with the
// same jobId.
//
// Guardrail (mirrors Investor Update Drafter's pattern, applied to text
// instead of numbers): every fact shown to the user comes directly from
// GitHub's API response, computed in plain JS. Claude's only job is to phrase
// 1-2 sentences summarizing facts that are already computed, never to
// generate a new claim. The narrative is validated after generation: any
// capitalized word or repo-name-like token that isn't a computed fact (or a
// common English word) triggers one retry, then a template fallback.

const { getStore } = require('@netlify/blobs');

// Lesson learned (documented across cosmik.work projects):
// getStore MUST receive explicit siteID and token in this account's setup,
// or it throws "The environment has not been configured to use Netlify Blobs".
const BLOBS_CONFIG = {
  siteID: process.env.NETLIFY_SITE_ID,
  token: process.env.NETLIFY_BLOBS_TOKEN
};

const ACTIVE_WINDOW_DAYS = 180;
const README_EXCERPT_CHARS = 300;

const COMMON_WORDS = new Set([
  'a','an','the','and','or','but','with','without','for','from','into','of','on','in','at','to','by','is','are',
  'was','were','be','been','being','has','have','had','this','that','these','those','it','its','their','they',
  'primarily','mostly','largely','notably','mainly','recently','across','spanning','ranging','built','building',
  'builds','shipped','ships','shipping','public','repositories','repository','repos','repo','github','profile',
  'active','stale','projects','project','work','works','focuses','focus','focused','includes','including',
  'like','such','as','also','most','several','many','few','no','not','one','two','three','among','between',
  'ranges','range','strong','notable','recent','showcasing','showcases','shows','show','spans','primary',
  'i','you','he','she','we','who','what','which','when','where','why','how'
]);

exports.handler = async (event) => {
  const store = getStore({ name: 'github-profile-summarizer', ...BLOBS_CONFIG });
  let jobId = null;

  try {
    const body = JSON.parse(event.body || '{}');
    jobId = body.jobId;
    const usernameRaw = (body.username || '').trim();

    if (!jobId) {
      return; // nothing sensible to do; client will time out and show an error
    }

    await store.setJSON(jobId, { status: 'pending' });

    if (!usernameRaw) {
      await store.setJSON(jobId, { status: 'error', message: 'Missing username.' });
      return;
    }

    // --- 1. GET /users/{username} ---
    const userRes = await githubFetch(`https://api.github.com/users/${encodeURIComponent(usernameRaw)}`);
    if (userRes.status === 404) {
      await store.setJSON(jobId, { status: 'error', message: `GitHub user "${usernameRaw}" not found.` });
      return;
    }
    const rateLimitError = checkRateLimit(userRes);
    if (rateLimitError) {
      await store.setJSON(jobId, { status: 'error', message: rateLimitError });
      return;
    }
    if (!userRes.ok) {
      const errText = await userRes.text();
      await store.setJSON(jobId, { status: 'error', message: `GitHub API ${userRes.status}: ${errText.slice(0, 300)}` });
      return;
    }
    const user = await userRes.json();

    // Zero public repos is a real outcome, not an error.
    if (!user.public_repos) {
      await store.setJSON(jobId, {
        status: 'done',
        username: user.login,
        avatarUrl: user.avatar_url,
        publicRepoCount: 0,
        isEmpty: true,
        languageBreakdown: [],
        activeRepoCount: 0,
        staleRepoCount: 0,
        flaggedRepos: [],
        narrative: `${user.login} has no public repositories yet.`
      });
      return;
    }

    // --- 2. GET /users/{username}/repos, paginated ---
    const repos = [];
    let page = 1;
    while (true) {
      const reposRes = await githubFetch(
        `https://api.github.com/users/${encodeURIComponent(usernameRaw)}/repos?per_page=100&sort=pushed&page=${page}`
      );
      const reposRateLimitError = checkRateLimit(reposRes);
      if (reposRateLimitError) {
        await store.setJSON(jobId, { status: 'error', message: reposRateLimitError });
        return;
      }
      if (!reposRes.ok) {
        const errText = await reposRes.text();
        await store.setJSON(jobId, { status: 'error', message: `GitHub API ${reposRes.status}: ${errText.slice(0, 300)}` });
        return;
      }
      const pageRepos = await reposRes.json();
      repos.push(...pageRepos);
      if (pageRepos.length < 100) break;
      page++;
      if (page > 20) break; // safety cap, well beyond any realistic profile
    }

    const nonForkRepos = repos.filter((r) => !r.fork);
    const now = Date.now();
    const activeWindowMs = ACTIVE_WINDOW_DAYS * 24 * 60 * 60 * 1000;
    const isActive = (repo) => repo.pushed_at && (now - new Date(repo.pushed_at).getTime()) < activeWindowMs;

    // --- language breakdown, computed in plain JS from the language field
    //     already present on each repo object (no per-repo /languages calls) ---
    const languageCounts = new Map();
    for (const repo of nonForkRepos) {
      if (!repo.language) continue;
      languageCounts.set(repo.language, (languageCounts.get(repo.language) || 0) + 1);
    }
    const languageBreakdown = [...languageCounts.entries()]
      .map(([language, count]) => ({ language, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 8);

    const activeRepoCount = nonForkRepos.filter(isActive).length;
    const staleRepoCount = nonForkRepos.length - activeRepoCount;

    // --- 3. score every non-fork repo, take top 3 ---
    const scored = nonForkRepos
      .map((repo) => ({
        repo,
        score:
          (repo.stargazers_count || 0) * 3 +
          (repo.description ? 2 : 0) +
          (repo.size > 50 ? 1 : 0) +
          (isActive(repo) ? 2 : 0)
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 3);

    // --- 4. README excerpt for only the top repos ---
    const flaggedRepos = [];
    for (const { repo } of scored) {
      let readmeExcerpt = null;
      try {
        const readmeRes = await githubFetch(`https://api.github.com/repos/${repo.full_name}/readme`);
        if (readmeRes.ok) {
          const readmeData = await readmeRes.json();
          const decoded = Buffer.from(readmeData.content || '', 'base64').toString('utf8');
          readmeExcerpt = stripMarkdown(decoded).slice(0, README_EXCERPT_CHARS).trim();
        }
      } catch (e) {
        readmeExcerpt = null; // a missing/unreadable README isn't fatal to the whole job
      }
      flaggedRepos.push({
        name: repo.name,
        url: repo.html_url,
        stars: repo.stargazers_count || 0,
        lastPushed: repo.pushed_at ? repo.pushed_at.slice(0, 10) : null,
        readmeExcerpt
      });
    }

    const facts = {
      username: user.login,
      avatarUrl: user.avatar_url,
      publicRepoCount: user.public_repos,
      languageBreakdown,
      activeRepoCount,
      staleRepoCount,
      flaggedRepos
    };

    // --- narrative: one Claude call, validated, one retry, then template fallback ---
    const narrative = await generateValidatedNarrative(facts);

    await store.setJSON(jobId, { status: 'done', ...facts, narrative });
  } catch (err) {
    console.error('generate-profile-summary error:', err);
    if (jobId) {
      try {
        await store.setJSON(jobId, { status: 'error', message: 'Profile summary failed. Try again in a minute.' });
      } catch (e) {}
    }
  }
};

// ---------------------------------------------------------------------------

async function githubFetch(url) {
  return fetch(url, {
    headers: {
      Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      'User-Agent': 'github-profile-summarizer',
      Accept: 'application/vnd.github+json'
    }
  });
}

function checkRateLimit(res) {
  if (res.status !== 403) return null;
  if (res.headers.get('x-ratelimit-remaining') !== '0') return null;
  const resetHeader = res.headers.get('x-ratelimit-reset');
  const resetTime = resetHeader ? new Date(Number(resetHeader) * 1000).toISOString() : 'unknown';
  return `GitHub API rate limit exceeded. Resets at ${resetTime}. Try again after that time.`;
}

function stripMarkdown(text) {
  return text
    .split('\n')
    .map((line) => line.replace(/^\s*#{1,6}\s*/, '').replace(/^\s*[-*+>]\s*/, ''))
    .join(' ')
    .replace(/`{1,3}/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

// ---------------------------------------------------------------------------

async function generateValidatedNarrative(facts) {
  const templateFallback = buildTemplateFallback(facts);

  try {
    const first = await callClaude(buildNarrativePrompt(facts, false));
    if (validateNarrative(first, facts)) return first;

    const retry = await callClaude(buildNarrativePrompt(facts, true));
    if (validateNarrative(retry, facts)) return retry;

    return templateFallback;
  } catch (e) {
    return templateFallback;
  }
}

function buildTemplateFallback(facts) {
  const topLanguage = facts.languageBreakdown[0] ? facts.languageBreakdown[0].language : null;
  return topLanguage
    ? `${facts.username} has shipped ${facts.publicRepoCount} public repositories, primarily in ${topLanguage}.`
    : `${facts.username} has shipped ${facts.publicRepoCount} public repositories.`;
}

function buildNarrativePrompt(facts, strict) {
  const strictNote = strict
    ? '\n\nSTRICT MODE: your previous attempt referenced something not present in the facts below. This time, use ONLY the exact username, repo names, and language names given below, nothing else capitalized or repo-name-shaped may appear in your output.'
    : '';

  // Deliberately exclude readmeExcerpt/url here: those are free text pulled
  // from repos and full of capitalized words/tokens that aren't safe for the
  // model to echo. The narrative may only draw from these bare facts.
  const narrativeFacts = {
    username: facts.username,
    publicRepoCount: facts.publicRepoCount,
    languageBreakdown: facts.languageBreakdown,
    activeRepoCount: facts.activeRepoCount,
    staleRepoCount: facts.staleRepoCount,
    flaggedRepoNames: facts.flaggedRepos.map((r) => r.name)
  };

  return [
    {
      role: 'user',
      content: `You write a single short recruiter-facing summary (1-2 sentences) of a developer's GitHub activity. You must ONLY reference facts present in the JSON below: the username, repo names, language names, and counts. Never introduce a repo name, language, or claim about skill or style that isn't directly supported by this JSON. Do not invent adjectives about code quality. Plain, factual, recruiter-readable tone.${strictNote}

Facts:
${JSON.stringify(narrativeFacts, null, 2)}

Respond with ONLY the 1-2 sentence summary text, no preamble, no quotes, no markdown.`
    }
  ];
}

function validateNarrative(text, facts) {
  if (!text || !text.trim()) return false;

  const allowed = new Set(COMMON_WORDS);
  allowed.add(facts.username.toLowerCase());
  for (const l of facts.languageBreakdown) {
    allowed.add(l.language.toLowerCase());
    for (const word of l.language.toLowerCase().split(/\s+/)) allowed.add(word);
  }
  for (const r of facts.flaggedRepos) {
    allowed.add(r.name.toLowerCase());
    for (const word of r.name.toLowerCase().split('-')) allowed.add(word);
  }

  // repo-name-shaped tokens (lowercase alnum joined by hyphens, GitHub's naming convention)
  const repoLikeTokens = text.match(/\b[a-z0-9]+(?:-[a-z0-9]+)+\b/gi) || [];
  for (const token of repoLikeTokens) {
    if (!allowed.has(token.toLowerCase())) return false;
  }

  // capitalized-word tokens (proper nouns, language names, or the start of a sentence)
  const capitalizedTokens = text.match(/\b[A-Z][A-Za-z0-9+#.]*\b/g) || [];
  for (const token of capitalizedTokens) {
    const lower = token.toLowerCase();
    if (allowed.has(lower)) continue;
    if (COMMON_WORDS.has(lower)) continue;
    return false;
  }

  return true;
}

async function callClaude(messages) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 300,
      messages
    })
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error('Anthropic API ' + res.status + ': ' + errText.slice(0, 300));
  }

  const data = await res.json();
  return data.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();
}
