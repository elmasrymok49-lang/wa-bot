import { chat } from './gemini.js';
import { db, save, nextId, pushHistory } from './store.js';

const TZ = 'Africa/Cairo';
const now = () => new Date().toLocaleString('ar-EG', { timeZone: TZ, dateStyle: 'full', timeStyle: 'short' });

function systemPrompt(u) {
  const name = process.env.BOT_NAME || 'آدم';
  const brand = (process.env.BOT_BRAND || 'TorX').trim();
  const owner = process.env.OWNER_NUMBER || '';
  const profile = u.stage === 'ready'
    ? `اسمه: ${u.name}\nبيحب: ${(u.likes || []).join('، ') || 'لسه مش معروف'}\nمعلومات: ${(u.facts || []).join(' | ') || 'مفيش'}`
    : 'لسه ما عرّفش نفسه.';

  return `إنت "${name}" — جزء من منتج اسمه ${brand} — مساعد شخصي مصري شغال على واتساب نيابة عن صاحب الرقم (${owner}).
إنت مش روبوت رسمي — إنت صاحب جدع، دمه خفيف، بيسمع أكتر ما بيتكلم.

# الوقت دلوقتي
${now()} (توقيت القاهرة). احسب أي "بكرة" أو "كمان ساعة" على الأساس ده.

# الشخص اللي بتكلمه
${profile}

# أسلوب الكلام
- مصري عامي طبيعي 100%. "ماشي" "تمام" "بص" "يا صاحبي" "خلاص" "ما تقلقش".
- ممنوع الفصحى، وممنوع "كيف يمكنني مساعدتك" و"بالتأكيد!" و"يسعدني ذلك".
- الرد الافتراضي سطر أو اتنين. لو طويل، قسّمه لرسايل قصيرة وافصل بينهم بسطر فاضي.
- نوّع في البدايات. أحياناً رد بكلمة واحدة زي "تمام" أو "حصل".
- إيموجي واحد بالكتير، وأحياناً ولا واحد.
- اسأل سؤال واحد بس لو ناقصك تفصيلة.
- لو حد حزين: اسمع الأول وما تنصحش على طول.
- لو سألك حد صراحة "إنت بوت ولا إنسان؟" → ما تكدبش، قول إنك مساعد ذكي نيابة عن صاحب الرقم.
- ما تخترعش معلومات عن صاحب الرقم ولا وعود باسمه.

# الرياكت
لو الرسالة فيها مشاعر → نادي أداة react قبل ما ترد.
حب ❤️ | حماس 🔥 | فرح وإنجاز 🎉 أو 👏 | ضحك 😂 | حزن وتعب 🫂 | صدمة 😮 | شكر 🙏
رياكت واحد بس، ومش على كل رسالة.

# الأوامر
- أي طلب تذكير → لازم أداة set_reminder، وما تقولش "هفكرك" من غيرها.
- التذكير بيتكرر لحد ما يرد، طمنه.
- لو طلب يكلم حد → أداة voice_to_person، ووضّح له إنها رسالة صوتية مش مكالمة رنين.
- ما تبعتش لحد إلا لو صاحب الرقم طلب صراحة.
- أي معلومة جديدة عن الشخص → remember.

# مرحلة التعارف
${u.stage !== 'ready' ? `إنت لسه ما تعرفش الشخص ده. ابدأ برسالتين قصيرين: عرّف نفسك باسمك وقول إنك مساعده الشخصي.
اطلب اسمه وبيحب إيه وشغال أو بيدرس إيه.
وضّح له إن ده عشان تساعده صح، وإن بياناته متخزنة على الجهاز مش على سيرفراتنا، لكن نص الرسائل بيتبعت لجوجل (Gemini) عشان تقدر ترد.
ممنوع تنفذ أي أمر قبل ما يكمّل التعارف. لو طلب حاجة قوله "قوللي اسمك الأول وأنا تحت أمرك".
أول ما يقول اسمه + حاجتين عنه → نادي save_profile فوراً.` : 'الشخص ده عرّف نفسه. كلمه باسمه من وقت للتاني (مش كل رسالة).'}`;
}

const T = (name, description, props, required = []) => ({
  type: 'function',
  function: { name, description, parameters: { type: 'object', properties: props, required } }
});

const ONBOARD_TOOLS = [
  T('save_profile', 'سجّل بروفايل الشخص بعد ما يعرّف نفسه', {
    name: { type: 'string' }, likes: { type: 'array', items: { type: 'string' } },
    facts: { type: 'array', items: { type: 'string' } }
  }, ['name']),
  T('react', 'رياكت على رسالة المستخدم', { emoji: { type: 'string' } }, ['emoji'])
];

const ALL_TOOLS = [
  ...ONBOARD_TOOLS,
  T('remember', 'احفظ معلومة جديدة عن الشخص', { fact: { type: 'string' } }, ['fact']),
  T('set_reminder', 'تذكير بيتكرر لحد ما الشخص يرد', {
    what: { type: 'string' },
    in_minutes: { type: 'number', description: 'بعد كام دقيقة من دلوقتي' },
    at_iso: { type: 'string', description: 'أو وقت ISO مع +02:00' },
    repeat_every_min: { type: 'number', description: 'افتراضي 10' },
    max_tries: { type: 'number', description: 'افتراضي 6' }
  }, ['what']),
  T('cancel_reminder', 'الغي تذكير', { id: { type: 'number' } }, ['id']),
  T('list_reminders', 'اعرض التذكيرات الشغالة', {}),
  T('send_voice_note', 'ابعت ردك كفويس نوت بصوت بشري بدل كتابة', { text: { type: 'string' } }, ['text']),
  T('voice_to_person', 'ابعت رسالة صوتية لشخص نيابة عن صاحب الرقم (مش مكالمة رنين)', {
    number: { type: 'string', description: '201xxxxxxxxx' },
    purpose: { type: 'string', description: 'الرسالة اللي هتتقال' }
  }, ['number', 'purpose'])
];

async function exec(tc, u, ctx) {
  const a = JSON.parse(tc.function.arguments || '{}');
  switch (tc.function.name) {
    case 'react':
      await ctx.react(a.emoji); return { ok: true };

    case 'save_profile':
      u.name = a.name; u.likes = a.likes || []; u.facts = a.facts || [];
      u.stage = 'ready'; save();
      return { ok: true, note: 'اتسجل. رحّب بيه باسمه.' };

    case 'remember':
      u.facts.push(a.fact); save(); return { ok: true };

    case 'set_reminder': {
      const at = a.at_iso ? Date.parse(a.at_iso) : Date.now() + (a.in_minutes ?? 1) * 60000;
      if (!at || isNaN(at)) return { ok: false, error: 'وقت غير صالح' };
      const r = { id: nextId(), jid: u.jid, what: a.what, active: true, tries: 0,
        nextAt: at, everyMin: a.repeat_every_min || 10, maxTries: a.max_tries || 6 };
      db.reminders.push(r); save();
      return { ok: true, id: r.id, fires_at: new Date(at).toLocaleString('ar-EG', { timeZone: TZ }) };
    }

    case 'cancel_reminder': {
      const r = db.reminders.find(x => x.id === a.id && x.jid === u.jid);
      if (r) { r.active = false; save(); return { ok: true }; }
      return { ok: false };
    }

    case 'list_reminders':
      return db.reminders.filter(r => r.jid === u.jid && r.active)
        .map(r => ({ id: r.id, what: r.what, at: new Date(r.nextAt).toLocaleString('ar-EG', { timeZone: TZ }) }));

    case 'send_voice_note':
      await ctx.sendVoice(a.text); return { ok: true, note: 'الفويس اتبعت. ما تكتبش نفس الكلام.' };

    case 'voice_to_person':
      return await ctx.voiceTo(a.number, a.purpose);

    default: return { ok: false, error: 'unknown tool' };
  }
}

export async function runAgent(u, text, ctx, parts, notes) {
  const head = notes?.length ? notes.join('\n') + '\n\n' : '';
  const payload = parts?.length
    ? [{ type: 'text', text: head + text }, ...parts]
    : head + text;
  const messages = [
    { role: 'system', content: systemPrompt(u) },
    ...u.history.slice(-10).map(h => ({ role: h.role, content: h.content })),
    { role: 'user', content: payload }
  ];
  const tools = (u.stage === 'ready' ? ALL_TOOLS : ONBOARD_TOOLS).filter(t => t.function.name !== 'react');
  let final = '';

  for (let i = 0; i < 5; i++) {
    const m = await chat({ messages, tools });
    messages.push({ ...m, role: 'assistant', content: m.content || '' });
    if (!m.tool_calls?.length) { final = m.content || ''; break; }
    for (const tc of m.tool_calls) {
      let res;
      try { res = await exec(tc, u, ctx); } catch (e) { res = { ok: false, error: String(e.message) }; }
      messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(res) });
    }
  }

  pushHistory(u, 'user', text);
  pushHistory(u, 'assistant', final);
  return final.trim();
}
