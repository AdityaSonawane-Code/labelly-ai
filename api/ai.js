const hits = new Map();
let cache;
const score = n => parseFloat(n.match(/gemini-([\d.]+)/)[1]) * 10 + (n.endsWith('-lite') ? 0 : 5);

async function pickModels(key) {
  if (cache && Date.now() - cache.t < 3600e3) return cache.m;
  let m = [];
  try {
    const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=200', {
      headers: { 'x-goog-api-key': key }, signal: AbortSignal.timeout(6000),
    });
    const d = await r.json();
    m = (d.models || [])
      .filter(x => (x.supportedGenerationMethods || []).includes('generateContent'))
      .map(x => x.name.replace('models/', ''))
      .filter(n => /^gemini-[\d.]+-flash(-lite)?$/.test(n))
      .sort((a, b) => score(b) - score(a))
      .slice(0, 5);
  } catch (e) {}
  if (!m.length) m = ['gemini-3.5-flash', 'gemini-3.5-flash-lite'];
  m = [...new Set([...m, 'gemini-flash-latest', 'gemini-flash-lite-latest'])];
  cache = { t: Date.now(), m };
  return m;
}

async function callModel(key, model, parts, json, think) {
  const generationConfig = { maxOutputTokens: 8000, temperature: 0.2 };
  if (json) generationConfig.responseMimeType = 'application/json';
  if (think) generationConfig.thinkingConfig = model.includes('2.5') ? { thinkingBudget: 0 } : { thinkingLevel: 'minimal' };
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify({ contents: [{ role: 'user', parts }], generationConfig }),
    signal: AbortSignal.timeout(20000),
  });
  return { r, d: await r.json().catch(() => ({})) };
}

module.exports = async (req, res) => {
  const key = process.env.GEMINI_API_KEY;
  if (req.method === 'GET') return res.status(200).json({ ok: true, hasKey: !!key, models: key ? await pickModels(key) : [] });
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  if (!key) return res.status(500).json({ error: 'Server is missing GEMINI_API_KEY' });

  const ip = (req.headers['x-forwarded-for'] || 'x').split(',')[0].trim();
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter(t => now - t < 60000);
  if (recent.length >= 10) return res.status(429).json({ error: 'Too many requests. Wait a minute.' });
  recent.push(now); hits.set(ip, recent);

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  const { prompt, images = [], json } = body || {};
  if (typeof prompt !== 'string' || !prompt || prompt.length > 20000) return res.status(400).json({ error: 'Bad prompt' });
  if (!Array.isArray(images) || images.length > 6 || images.some(i => typeof i !== 'string')) return res.status(400).json({ error: 'Up to 6 images allowed' });

  const parts = [...images.map(data => ({ inline_data: { mime_type: 'image/jpeg', data } })), { text: prompt }];
  const models = [process.env.GEMINI_MODEL, ...(await pickModels(key))].filter(Boolean);
  const started = Date.now();
  const errs = [];
  for (let round = 0; round < 2; round++) {
    for (const model of models) {
      if (Date.now() - started > 48000) break;
      try {
        let { r, d } = await callModel(key, model, parts, json, true);
        if (r.status === 400) ({ r, d } = await callModel(key, model, parts, json, false));
        if (r.status === 429 && !(d.error && /demand|overload/i.test(d.error.message || ''))) { errs.push(`${model}: rate limit`); continue; }
        if (!r.ok) { errs.push(`${model}: ${((d.error && d.error.message) || r.status).toString().slice(0, 80)}`); continue; }
        const text = ((d.candidates || [])[0]?.content?.parts || []).map(p => p.text || '').join('\n');
        if (!text) { errs.push(`${model}: empty response`); continue; }
        return res.status(200).json({ text, model });
      } catch (e) { errs.push(`${model}: ${e.name === 'TimeoutError' ? 'timed out' : e.message}`); }
    }
    if (Date.now() - started > 40000) break;
    await new Promise(r => setTimeout(r, 1500));
  }
  const lastErr = errs.length ? errs.slice(-3).join(' | ') : 'AI provider error';
  return res.status(502).json({ error: lastErr });
};
