// Уведомления владельцу: в панель (всегда), на личный WhatsApp и/или в Telegram (если настроено).
import { config, log } from './config.mjs';
import { addEvent } from './db.mjs';
import { sendToOwnerPhone } from './channels/hub.mjs';

export const digits = (s) => String(s || '').replace(/\D/g, '');

export function panelLink(contactId) {
  const p = config().panel.port;
  return contactId ? `http://localhost:${p}/#chat/${contactId}` : `http://localhost:${p}/`;
}

/** type: handoff | payment | ai_error | review | report | info */
export async function notifyOwner(type, text, contactId = null) {
  addEvent('notify', contactId, { kind: type, text });
  const cfg = config();
  const tasks = [];
  if (cfg.notify.whatsappOwner && digits(cfg.business.ownerPhone)) {
    tasks.push(sendToOwnerPhone(digits(cfg.business.ownerPhone), text).then((r) => { if (!r.ok) log('Не удалось написать владельцу в WhatsApp'); }));
  }
  if (cfg.notify.telegramToken && cfg.notify.telegramChatId) {
    tasks.push(fetch(`https://api.telegram.org/bot${cfg.notify.telegramToken}/sendMessage`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: cfg.notify.telegramChatId, text: text.slice(0, 4000), disable_web_page_preview: true }),
      signal: AbortSignal.timeout(20000),
    }).then((r) => { if (!r.ok) log('Telegram: не удалось отправить уведомление', r.status); }).catch((e) => log('Telegram:', e.message)));
  }
  await Promise.all(tasks);
}
