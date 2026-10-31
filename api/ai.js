const hits = new Map();
const MODELS = [process.env.GEMINI_MODEL, 'gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-flash-latest'].filter(Boolean);

module.exports = async (req, res) => {
  const key = process.env.GEMINI_API_KEY;
  if (req.method === 'GET') return res.status(200).json({ ok: true, hasKey: !!key, models: MODELS });
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  if (!key) return res.status(500).json({ error: 'Server is missing GEMINI_API_KEY (add it in Vercel, then Redeploy)' });

  const ip = (req.headers['x-forwarded-for'] || 'x').split(',')[0].trim();
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter(t => now - t < 60000);
  if (recent.length >= 10) return res.status(429).json({ error: 'Too many requests. Wait a minute.' });
  recent.push(now); hits.set(ip, recent);

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  const { prompt, images = [], json } = body || {};
  if (typeof prompt !== 'string' || !prompt || prompt.length > 20000)
    return res.status(400).json({ error: 'Bad prompt' });
  if (!Array.isArray(images) || images.length > 6 || images.some(i => typeof i !== 'string'))
    return res.status(400).json({ error: 'Up to 6 images allowed' });

  const parts = [
    ...images.map(data => ({ inline_data: { mime_type: 'image/jpeg', data } })),
    { text: prompt },
  ];
  const generationConfig = { maxOutputTokens: 8000, temperature: 0.2 };
  if (json) generationConfig.responseMimeType = 'application/json';

  let lastErr = 'AI provider error';
  for (const model of MODELS) {
    try {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify({ contents: [{ role: 'user', parts }], generationConfig }),
      });
      const d = await r.json().catch(() => ({}));
      if (r.status === 429) return res.status(429).json({ error: 'Free limit reached. Try again later.' });
      if (!r.ok) { lastErr = `${model}: ${(d.error && d.error.message) || r.status}`; if (r.status === 404 || r.status === 400) continue; return res.status(502).json({ error: lastErr }); }
      const text = ((d.candidates || [])[0]?.content?.parts || []).map(p => p.text || '').join('\n');
      if (!text) { lastErr = `${model}: empty response`; continue; }
      return res.status(200).json({ text, model });
    } catch (e) { lastErr = `${model}: ${e.message}`; }
  }
  return res.status(502).json({ error: lastErr });
};
