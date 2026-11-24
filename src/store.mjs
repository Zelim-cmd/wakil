// Клиенты, сообщения, заявки — общие действия для бота, каналов, панели и аналитики.
import { get, all, run, insert, update, addEvent } from './db.mjs';
import { canonicalHotel, normCity } from './knowledge.mjs';

export const STAGES = ['new', 'consulting', 'offer', 'deciding', 'booking', 'paid', 'lost'];
export const STAGE_LABEL = {
  new: 'Новый', consulting: 'Консультация', offer: 'Предложены варианты', deciding: 'Думает',
  booking: 'Оформление брони', paid: 'Оплатил', lost: 'Отказ',
};
export const CHANNEL_LABEL = { waqr: 'WhatsApp', wacloud: 'WhatsApp', instagram: 'Instagram', test: 'Проверка' };

export function getContact(id) { return get('SELECT * FROM contacts WHERE id = ?', id); }
export function findContact(channel, chatId) { return get('SELECT * FROM contacts WHERE channel = ? AND chat_id = ?', channel, String(chatId)); }

export function upsertContact({ channel, chatId, name, phone, username }) {
  const now = Date.now();
  let c = findContact(channel, chatId);
  if (!c) {
    const id = insert('contacts', { channel, chat_id: String(chatId), name: name || '', phone: phone || '', username: username || '', created_at: now, last_at: now, stage: 'new' });
    insert('stage_log', { contact_id: id, stage: 'new', at: now });
    addEvent('new_contact', id, { channel });
    return getContact(id);
  }
  const patch = {};
  if (name && !c.name) patch.name = name;
  if (phone && !c.phone) patch.phone = phone;
  if (username && c.username !== username) patch.username = username;
  if (Object.keys(patch).length) { update('contacts', c.id, patch); c = { ...c, ...patch }; }
  return c;
}

/** Сохранить сообщение. Возвращает id или null, если такое уже было (повтор от WhatsApp/Meta). */
export function addMessage({ contactId, dir, author, text = '', mediaKind = '', mediaPath = '', at = Date.now(), extId = null }) {
  if (extId && get('SELECT id FROM messages WHERE contact_id = ? AND ext_id = ?', contactId, String(extId))) return null;
  const id = insert('messages', { contact_id: contactId, dir, author, text, media_kind: mediaKind, media_path: mediaPath, at, ext_id: extId ? String(extId) : null });
  const patch = { last_at: Math.max(at, getContact(contactId)?.last_at || 0) };
  if (dir === 'in') patch.last_in_at = at; else patch.last_out_at = at;
  update('contacts', contactId, patch);
  return id;
}

export function recentMessages(contactId, limit = 40) {
  return all('SELECT * FROM (SELECT * FROM messages WHERE contact_id = ? ORDER BY at DESC, id DESC LIMIT ?) ORDER BY at, id', contactId, limit);
}

export function setStage(contactId, stage, reason = '') {
  if (!STAGES.includes(stage)) return false;
  const c = getContact(contactId);
  if (!c || c.stage === stage) return false;
  const patch = { stage };
  if (stage === 'lost') patch.lost_reason = reason || c.lost_reason || '';
  update('contacts', contactId, patch);
  insert('stage_log', { contact_id: contactId, stage, at: Date.now() });
  if (stage === 'lost') { const r = openRequest(contactId, false); if (r) update('requests', r.id, { status: 'lost', updated_at: Date.now() }); }
  return true;
}

/** Текущая заявка клиента (что он хочет). create=false — не создавать новую. */
export function openRequest(contactId, create = true) {
  const r = get("SELECT * FROM requests WHERE contact_id = ? AND status = 'open' ORDER BY id DESC LIMIT 1", contactId);
  if (r || !create) return r || null;
  const now = Date.now();
  const id = insert('requests', { contact_id: contactId, created_at: now, updated_at: now, status: 'open' });
  return get('SELECT * FROM requests WHERE id = ?', id);
}

const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? undefined : Number(v));

/** Записать то, что ИИ понял о запросе клиента. */
export function applyFacts(contactId, facts = {}) {
  if (!facts || typeof facts !== 'object') return;
  const hasAny = Object.entries(facts).some(([k, v]) => v !== null && v !== undefined && v !== '' && !(Array.isArray(v) && !v.length) && k !== 'notes');
  if (!hasAny) return;
  const c = getContact(contactId);
  const req = openRequest(contactId);
  const patch = {};
  const city = facts.city === 'both' ? 'both' : normCity(facts.city);
  if (city) patch.city = city;
  if (isDate(facts.check_in)) patch.check_in = facts.check_in;
  if (isDate(facts.check_out)) patch.check_out = facts.check_out;
  for (const k of ['nights', 'guests', 'rooms']) { const v = num(facts[k]); if (v !== undefined && v > 0 && v < 1000) patch[k] = Math.round(v); }
  if (!patch.nights && (patch.check_in || req.check_in) && (patch.check_out || req.check_out)) {
    const n = Math.round((Date.parse(patch.check_out || req.check_out) - Date.parse(patch.check_in || req.check_in)) / 86400000);
    if (n > 0 && n < 400) patch.nights = n;
  }
  const budget = num(facts.budget); if (budget !== undefined && budget > 0) patch.budget = budget;
  for (const k of ['room_type', 'meals', 'currency', 'trip_type']) if (facts[k]) patch[k] = String(facts[k]).slice(0, 100);
  const notes = [facts.budget_note, facts.notes].filter(Boolean).join('; ');
  if (notes) patch.notes = notes.slice(0, 500);
  const hotels = Array.isArray(facts.hotels) ? facts.hotels.map(canonicalHotel).filter(Boolean) : [];
  if (hotels.length) {
    const known = JSON.parse(req.hotels || '[]');
    patch.hotels = JSON.stringify([...new Set([...known, ...hotels])].slice(0, 20));
    for (const h of hotels) {
      if (!get('SELECT id FROM interests WHERE contact_id = ? AND hotel = ?', contactId, h)) {
        insert('interests', { contact_id: contactId, hotel: h, city: patch.city || req.city || '', at: Date.now() });
      }
    }
  }
  if (Object.keys(patch).length) update('requests', req.id, { ...patch, updated_at: Date.now() });
  const f = { ...JSON.parse(c.facts || '{}') };
  for (const [k, v] of Object.entries(facts)) if (v !== null && v !== undefined && v !== '' && !(Array.isArray(v) && !v.length)) f[k] = v;
  update('contacts', contactId, { facts: JSON.stringify(f) });
}

export function contactLabel(c) {
  return c.name || (c.username ? '@' + c.username : '') || c.phone || `клиент #${c.id}`;
}

export function deleteContact(id) {
  for (const t of ['messages', 'requests', 'interests', 'stage_log', 'questions', 'events']) run(`DELETE FROM ${t} WHERE contact_id = ?`, id);
  // неподтверждённые «оплатил» удаляем, а настоящие брони и оплаты остаются в учёте (без привязки к клиенту)
  run("DELETE FROM payments WHERE contact_id = ? AND status = 'claimed'", id);
  run('UPDATE payments SET contact_id = NULL WHERE contact_id = ?', id);
  run('UPDATE bookings SET contact_id = NULL WHERE contact_id = ?', id);
  run('DELETE FROM contacts WHERE id = ?', id);
}
