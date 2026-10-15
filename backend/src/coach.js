// AI coach chat. Uses an OpenAI-compatible Chat Completions endpoint when OPENAI_API_KEY is set;
// otherwise returns a clearly labelled rule-based reply built from the user's own analytics.
const API_KEY = process.env.OPENAI_API_KEY;
const BASE_URL = (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '');
const MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';

const CRISIS = /\b(suicid|kill myself|end my life|self[- ]?harm|hurt myself|don'?t want to live)\b/i;

const SYSTEM = `You are Synapse, a warm, practical digital-wellbeing coach inside a focus app.
Give short, specific suggestions (max ~120 words) grounded in the user's activity summary.
You are not a therapist or doctor; never diagnose. Encourage breaks, sleep, movement and real-world connection.
If the user mentions crisis, self-harm or wanting to die, respond with care and urge them to contact local emergency services or a crisis line immediately.`;

function crisisReply() {
  return {
    source: 'safety',
    text:
      "I'm really glad you told me. You deserve support from a person right now. If you might act on these thoughts, please contact your local emergency number. " +
      'In India you can call Tele-MANAS at 14416 (24x7); elsewhere, findahelpline.com lists free, confidential lines. ' +
      'If you can, reach out to someone you trust and let them know how you are feeling.',
  };
}

function fallbackReply(message, insight) {
  const top = insight.recommendations[0];
  const factor = insight.ml.factors[0];
  const parts = [
    `Right now your pattern looks **${insight.state}** (score ${insight.score}/100, ${insight.confidence} confidence).`,
  ];
  if (factor) parts.push(`The biggest influence is ${factor.label.toLowerCase()} at ${factor.display} (typical: ${factor.typical}).`);
  if (top) parts.push(`Suggestion: ${top.action}`);
  if (/tired|exhaust|burn/i.test(message)) parts.push('Feeling drained is a signal, not a failure - a 15-minute session plus a real break is a fine win today.');
  return { source: 'demo', text: parts.join(' ') };
}

async function reply(message, insight, history = []) {
  if (CRISIS.test(message)) return crisisReply();
  if (!API_KEY) return fallbackReply(message, insight);

  const context = {
    state: insight.state,
    score: insight.score,
    confidence: insight.confidence,
    topFactors: insight.ml.factors.slice(0, 4).map((f) => `${f.label}: ${f.display} (${f.direction} risk)`),
    recommendations: insight.recommendations.map((r) => r.title),
  };
  const messages = [
    { role: 'system', content: SYSTEM },
    { role: 'system', content: `User activity summary (last 7 days): ${JSON.stringify(context)}` },
    ...history.slice(-6).map((h) => ({ role: h.role === 'assistant' ? 'assistant' : 'user', content: String(h.content).slice(0, 1000) })),
    { role: 'user', content: message },
  ];
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 20000);
    const res = await fetch(`${BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}` },
      body: JSON.stringify({ model: MODEL, messages, max_tokens: 300, temperature: 0.6 }),
      signal: ctrl.signal,
    });
    clearTimeout(t);
    if (!res.ok) throw new Error(`LLM HTTP ${res.status}`);
    const data = await res.json();
    const text = data.choices?.[0]?.message?.content?.trim();
    if (!text) throw new Error('empty LLM reply');
    return { source: 'llm', text };
  } catch (err) {
    console.warn('[coach] LLM call failed, using fallback:', err.message);
    const fb = fallbackReply(message, insight);
    fb.text = '(AI service unavailable - showing rule-based guidance.) ' + fb.text;
    return fb;
  }
}

module.exports = { reply, llmEnabled: !!API_KEY };
