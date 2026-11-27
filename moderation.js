// Message and image moderation.
// 1) An instant built-in filter masks contact details (phone numbers, emails, links)
//    and a short list of abusive words.
// 2) When ANTHROPIC_API_KEY is set, Claude checks each text message and image.
//    Text is delivered at once and pulled back if Claude flags it; images are
//    checked before they are delivered.
const Anthropic = require('@anthropic-ai/sdk').default;
const { zodOutputFormat } = require('@anthropic-ai/sdk/helpers/zod');
const { z } = require('zod');

const MODEL = 'claude-opus-5-5';
const enabled = !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
const client = enabled ? new Anthropic() : null;

// ---- built-in filter ----
const ABUSE = ['fuck you', 'kill yourself', 'kys', 'bitch', 'whore', 'slut', 'retard', 'faggot', 'nigger', 'cunt'];
const abuseRe = new RegExp(`\\b(${ABUSE.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\b`, 'gi');
const phoneRe = /(\+?\d[\d\s().-]{7,}\d)/g;
const emailRe = /[\w.+-]+@[\w-]+\.[\w.-]+/g;
const linkRe = /\b((https?:\/\/|www\.)\S+|\S+\.(com|net|org|io|me|gg|ly|app)\b\S*)/gi;
const handleRe = /(^|\s)@[a-z0-9_.]{3,}/gi;

function quickFilter(text, { allowContacts = false } = {}) {
  let out = String(text || '').slice(0, 1000);
  let changed = false;
  const mask = (re, rep) => { out = out.replace(re, (...m) => { changed = true; return typeof rep === 'function' ? rep(...m) : rep; }); };
  mask(abuseRe, (w) => '*'.repeat(w.length));
  if (!allowContacts) {
    mask(emailRe, '[email hidden]');
    mask(linkRe, '[link hidden]');
    mask(phoneRe, '[number hidden]');
    mask(handleRe, (m, sp) => `${sp}[handle hidden]`);
  }
  return { text: out, changed };
}

// ---- Claude check ----
const Verdict = z.object({
  allowed: z.boolean(),
  category: z.enum(['ok', 'harassment', 'hate', 'sexual', 'minors', 'self_harm', 'violence', 'spam', 'personal_info', 'other']),
});

const SYSTEM = `You moderate an anonymous 18+ chat site where strangers talk. Decide if one message (or image) may be shown.
Block: harassment or bullying, hate speech, sexual content or sexual requests, anything sexual involving minors or a user saying they are under 18,
threats or graphic violence, encouraging self-harm, scams/spam/ads, and attempts to share contact details or move the chat elsewhere.
Allow: normal conversation, jokes, mild swearing that isn't aimed at someone, disagreement, flirting that isn't sexual.
Answer with allowed=true and category "ok" when it is fine.`;

async function ask(content) {
  if (!client) return { allowed: true, category: 'ok', checked: false };
  try {
    const res = await client.messages.parse({
      model: MODEL,
      max_tokens: 1024,
      system: SYSTEM,
      output_config: { effort: 'low', format: zodOutputFormat(Verdict) },
      messages: [{ role: 'user', content }],
    });
    // If Claude declines to look at the content at all, treat it as not allowed.
    if (res.stop_reason === 'refusal') return { allowed: false, category: 'other', checked: true };
    const v = res.parsed_output;
    if (!v) return { allowed: true, category: 'ok', checked: false };
    return { ...v, checked: true };
  } catch (err) {
    if (err instanceof Anthropic.RateLimitError) console.log('moderation: rate limited, allowing message');
    else if (err instanceof Anthropic.AuthenticationError) console.log('moderation: invalid ANTHROPIC_API_KEY');
    else if (err instanceof Anthropic.APIError) console.log(`moderation: API error ${err.status}`);
    else console.log('moderation error:', err.message);
    return { allowed: true, category: 'ok', checked: false }; // fail open so chat keeps working
  }
}

function checkText(text) {
  if (!text || text.length < 2) return Promise.resolve({ allowed: true, category: 'ok', checked: false });
  return ask([{ type: 'text', text: `Message:\n"""${text}"""` }]);
}

function checkImage(dataUrl) {
  const m = /^data:(image\/(png|jpeg|webp|gif));base64,(.+)$/.exec(dataUrl || '');
  if (!m) return Promise.resolve({ allowed: false, category: 'other', checked: false });
  return ask([
    { type: 'image', source: { type: 'base64', media_type: m[1], data: m[3] } },
    { type: 'text', text: 'Is this image allowed?' },
  ]);
}

module.exports = { quickFilter, checkText, checkImage, aiEnabled: enabled, MODEL };
