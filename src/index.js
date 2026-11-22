import 'dotenv/config';
import P from 'pino';
import makeWASocket, { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion }
  from '@whiskeysockets/baileys';
import { getUser, db, save } from './store.js';
import { runAgent } from './agent.js';
import { initReminders, stopFor } from './reminders.js';
import { tts } from './gemini.js';
import { mediaParts } from './media.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const rand = (a, b) => a + Math.random() * (b - a);
const log = P({ level: 'silent' });
const BRAND = (process.env.BOT_BRAND || 'TorX').trim();
const sanitize = t => String(t).replace(/جيميناي|جوجل|Gemini|Google/gi, BRAND);
let sock, meNum;

const sentIds = new Set();
async function send(jid, content, opts) {
  const r = await sock.sendMessage(jid, content, opts);
  if (r?.key?.id) { sentIds.add(r.key.id); if (sentIds.size > 800) sentIds.delete(sentIds.values().next().value); }
  return r;
}

const numOf = j => (j || '').split('@')[0].split(':')[0];
const realJid = k => (k.remoteJid?.endsWith('@lid') && k.remoteJidAlt) ? k.remoteJidAlt : k.remoteJid;

async function sendVoice(jid, text) {
  const buf = await tts(text);
  await sock.sendPresenceUpdate('recording', jid).catch(() => {});
  await sleep(Math.min(6000, 1200 + text.length * 40));
  if (buf) await send(jid, { audio: buf, mimetype: 'audio/ogg; codecs=opus', ptt: true });
  else await send(jid, { text });
}

async function start() {
  const { state, saveCreds } = await useMultiFileAuthState('auth');
  let version;
  try { ({ version } = await fetchLatestBaileysVersion()); } catch {}

  sock = makeWASocket({
    version, auth: state, logger: log,
    browser: ['Ubuntu', 'Chrome', '121.0.0.0'],
    markOnlineOnConnect: true, syncFullHistory: false
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', ({ connection, lastDisconnect }) => {
    if (connection === 'open') { meNum = numOf(sock.user.id); console.log('✅ متصل:', sock.user.id); }
    if (connection === 'close') {
      const sc = lastDisconnect?.error?.output?.statusCode;
      if (sc !== DisconnectReason.loggedOut) setTimeout(start, 4000);
      else console.log('❌ الجلسة اتلغت: rm -rf auth');
    }
  });

  if (!sock.authState.creds.registered) {
    await sleep(3500);
    const phone = (process.env.BOT_NUMBER || '').replace(/\D/g, '');
    if (!phone) { console.log('❌ BOT_NUMBER فاضي'); process.exit(1); }
    try {
      const code = await sock.requestPairingCode(phone);
      console.log('\n كود الربط:', code.match(/.{1,4}/g).join('-'), '\n');
    } catch (e) { console.log('فشل الكود:', e.message); }
  }

  sock.ev.on('messages.upsert', ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const m of messages) handle(m).catch(e => console.error('handle:', e.message));
  });
}

const inbox = new Map();

async function handle(m) {
  const key = m.key;
  if (!m.message || !key || sentIds.has(key.id)) return;
  const jid = realJid(key);
  if (!jid || jid === 'status@broadcast' || jid.endsWith('@newsletter')) return;

  const text = m.message.conversation || m.message.extendedTextMessage?.text
    || m.message.imageMessage?.caption || m.message.videoMessage?.caption || '';
  const hasMedia = !!(m.message.imageMessage || m.message.videoMessage || m.message.stickerMessage || m.message.audioMessage);
  if (!text.trim() && !hasMedia) return;

  if (key.fromMe && numOf(jid) !== meNum) return;
  if (jid.endsWith('@g.us') && !text.includes('@' + meNum)) return;

  const allowed = (process.env.ALLOWED || '').split(',').map(s => s.trim()).filter(Boolean);
  if (allowed.length && !allowed.includes(numOf(jid))) return;

  stopFor(jid);
  if (!hasMedia) quickReact(jid, key, text);
  if (await maybePolicy(jid, text)) return;
  await sock.readMessages([key]).catch(() => {});

  const box = inbox.get(jid) || { texts: [], key, parts: [], notes: [] };
  box.texts.push(text.trim()); box.key = key;
  box.parts = box.parts || []; box.notes = box.notes || [];
  if (hasMedia) {
    await sock.sendPresenceUpdate('composing', jid).catch(() => {});
    const r = await mediaParts(m, sock, log);
    if (r?.parts?.length) box.parts.push(...r.parts);
    if (r?.note) box.notes.push(r.note);
    console.log('🖼️ ميديا:', r?.kind, '| أجزاء:', r?.parts?.length || 0);
  }
  clearTimeout(box.timer);
  box.timer = setTimeout(() => { inbox.delete(jid); reply(jid, box).catch(e => console.error('reply:', e.message)); }, 600);
  inbox.set(jid, box);
}

async function reply(jid, box) {
  const u = getUser(jid); const t0 = Date.now();
  await sock.sendPresenceUpdate('composing', jid).catch(() => {});
  const typer = setInterval(() => sock.sendPresenceUpdate('composing', jid).catch(() => {}), 6000);

  const ctx = {
    react: async emoji => {
      await sleep(rand(700, 2200));
      await send(jid, { react: { text: emoji, key: box.key } }).catch(() => {});
    },
    sendText: (t, o) => send(jid, { text: t }, o),
    sendVoice: t => sendVoice(jid, t),
    voiceTo: async (number, purpose) => {
      const target = String(number).replace(/\D/g, '') + '@s.whatsapp.net';
      await sendVoice(target, `أهلاً، أنا المساعد الذكي بتاع صاحب الرقم ده. عندي رسالة ليك: ${purpose}`);
      return { ok: true, note: 'اتبعت رسالة صوتية' };
    }
  };

  let out = '';
  try { out = await runAgent(u, box.texts.join('\n') || '(بعت ميديا من غير كلام)', ctx, box.parts, box.notes); }
  catch (e) { console.error('agent:', e.message); out = 'معلش حصل مشكلة عندي 😅 ابعت تاني بعد شوية'; }
  finally { clearInterval(typer); console.log('⏱️ زمن الرد:', Date.now() - t0, 'ms'); }

  if (!out) { await sock.sendPresenceUpdate('paused', jid).catch(() => {}); return; }

  const rx = out.match(/^\s*\[\[react:\s*([^\]]+?)\s*\]\]\s*/);
  if (rx) { fireReact(jid, box.key, rx[1].trim()); out = out.slice(rx[0].length); }
  out = sanitize(out);
  if (!out.trim()) { await sock.sendPresenceUpdate('paused', jid).catch(() => {}); return; }
  for (const b of out.split(/\n{2,}/).map(s => s.trim()).filter(Boolean).slice(0, 2)) {
    await sock.sendPresenceUpdate('composing', jid).catch(() => {});
    await sleep(Math.min(1800, 250 + b.length * 12));
    await send(jid, { text: b });
    await sock.sendPresenceUpdate('paused', jid).catch(() => {});
    await sleep(rand(150, 400));
  }
}

initReminders({ sendText: (jid, t) => sock ? send(jid, { text: sanitize(t) }) : Promise.reject(new Error('مش متصل')) });
start();

const REACT_MAP = [
  [/بحبك|حبيبي|حبيبتي|وحشتني|😍|🥰|❤/, '❤️'],
  [/مبروك|نجحت|خلصت|انجزت|جامد|🔥|يلا بينا/, '🔥'],
  [/فرحان|مبسوط|سعيد|اخيرا|🎉/, '🎉'],
  [/هههه|ههه|😂|مضحك|بموت من الضحك/, '😂'],
  [/تعبان|زعلان|محبط|زهقت|مخنوق|حزين|😢|😭/, '🫂'],
  [/شكرا|تسلم|ربنا يخليك|متشكر/, '🙏'],
  [/مش معقول|ايه ده|😱|صدمة/, '😮']
];

function quickReact(jid, key, text) {
  const hit = REACT_MAP.find(([re]) => re.test(text));
  if (!hit) return;
  fireReact(jid, key, hit[1], 200 + Math.random() * 300);
}

const POLICY = `🔒 الخصوصية عندنا\n\nأنا ${BRAND} — المساعد الذكي بتاعنا.

• اسمك وتفضيلاتك بتتخزن عندنا عشان المساعد يفتكرك ويخدمك صح.
• بياناتك مش بتتباع ولا بتستخدم في إعلانات.
• نص الرسائل بيتعالج عند مزود ذكاء اصطناعي خارجي لتوليد الرد — التفاصيل كاملة في سياسة الخصوصية.
• تقدر تحذف كل بياناتك دلوقتي بكلمة: امسح بياناتي`;

async function maybePolicy(jid, text) {
  const t = text.trim();
  if (/خصوصي[هة]|سياس[هة]\s*الخصوصي[هة]|بياناتي|privacy/i.test(t)) {
    await send(jid, { text: POLICY });
    return true;
  }
  if (/امسح بياناتي|احذف بياناتي/.test(t)) {
    delete db.users[jid];
    for (const r of db.reminders) if (r.jid === jid) r.active = false;
    save();
    await send(jid, { text: 'تمام، مسحت كل بياناتك من عندنا 🧹 ابعت أي رسالة لو حبيت نبدأ من جديد.' });
    return true;
  }
  return false;
}

const reacted = new Set();
function fireReact(jid, key, emoji, delay = 250) {
  if (!emoji || reacted.has(key.id)) return;
  reacted.add(key.id);
  if (reacted.size > 600) reacted.delete(reacted.values().next().value);
  setTimeout(() => { send(jid, { react: { text: emoji, key } }).catch(() => {}); }, delay);
}
