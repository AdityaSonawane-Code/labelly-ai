// Vercel serverless function: keeps your free Google Gemini API key on the server.
const hits = new Map(); // simple per-IP rate limit

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const key = process.env.GEMINI_API_KEY;
  if (!key) return res.status(500).json({ error: 'Server is missing GEMINI_API_KEY' });

  const ip = (req.headers['x-forwarded-for'] || 'x').split(',')[0].trim();
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter(t => now - t < 60000);
  if (recent.length >= 8) return res.status(429).json({ error: 'Too many requests. Wait a minute.' });
  recent.push(now); hits.set(ip, recent);

  const { prompt, images = [] } = req.body || {};
  if (typeof prompt !== 'string' || !prompt || prompt.length > 20000)
    return res.status(400).json({ error: 'Bad prompt' });
  if (!Array.isArray(images) || images.length > 6 || images.some(i => typeof i !== 'string'))
    return res.status(400).json({ error: 'Up to 6 images allowed' });

  const model = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
  const parts = [
    ...images.map(data => ({ inline_data: { mime_type: 'image/jpeg', data } })),
    { text: prompt },
  ];
  try {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({
        contents: [{ role: 'user', parts }],
        generationConfig: { maxOutputTokens: 8000, temperature: 0.3 },
      }),
    });
    const d = await r.json();
    if (r.status === 429) return res.status(429).json({ error: 'Free limit reached. Try again later.' });
    if (!r.ok) return res.status(502).json({ error: (d.error && d.error.message) || 'AI provider error' });
    const text = ((d.candidates || [])[0]?.content?.parts || []).map(p => p.text || '').join('\n');
    if (!text) return res.status(502).json({ error: 'Empty AI response' });
    return res.status(200).json({ text });
  } catch (e) {
    return res.status(500).json({ error: 'AI request failed' });
  }
};
