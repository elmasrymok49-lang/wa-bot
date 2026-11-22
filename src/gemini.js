import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const run = promisify(execFile);

const OPENAI = 'https://generativelanguage.googleapis.com/v1beta/openai';
const NATIVE = 'https://generativelanguage.googleapis.com/v1beta';
const key = () => (process.env.GEMINI_API_KEY || '').trim();

console.log('🧠 جوجل | موديل:', process.env.GEMINI_MODEL || 'gemini-4-hydrogen',
  '| صوت:', process.env.GEMINI_VOICE || 'Zubenelgenubi');

function cleanMessages(ms) {
  return ms.map(m =>
    (m.role === 'assistant' && m.tool_calls?.length && !m.content) ? { ...m, content: null } : m
  );
}

function cleanTools(ts) {
  return ts.map(t => {
    const f = { ...t.function };
    const p = f.parameters;
    if (p && (!p.properties || Object.keys(p.properties).length === 0)) delete f.parameters;
    return { type: 'function', function: f };
  });
}

export async function chat({ messages, tools, temperature = 0.9, model }) {
  const k = key();
  if (!k || k === 'PUT_KEY_HERE') throw new Error('GEMINI_API_KEY مش موجود في .env');

  const body = {
    model: model || process.env.GEMINI_MODEL || 'gemini-4-hydrogen',
    messages: cleanMessages(messages),
    temperature
  };
  const eff = (process.env.GEMINI_EFFORT ?? 'low').trim();
  if (eff) body.reasoning_effort = eff;
  const mt = parseInt(process.env.GEMINI_MAX_TOKENS || '0', 10); if (mt > 0) body.max_tokens = mt;
  if (tools?.length) { body.tools = cleanTools(tools); body.tool_choice = 'auto'; }

  for (let i = 0; i < 4; i++) {
    const r = await fetch(`${OPENAI}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${k}` },
      body: JSON.stringify(body)
    });
    if (r.ok) return (await r.json()).choices[0].message;
    const e = await r.text();
    if (r.status === 429 || r.status >= 500) { await new Promise(s => setTimeout(s, 3000 * (i + 1))); continue; }
    throw new Error(`Gemini ${r.status}: ${e.slice(0, 400)}`);
  }
  throw new Error('Gemini فشل بعد المحاولات');
}

export async function tts(text) {
  const k = key();
  if (!k || !text?.trim()) return null;
  const model = process.env.GEMINI_TTS_MODEL || 'gemini-3.8-flash-lite-tts';
  const voice = process.env.GEMINI_VOICE || 'Zubenelgenubi';
  try {
    const r = await fetch(`${NATIVE}/models/${model}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': k },
      body: JSON.stringify({
        contents: [{ parts: [{ text }] }],
        generationConfig: {
          responseModalities: ['AUDIO'],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } }
        }
      })
    });
    if (!r.ok) { console.error('TTS', r.status, (await r.text()).slice(0, 200)); return null; }
    const j = await r.json();
    const part = (j?.candidates?.[0]?.content?.parts || []).find(p => p.inlineData?.data);
    if (!part) { console.error('TTS: مفيش صوت في الرد'); return null; }

    const mime = part.inlineData.mimeType || 'audio/wav';
    const isPcm = /l16|pcm/i.test(mime) && !/wav/i.test(mime);
    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const src = path.join(os.tmpdir(), `${id}.${isPcm ? 'pcm' : 'wav'}`);
    const out = path.join(os.tmpdir(), `${id}.ogg`);
    fs.writeFileSync(src, Buffer.from(part.inlineData.data, 'base64'));
    const pre = isPcm ? ['-f', 's16le', '-ar', '24000', '-ac', '1'] : [];
    await run(process.env.FFMPEG || 'ffmpeg', ['-y', ...pre, '-i', src, '-c:a', 'libopus', '-b:a', '32k', '-ar', '48000', '-ac', '1', out]);
    const buf = fs.readFileSync(out);
    fs.unlinkSync(src); fs.unlinkSync(out);
    return buf;
  } catch (e) { console.error('TTS:', e.message); return null; }
}
