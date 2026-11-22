import fs from 'node:fs';
import path from 'node:path';

const DIR = process.env.DATA_DIR || './data';
fs.mkdirSync(DIR, { recursive: true });
const FILE = path.join(DIR, 'db.json');

export const db = fs.existsSync(FILE)
  ? JSON.parse(fs.readFileSync(FILE, 'utf8'))
  : { users: {}, reminders: [], seq: 1 };

let t;
export function save() {
  clearTimeout(t);
  t = setTimeout(() => {
    fs.writeFileSync(FILE + '.tmp', JSON.stringify(db, null, 1));
    fs.renameSync(FILE + '.tmp', FILE);
  }, 200);
}

export function getUser(jid) {
  if (!db.users[jid]) db.users[jid] = {
    jid, stage: 'new', name: null, likes: [], facts: [], history: [], createdAt: Date.now()
  };
  return db.users[jid];
}

export function pushHistory(u, role, content) {
  if (!content) return;
  u.history.push({ role, content, t: Date.now() });
  if (u.history.length > 40) u.history.splice(0, u.history.length - 40);
  save();
}

export const nextId = () => db.seq++;
