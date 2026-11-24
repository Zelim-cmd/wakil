// Голосовые сообщения → текст.
//  local  — Whisper прямо на компьютере: бесплатно, без ключей, ничего не уходит в интернет
//           (при первом запуске скачивается модель ≈250 МБ). Язык определяется сам.
//  groq   — Whisper large v3 turbo в облаке Groq: точнее и быстрее, есть бесплатный лимит (нужен ключ).
//  openai — Whisper в облаке OpenAI (нужен ключ, ≈0,6 цента за минуту).
//  off    — не расшифровывать.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { config, paths, log } from './config.mjs';

export const VOICE_ENGINES = {
  local: 'На этом компьютере (бесплатно)',
  groq: 'Groq — облако, точнее (бесплатный лимит, нужен ключ)',
  openai: 'OpenAI — облако (нужен ключ)',
  off: 'Не расшифровывать',
};
export const LOCAL_MODELS = {
  'onnx-community/whisper-small': 'Обычная (≈250 МБ) — рекомендую',
  'onnx-community/whisper-base': 'Лёгкая (≈80 МБ) — быстрее, но ошибается чаще',
};
// языки, среди которых бот выбирает (чеченского и некоторых других языков в Whisper нет)
export const DEFAULT_LANGS = ['ru', 'ar', 'en', 'tr', 'kk', 'uz', 'ky', 'tt', 'az', 'tg', 'fr', 'de', 'id', 'ms', 'ur', 'fa', 'uk'];

const vcfg = () => ({ engine: 'local', model: 'onnx-community/whisper-small', languages: DEFAULT_LANGS, apiKey: '', ...(config().voice || {}) });

// ---------- звук → PCM 16 кГц моно ----------
function resample(x, from, to) {
  if (from === to) return x;
  const ratio = from / to, n = Math.floor(x.length / ratio), out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const a = Math.floor(i * ratio), b = Math.min(x.length, Math.floor((i + 1) * ratio));
    let s = 0; for (let j = a; j < b; j++) s += x[j];
    out[i] = s / Math.max(1, b - a);
  }
  return out;
}
function mixdown(channels) {
  if (channels.length === 1) return channels[0];
  const out = new Float32Array(channels[0].length);
  for (const ch of channels) for (let i = 0; i < out.length; i++) out[i] += ch[i] / channels.length;
  return out;
}
function parseWav(buf) {
  let p = 12, fmt = null;
  while (p + 8 <= buf.length) {
    const id = buf.toString('ascii', p, p + 4), size = buf.readUInt32LE(p + 4), body = p + 8;
    if (id === 'fmt ') fmt = { format: buf.readUInt16LE(body), channels: buf.readUInt16LE(body + 2), rate: buf.readUInt32LE(body + 4), bits: buf.readUInt16LE(body + 14) };
    if (id === 'data' && fmt) {
      const n = Math.floor(size / (fmt.bits / 8) / fmt.channels);
      const chans = Array.from({ length: fmt.channels }, () => new Float32Array(n));
      for (let i = 0; i < n; i++) for (let c = 0; c < fmt.channels; c++) {
        const o = body + (i * fmt.channels + c) * (fmt.bits / 8);
        chans[c][i] = fmt.format === 3 ? buf.readFloatLE(o) : fmt.bits === 16 ? buf.readInt16LE(o) / 32768 : fmt.bits === 32 ? buf.readInt32LE(o) / 2147483648 : (buf[o] - 128) / 128;
      }
      return resample(mixdown(chans), fmt.rate, 16000);
    }
    p = body + size + (size % 2);
  }
  throw new Error('не удалось прочитать WAV');
}
function findBin(name) {
  for (const d of [...(process.env.PATH || '').split(path.delimiter), '/opt/homebrew/bin', '/usr/local/bin']) {
    for (const e of process.platform === 'win32' ? ['.exe', ''] : ['']) { const f = path.join(d, name + e); try { if (fs.statSync(f).isFile()) return f; } catch {} }
  }
  return null;
}
function run(bin, args) {
  return new Promise((resolve, reject) => {
    const c = spawn(bin, args, { windowsHide: true });
    const out = []; let err = '';
    c.stdout.on('data', (d) => out.push(d)); c.stderr.on('data', (d) => { err += d; });
    c.on('error', reject);
    c.on('close', (code) => (code === 0 ? resolve(Buffer.concat(out)) : reject(new Error(err.slice(-300) || `код ${code}`))));
  });
}

/** Любое голосовое → Float32Array 16 кГц. OGG/Opus (WhatsApp, Telegram) и WAV — сами; остальное — через ffmpeg или, на Mac, afconvert. */
export async function decodeAudio(file) {
  const buf = fs.readFileSync(file);
  const head = buf.toString('ascii', 0, 4);
  if (head === 'OggS') {
    const { OggOpusDecoder } = await import('ogg-opus-decoder');
    const d = new OggOpusDecoder();
    await d.ready;
    try {
      const r = await d.decodeFile(new Uint8Array(buf));
      if (!r.samplesDecoded) throw new Error('пустое аудио');
      return resample(mixdown(r.channelData), r.sampleRate, 16000);
    } finally { d.free(); }
  }
  if (head === 'RIFF') return parseWav(buf);
  const ffmpeg = findBin('ffmpeg');
  if (ffmpeg) {
    const raw = await run(ffmpeg, ['-v', 'error', '-i', file, '-f', 'f32le', '-ac', '1', '-ar', '16000', '-']);
    return new Float32Array(raw.buffer, raw.byteOffset, Math.floor(raw.length / 4));
  }
  if (process.platform === 'darwin') {
    const tmp = path.join(os.tmpdir(), `wakil-${Date.now()}-${Math.random().toString(36).slice(2)}.wav`);
    try { await run('/usr/bin/afconvert', ['-f', 'WAVE', '-d', 'LEF32@16000', '-c', '1', file, tmp]); return parseWav(fs.readFileSync(tmp)); }
    finally { fs.rm(tmp, { force: true }, () => {}); }
  }
  throw new Error('этот формат аудио (mp4/m4a/mp3) можно расшифровать только с программой ffmpeg — или выберите расшифровку в облаке');
}

// ---------- Whisper на компьютере ----------
let local = null;          // Promise<{ asr, langIds, gc, LogitsProcessor, LogitsProcessorList }>
let localModel = '';
let state = { loading: false, ready: false, error: '' };
let queue = Promise.resolve();

async function loadLocal() {
  const model = vcfg().model;
  if (local && localModel === model) return local;
  localModel = model;
  state = { loading: true, ready: false, error: '' };
  local = (async () => {
    const t = await import('@huggingface/transformers');
    t.env.cacheDir = paths.models;
    t.env.allowLocalModels = false;
    log('Голосовые: загружаю модель распознавания', model, '(первый раз — скачивание ≈250 МБ)…');
    const asr = await t.pipeline('automatic-speech-recognition', model, { dtype: 'q8' });
    const gc = asr.model.generation_config;
    state = { loading: false, ready: true, error: '' };
    log('Голосовые: модель готова');
    return { asr, gc, LogitsProcessor: t.LogitsProcessor, LogitsProcessorList: t.LogitsProcessorList };
  })();
  local.catch((e) => { state = { loading: false, ready: false, error: e.message }; local = null; log('Голосовые: модель не загрузилась —', e.message); });
  return local;
}

async function detectLanguage(m, audio) {
  const langs = (vcfg().languages || DEFAULT_LANGS).filter((l) => m.gc.lang_to_id?.[`<|${l}|>`] != null);
  if (langs.length <= 1) return langs[0] || 'ru';
  const ids = new Map(langs.map((l) => [m.gc.lang_to_id[`<|${l}|>`], l]));
  class OnlyLanguages extends m.LogitsProcessor {
    _call(inputIds, logits) {
      for (let i = 0; i < inputIds.length; i++) { const d = logits[i].data; for (let t = 0; t < d.length; t++) if (!ids.has(t)) d[t] = -Infinity; }
      return logits;
    }
  }
  const { input_features } = await m.asr.processor(audio.slice(0, 16000 * 30));
  const lp = new m.LogitsProcessorList(); lp.push(new OnlyLanguages());
  const out = await m.asr.model.generate({ inputs: input_features, decoder_input_ids: [m.gc.decoder_start_token_id], max_new_tokens: 1, logits_processor: lp });
  const seq = out.tolist ? out.tolist()[0] : out[0];
  return ids.get(Number(seq[seq.length - 1])) || langs[0];
}

async function transcribeLocal(file) {
  const m = await loadLocal();
  let audio = await decodeAudio(file);
  if (audio.length > 16000 * 600) audio = audio.slice(0, 16000 * 600); // не больше 10 минут
  if (audio.length < 16000 * 0.3) return { text: '', lang: '' };
  const lang = await detectLanguage(m, audio);
  const r = await m.asr(audio, { chunk_length_s: 30, stride_length_s: 5, language: lang, task: 'transcribe' });
  return { text: String(r.text || '').trim(), lang };
}

async function transcribeApi(file, mime, engine) {
  const c = vcfg();
  const key = c.apiKey;
  if (!key) throw new Error('не указан ключ для расшифровки');
  const url = engine === 'groq' ? 'https://api.groq.com/openai/v1/audio/transcriptions' : 'https://api.openai.com/v1/audio/transcriptions';
  const fd = new FormData();
  fd.append('model', engine === 'groq' ? 'whisper-large-v3-turbo' : 'whisper-1');
  let name = path.basename(file);
  if (!/\.(ogg|oga|opus|mp3|mp4|m4a|wav|webm|flac|mpeg|mpga)$/i.test(name)) name += /ogg|opus/.test(mime || '') || fs.readFileSync(file).toString('ascii', 0, 4) === 'OggS' ? '.ogg' : '.mp4';
  fd.append('file', new Blob([fs.readFileSync(file)], { type: mime || 'audio/ogg' }), name);
  const r = await fetch(url, { method: 'POST', headers: { authorization: `Bearer ${key}` }, body: fd, signal: AbortSignal.timeout(180000) });
  const body = await r.text();
  if (!r.ok) throw new Error(`${engine}: ${r.status} ${body.slice(0, 200)}`);
  return { text: String(JSON.parse(body).text || '').trim(), lang: '' };
}

/** Расшифровать голосовое. Возвращает { ok, text, lang } или { ok:false, error }. Одновременно — по одному. */
export function transcribe(file, mime = '') {
  const engine = vcfg().engine;
  if (engine === 'off') return Promise.resolve({ ok: false, error: 'расшифровка выключена' });
  const job = queue.then(async () => {
    const t = Date.now();
    try {
      const r = engine === 'local' ? await transcribeLocal(file) : await transcribeApi(file, mime, engine);
      log(`Голосовое расшифровано (${engine}, ${r.lang || '?'}, ${((Date.now() - t) / 1000).toFixed(1)} с)`);
      return { ok: true, ...r };
    } catch (e) {
      log('Голосовое не расшифровано:', e.message);
      return { ok: false, error: e.message };
    }
  });
  queue = job.catch(() => {});
  return job;
}

/** Заранее загрузить модель, чтобы первое голосовое клиента не ждало скачивания. */
export function preloadVoice() {
  if (vcfg().engine === 'local') loadLocal().catch(() => {});
}
export function voiceStatus() {
  const c = vcfg();
  return { engine: c.engine, model: c.model, ...(c.engine === 'local' ? state : { ready: !!c.apiKey, loading: false, error: c.apiKey ? '' : 'нет ключа' }) };
}

// для проверок: подменить расшифровку
let mockFn = null;
export function setMockVoice(fn) { mockFn = fn; }
export async function transcribeAny(file, mime) { return mockFn ? mockFn(file, mime) : transcribe(file, mime); }
