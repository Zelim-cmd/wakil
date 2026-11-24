// Адрес в интернете для вебхуков Meta. Если в «Подключениях» вписан адрес ngrok и ngrok установлен,
// Вакиль сам запускает его и перезапускает при сбое — вторую программу держать открытой не нужно.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { config, log } from './config.mjs';

let child = null;
let wantUrl = '';
let state = { running: false, error: '' };
let retry = 0;
let domainFlag = false; // старые версии ngrok знают --domain вместо --url

function findNgrok() {
  const win = process.platform === 'win32';
  const dirs = [...(process.env.PATH || '').split(path.delimiter), '/opt/homebrew/bin', '/usr/local/bin', path.join(os.homedir(), 'bin'), path.join(os.homedir(), '.local', 'bin')];
  for (const d of dirs) for (const e of win ? ['.exe', ''] : ['']) {
    const p = path.join(d, 'ngrok' + e);
    try { if (fs.statSync(p).isFile()) return p; } catch {}
  }
  return null;
}

export function syncTunnel() {
  const cfg = config().panel;
  const url = String(cfg.publicUrl || '').trim().replace(/\/+$/, '');
  const should = cfg.autoTunnel !== false && /^https:\/\/[\w.-]+\.ngrok(-free)?\.(app|dev|io)$/i.test(url);
  if (!should) { stop(); state = { running: false, error: '' }; return; }
  if (child && wantUrl === url) return;
  stop();
  wantUrl = url;
  start();
}

function start() {
  const bin = findNgrok();
  if (!bin) { state = { running: false, error: 'ngrok не установлен — см. docs/ngrok.md' }; return; }
  const port = String(config().panel.webhookPort);
  const where = domainFlag ? `--domain=${wantUrl.replace(/^https:\/\//, '')}` : `--url=${wantUrl}`;
  const c = spawn(bin, ['http', port, where, '--log=stdout', '--log-format=json'], { windowsHide: true });
  child = c;
  state = { running: true, error: '' };
  let tail = '';
  c.stdout.on('data', (d) => {
    tail = (tail + d).slice(-2000);
    if (/"lvl":"(eror|crit)"/.test(String(d))) { const m = /"err":"([^"]+)"/.exec(String(d)); if (m) state.error = m[1].slice(0, 300); }
    if (/started tunnel|"msg":"started tunnel"/.test(String(d))) { retry = 0; state.error = ''; log('ngrok: адрес работает', wantUrl); }
  });
  c.stderr.on('data', (d) => { tail = (tail + d).slice(-2000); });
  c.on('error', (e) => { state = { running: false, error: e.message }; });
  c.on('exit', (code) => {
    if (child !== c) return;
    child = null;
    state.running = false;
    if (!domainFlag && /unknown flag: --url/.test(tail)) { domainFlag = true; setTimeout(() => { if (!child && wantUrl) start(); }, 500); return; }
    if (!state.error) state.error = (tail.match(/ERR_NGROK_\d+[^"]*/) || [`ngrok остановился (код ${code})`])[0].slice(0, 300);
    log('ngrok:', state.error);
    const wait = Math.min(300000, 5000 * 2 ** Math.min(retry++, 6));
    setTimeout(() => { if (!child && wantUrl) start(); }, wait);
  });
}

export function stop() {
  wantUrl = '';
  const c = child; child = null;
  if (c) { try { c.kill(); } catch {} }
}

export function tunnelStatus() { return { ...state, url: wantUrl }; }
