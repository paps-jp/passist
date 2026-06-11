'use strict';
// PAssist 公開統計コレクタ。個人を特定する情報は記録しない（IP/token/UAは保存しない）。
// 直近24h のイベント数とリアルタイム値（現在のセッション/視聴人数）だけを保持し、
// 1分ごとにディスクへ永続化する（プロセス再起動で全消えを防ぐ）。
// 既存の server.js とは完全独立で、`require('./stats')` してフックを呼ぶだけ。

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'stats.json');
const WINDOW_MS = 24 * 60 * 60 * 1000;       // 直近24時間のローリング窓
const FLUSH_MS = 60 * 1000;                  // 1分ごとに永続化
const KEEP_DAILY_DAYS = 30;                  // 日次サマリは30日保持

// メモリ上の状態
const state = {
  startedAt: Date.now(),
  events: [],            // [{ ts, kind, meta }]
  liveSessions: 0,       // いま開かれているセッション数
  liveViewers: 0,        // いま接続中の viewer 総数
  liveRelays: 0,         // いま TURN 経由になっている viewer 総数
  daily: {},             // 'YYYY-MM-DD' -> { sessions, viewersAccepted, viewersDenied, relayPeers, p2pPeers, totalSeconds }
};

function dayKey(ts) {
  const d = new Date(ts);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function ensureDay(ts) {
  const k = dayKey(ts);
  if (!state.daily[k]) state.daily[k] = { sessions: 0, viewersAccepted: 0, viewersDenied: 0, relayPeers: 0, p2pPeers: 0, totalSeconds: 0 };
  return state.daily[k];
}
function pruneOldDays() {
  const keys = Object.keys(state.daily).sort();
  while (keys.length > KEEP_DAILY_DAYS) delete state.daily[keys.shift()];
}

// 起動時に永続化ファイルを読み戻す（あれば）
try {
  if (fs.existsSync(FILE)) {
    const j = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (j && typeof j === 'object') {
      if (Array.isArray(j.events)) state.events = j.events.filter((e) => Date.now() - e.ts < WINDOW_MS);
      if (j.daily) state.daily = j.daily;
    }
  }
} catch (e) { console.warn('[stats] load failed', e.message); }

function push(kind, meta) {
  const ts = Date.now();
  state.events.push({ ts, kind, meta: meta || null });
  // 窓外をドロップ（線形だが1日でも数千イベントなので軽い）
  const cutoff = ts - WINDOW_MS;
  while (state.events.length && state.events[0].ts < cutoff) state.events.shift();
}

// --- 公開イベント API（server.js から呼ぶ） ---
function event(kind, meta) {
  const ts = Date.now();
  switch (kind) {
    case 'session_created':
      state.liveSessions++;
      ensureDay(ts).sessions++;
      push(kind, meta);
      break;
    case 'session_closed':
    case 'session_expired':
      state.liveSessions = Math.max(0, state.liveSessions - 1);
      if (meta && Number.isFinite(meta.durationSec)) ensureDay(ts).totalSeconds += Math.max(0, meta.durationSec);
      push(kind, meta);
      break;
    case 'viewer_accepted':
      state.liveViewers++;
      ensureDay(ts).viewersAccepted++;
      push(kind, meta);
      break;
    case 'viewer_denied':
      ensureDay(ts).viewersDenied++;
      push(kind, meta);
      break;
    case 'viewer_left':
      state.liveViewers = Math.max(0, state.liveViewers - 1);
      push(kind, meta);
      break;
    case 'peer_route':
      // meta: { via: 'relay'|'p2p', prev: 'relay'|'p2p'|null }
      if (meta && meta.via === 'relay' && meta.prev !== 'relay') {
        state.liveRelays++;
        ensureDay(ts).relayPeers++;
      } else if (meta && meta.via === 'p2p' && meta.prev === 'relay') {
        state.liveRelays = Math.max(0, state.liveRelays - 1);
      } else if (meta && meta.via === 'p2p' && meta.prev !== 'p2p') {
        ensureDay(ts).p2pPeers++;
      }
      push(kind, meta);
      break;
    default:
      push(kind, meta);
  }
}

// --- 公開: ダッシュボード用スナップショット ---
function snapshot() {
  pruneOldDays();
  const now = Date.now();
  const last24h = state.events;
  const count = (k) => last24h.filter((e) => e.kind === k).length;
  const sessionsLast24h = count('session_created');
  const acceptedLast24h = count('viewer_accepted');
  const deniedLast24h = count('viewer_denied');
  const relayLast24h = last24h.filter((e) => e.kind === 'peer_route' && e.meta && e.meta.via === 'relay' && e.meta.prev !== 'relay').length;
  const p2pLast24h = last24h.filter((e) => e.kind === 'peer_route' && e.meta && e.meta.via === 'p2p' && e.meta.prev !== 'p2p').length;
  const turnRatio = acceptedLast24h > 0 ? relayLast24h / acceptedLast24h : 0;
  const successRatio = (acceptedLast24h + deniedLast24h) > 0 ? acceptedLast24h / (acceptedLast24h + deniedLast24h) : 1;
  return {
    asOf: now,
    uptimeSec: Math.floor((now - state.startedAt) / 1000),
    live: { sessions: state.liveSessions, viewers: state.liveViewers, relays: state.liveRelays },
    last24h: {
      sessions: sessionsLast24h,
      viewersAccepted: acceptedLast24h,
      viewersDenied: deniedLast24h,
      peerP2P: p2pLast24h,
      peerRelay: relayLast24h,
      turnRatio: Math.round(turnRatio * 10000) / 100,         // %
      acceptRatio: Math.round(successRatio * 10000) / 100,    // %
    },
    daily: state.daily, // 30日分の日次サマリ
  };
}

// --- 永続化 ---
function flush() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    pruneOldDays();
    fs.writeFileSync(FILE, JSON.stringify({ events: state.events, daily: state.daily }, null, 0));
  } catch (e) { console.warn('[stats] flush failed', e.message); }
}
setInterval(flush, FLUSH_MS).unref();
process.on('SIGTERM', flush);
process.on('SIGINT', () => { flush(); process.exit(0); });

module.exports = { event, snapshot, flush };
