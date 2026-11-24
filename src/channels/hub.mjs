// Каналы связи: WhatsApp (QR или официальный), Instagram, «Проверка» в панели.
// Каждый канал регистрирует отправку и состояние; бот работает с ними одинаково.

const adapters = {};
let inboundHandler = null;

/** adapter: { send(chatId, text) → {ok, extId?, error?}, typing?(chatId), status() → object, sendToPhone?(phone, text) } */
export function register(name, adapter) { adapters[name] = adapter; }
export function unregister(name) { delete adapters[name]; }
export function adapter(name) { return adapters[name] || null; }

/** Каналы передают сюда входящие: { channel, chatId, name?, phone?, username?, text, media?, extId, at, fromMe? } */
export function onInbound(fn) { inboundHandler = fn; }
export function inbound(msg) {
  if (!inboundHandler) return;
  Promise.resolve(inboundHandler(msg)).catch((e) => console.error('Ошибка обработки входящего:', e));
}

export const LIMITS = { waqr: 4000, wacloud: 4000, instagram: 950, test: 10000 };

/** Длинный текст делим по абзацам, чтобы влезть в ограничение канала. */
export function splitText(text, max) {
  const out = [];
  let rest = String(text || '').trim();
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n\n', max);
    if (cut < max * 0.4) cut = rest.lastIndexOf('\n', max);
    if (cut < max * 0.4) cut = rest.lastIndexOf(' ', max);
    if (cut < max * 0.4) cut = max;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out;
}

export async function send(channel, chatId, text) {
  const a = adapters[channel];
  if (!a) return { ok: false, error: `Канал «${channel}» не подключён` };
  const parts = splitText(text, LIMITS[channel] || 4000);
  const ids = [];
  for (const p of parts) {
    let r;
    try { r = await a.send(chatId, p); } catch (e) { r = { ok: false, error: e.message }; }
    if (!r.ok) return { ok: false, error: r.error, extIds: ids };
    if (r.extId) ids.push(r.extId);
  }
  return { ok: true, extIds: ids, extId: ids[0] };
}

export async function typing(channel, chatId) {
  try { await adapters[channel]?.typing?.(chatId); } catch {}
}

export function statuses() {
  const out = {};
  for (const [k, a] of Object.entries(adapters)) { try { out[k] = a.status(); } catch (e) { out[k] = { state: 'error', error: e.message }; } }
  return out;
}

/** Написать владельцу на его личный WhatsApp — через тот канал, который сейчас работает. */
export async function sendToOwnerPhone(phone, text) {
  for (const name of ['waqr', 'wacloud']) {
    const a = adapters[name];
    if (a?.sendToPhone && a.status().state === 'connected') {
      try { const r = await a.sendToPhone(phone, text); if (r.ok) return r; } catch {}
    }
  }
  return { ok: false };
}
