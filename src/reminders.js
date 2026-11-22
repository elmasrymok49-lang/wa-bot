import { db, save } from './store.js';
import { chat } from './gemini.js';

let ctx;
export function initReminders(c) { ctx = c; setInterval(tick, 20000); setTimeout(tick, 4000); }

export function stopFor(jid) {
  let n = 0;
  for (const r of db.reminders) if (r.jid === jid && r.active) { r.active = false; n++; }
  if (n) save();
  return n;
}

async function pingText(r) {
  const tone = ['أول تذكير، خفيف ولطيف', 'تاني مرة، ودّي', 'تالت مرة، هزار خفيف',
    'رابعة، قلقان عليه بجد', 'خامسة، زن صاحب بيخاف عليك', 'آخر مرة، يائس بشكل مضحك'][Math.min(r.tries, 5)];
  try {
    const m = await chat({
      temperature: 1.0,
      messages: [
        { role: 'system', content: 'إنت صاحب مصري بتفكر صاحبك بحاجة. رسالة واحدة قصيرة جداً بالمصري العامي. ممنوع فصحى ومقدمات. إيموجي واحد بالكتير.' },
        { role: 'user', content: `الموضوع: ${r.what}\nالمرة: ${r.tries + 1}\nالنبرة: ${tone}` }
      ]
    });
    return m.content.trim();
  } catch {
    return `يا صاحبي، ${r.what} 👀 لسه ما رديتش`;
  }
}

async function tick() {
  if (!ctx) return;
  for (const r of db.reminders.filter(x => x.active && x.nextAt <= Date.now())) {
    try {
      await ctx.sendText(r.jid, await pingText(r));
      r.tries++;
      if (r.tries >= r.maxTries) {
        r.active = false;
        await ctx.sendText(r.jid, 'ماشي هبطّل زن 😅 بس الموضوع لسه مستنيك.');
      } else r.nextAt = Date.now() + r.everyMin * 60000;
      save();
    } catch (e) { console.error('reminder:', e.message); r.nextAt = Date.now() + 60000; save(); }
  }
}
