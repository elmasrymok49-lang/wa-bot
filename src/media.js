import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { downloadMediaMessage } from '@whiskeysockets/baileys';
const run = promisify(execFile);

const MAX_MB = Number(process.env.MEDIA_MAX_MB || 20);
const FRAMES = Math.max(1, Math.min(6, Number(process.env.MEDIA_FRAMES || 4)));
const AUDIO_ON = (process.env.MEDIA_AUDIO ?? '1') !== '0';

const tmp = e => path.join(os.tmpdir(), `m${Date.now()}${Math.random().toString(36).slice(2)}.${e}`);
const url = b => 'data:image/jpeg;base64,' + b.toString('base64');

async function still(src, w = 768) {
  const out = tmp('jpg');
  await run(process.env.FFMPEG || 'ffmpeg', ['-y', '-i', src, '-vf', `scale=min(${w}\\,iw):-2`, '-frames:v', '1', '-q:v', '4', out]);
  const b = fs.readFileSync(out); fs.unlinkSync(out); return b;
}

async function grab(src, n, w = 512) {
  let dur = 0;
  try {
    const { stdout } = await run('ffprobe', ['-v','error','-show_entries','format=duration','-of','default=nw=1:nk=1', src]);
    dur = parseFloat(String(stdout).trim()) || 0;
  } catch {}
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fr-'));
  const fps = dur > 0.5 ? (n / dur) : 2;
  try {
    await run(process.env.FFMPEG || 'ffmpeg', ['-y','-i',src,'-vf',`fps=${fps},scale=min(${w}\\,iw):-2`,'-frames:v',String(n),'-q:v','5',path.join(dir,'f%d.jpg')]);
  } catch {}
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.jpg')).sort();
  const bufs = files.map(f => fs.readFileSync(path.join(dir, f)));
  for (const f of files) fs.unlinkSync(path.join(dir, f));
  try { fs.rmdirSync(dir); } catch {}
  return bufs;
}

export async function mediaParts(m, sock, log) {
  const msg = m.message?.ephemeralMessage?.message || m.message?.viewOnceMessage?.message
    || m.message?.viewOnceMessageV2?.message || m.message;
  const im = msg?.imageMessage, vd = msg?.videoMessage, st = msg?.stickerMessage, au = msg?.audioMessage;
  const node = im || vd || st || au;
  if (!node) return null;

  if (au && !AUDIO_ON) return { kind: 'audio-off', parts: [], note: 'الشخص بعت رسالة صوتية وإنت مش قادر تسمعها — اعتذر بلطف وبهزار.' };
  const size = Number(node.fileLength || 0);
  if (size > MAX_MB * 1048576) return { kind: 'too-big', parts: [], note: `الملف كبير (${Math.round(size/1048576)} ميجا) ومش قادر تفتحه — قول كده بهزار.` };

  let raw;
  try {
    raw = await downloadMediaMessage({ ...m, message: msg }, 'buffer', {}, { logger: log, reuploadRequest: sock.updateMediaMessage });
  } catch { return { kind: 'fail', parts: [], note: 'مش قادر تنزّل الميديا — قول كده بصراحة.' }; }

  const kind = im ? 'image' : vd ? (vd.gifPlayback ? 'gif' : 'video') : st ? 'sticker' : 'audio';
  const ext = kind === 'image' ? (/png/i.test(im.mimetype || '') ? 'png' : 'jpg')
    : kind === 'sticker' ? 'webp' : kind === 'audio' ? 'ogg' : 'mp4';
  const src = tmp(ext);
  fs.writeFileSync(src, raw);
  const parts = [];
  let note = '';
  try {
    if (kind === 'image') {
      parts.push({ type: 'image_url', image_url: { url: url(await still(src)) } });
      note = 'الشخص بعت صورة.';
    } else if (kind === 'sticker') {
      const bs = st.isAnimated ? await grab(src, 2, 512) : [await still(src, 512)];
      for (const b of bs) parts.push({ type: 'image_url', image_url: { url: url(b) } });
      note = 'الشخص بعت ملصق (ستيكر)' + (st.isAnimated ? ' متحرك.' : '.');
    } else if (kind === 'audio') {
      const out = tmp('wav');
      await run(process.env.FFMPEG || 'ffmpeg', ['-y','-i',src,'-ar','16000','-ac','1',out]);
      const b = fs.readFileSync(out); fs.unlinkSync(out);
      parts.push({ type: 'input_audio', input_audio: { data: b.toString('base64'), format: 'wav' } });
      note = 'الشخص بعت رسالة صوتية — اسمعها ورد على محتواها كأنك سمعتها فعلاً.';
    } else {
      const bs = await grab(src, FRAMES, 512);
      for (const b of bs) parts.push({ type: 'image_url', image_url: { url: url(b) } });
      note = `الشخص بعت ${kind === 'gif' ? 'GIF' : 'فيديو'} — دي ${bs.length} لقطات منه بالترتيب الزمني. إنت شايف صور بس، مش سامع الصوت.`;
    }
  } catch { note = 'حصل مشكلة وإنت بتفتح الميديا — قول كده بصراحة.'; }
  finally { try { fs.unlinkSync(src); } catch {} }
  return { kind, parts, note };
}
