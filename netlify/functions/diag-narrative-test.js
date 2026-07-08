// Temporary diagnostic (foreground, synchronous): isolates the narrative
// generation + validation logic against real facts, to see the raw model
// output and which token (if any) trips the validator. Delete after use.

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

exports.handler = async () => {
  const narrativeFacts = {
    username: 'pymikofficial',
    publicRepoCount: 31,
    languageBreakdown: [{language:'HTML',count:9},{language:'JavaScript',count:7},{language:'Python',count:5},{language:'Jupyter Notebook',count:2},{language:'Java',count:1}],
    activeRepoCount: 13,
    staleRepoCount: 17,
    flaggedRepoNames: ['ai-resume-tool','physics-game-builder','data-science-capstone']
  };

  const prompt = `You write a single short recruiter-facing summary (1-2 sentences) of a developer's GitHub activity. You must ONLY reference facts present in the JSON below: the username, repo names, language names, and counts. Never introduce a repo name, language, or claim about skill or style that isn't directly supported by this JSON. Do not invent adjectives about code quality. Plain, factual, recruiter-readable tone.

Facts:
${JSON.stringify(narrativeFacts, null, 2)}

Respond with ONLY the 1-2 sentence summary text, no preamble, no quotes, no markdown.`;

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 300, messages: [{ role: 'user', content: prompt }] })
    });
    const data = await res.json();
    const text = data.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();

    const allowed = new Set(COMMON_WORDS);
    allowed.add(narrativeFacts.username.toLowerCase());
    for (const l of narrativeFacts.languageBreakdown) allowed.add(l.language.toLowerCase());
    for (const n of narrativeFacts.flaggedRepoNames) allowed.add(n.toLowerCase());

    const invalidRepoTokens = [];
    const repoLikeTokens = text.match(/\b[a-z0-9]+(?:-[a-z0-9]+)+\b/gi) || [];
    for (const token of repoLikeTokens) {
      if (!allowed.has(token.toLowerCase())) invalidRepoTokens.push(token);
    }

    const invalidCapTokens = [];
    const capitalizedTokens = text.match(/\b[A-Z][A-Za-z0-9+#.]*\b/g) || [];
    for (const token of capitalizedTokens) {
      const lower = token.toLowerCase();
      if (allowed.has(lower)) continue;
      if (COMMON_WORDS.has(lower)) continue;
      invalidCapTokens.push(token);
    }

    return {
      statusCode: 200,
      body: JSON.stringify({ rawText: text, repoLikeTokens, capitalizedTokens, invalidRepoTokens, invalidCapTokens })
    };
  } catch (err) {
    return { statusCode: 200, body: JSON.stringify({ error: String(err && err.stack || err) }) };
  }
};
