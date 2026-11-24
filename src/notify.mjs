// Уведомления владельцу: в панель (всегда), в Telegram-помощника (главный путь) и/или на личный WhatsApp.
//  WhatsApp-уведомления уходят С НОМЕРА БОТА на личный номер владельца: при QR-подключении — всегда можно,
//  при официальном — только если владелец сам писал на номер бота за последние 24 часа. Поэтому главный путь — Telegram.
import { config, log } from './config.mjs';
import { addEvent } from './db.mjs';
import { sendToOwnerPhone } from './channels/hub.mjs';
import { notify as tgNotify, telegramReady } from './telegram.mjs';

export const digits = (s) => String(s || '').replace(/\D/g, '');

export function panelLink(contactId) {
  const p = config().panel.port;
  return contactId ? `http://localhost:${p}/#chat/${contactId}` : `http://localhost:${p}/`;
}

/** type: handoff | payment | ai_error | review | study | report | info. extra: { paymentId, photo } */
export async function notifyOwner(type, text, contactId = null, extra = {}) {
  addEvent('notify', contactId, { kind: type, text });
  const cfg = config();
  const viaTg = telegramReady() ? await tgNotify(type, text, contactId, extra) : false;
  // в WhatsApp — если владелец так выбрал, или если Telegram не подключён / не сработал
  if ((cfg.notify.whatsappOwner || !viaTg) && digits(cfg.business.ownerPhone)) {
    const r = await sendToOwnerPhone(digits(cfg.business.ownerPhone), text);
    if (!r.ok && !viaTg) log('Уведомление владельцу не доставлено: ни Telegram, ни WhatsApp не подключены');
  }
}
