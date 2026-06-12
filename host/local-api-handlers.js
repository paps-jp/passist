'use strict';
// Local HTTP API のエンドポイント実装 (Phase 1 MVP)。
// Phase 1 は最小 4 つ: list_windows / share_start / share_status / share_end。
// Phase 2 以降で switch_window, set_access_mode, approve_pending_viewer 等を追加。
//
// 各 handler は (req, res, ctx) を受け取る:
//   ctx = { sendToRenderer(ch, payload), waitFromRenderer(ch, timeoutMs), getWindowList(), ... }
// renderer の状態 (現在の共有 URL・ピッカー結果等) は IPC で取りに行く。

function send(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

async function listWindows(_req, res, ctx) {
  try {
    const wins = await ctx.getWindowList();
    // 大きいので thumbnail は除外。 必要なら別エンドポイントを将来追加。
    const slim = wins.map((w) => ({
      id: w.id,
      title: w.name,
      app: w.ownerName || null,
      owned: !!w.owned,
    }));
    return send(res, 200, { windows: slim });
  } catch (e) {
    return send(res, 500, { error: { code: 'INTERNAL', message: e.message } });
  }
}

async function shareStart(req, res, ctx) {
  let body;
  try {
    body = JSON.parse(req.rawBody || '{}');
  } catch {
    return send(res, 422, { error: { code: 'VALIDATION', message: 'invalid JSON' } });
  }
  const { windowId, titleMatch, accessMode, maxViewers, ttlMinutes, readonly } = body;
  if (!windowId && !titleMatch) {
    return send(res, 422, { error: { code: 'VALIDATION', message: 'windowId or titleMatch required' } });
  }
  // 現在の共有状態を確認 (二重起動防止)
  try {
    const cur = await ctx.getShareState();
    if (cur && cur.active) {
      return send(res, 409, {
        error: { code: 'ALREADY_SHARING', message: 'session already active; use switch_window', currentWindow: cur.sharedWindow },
      });
    }
  } catch {}
  // ウィンドウ解決 (id + name の両方を取得)
  let target;
  try {
    const wins = await ctx.getWindowList();
    if (!windowId) {
      const q = String(titleMatch).toLowerCase();
      const matches = wins.filter((w) => (w.name || '').toLowerCase().includes(q));
      if (matches.length === 0) return send(res, 400, { error: { code: 'WINDOW_NOT_FOUND', message: `no window matches "${titleMatch}"` } });
      if (matches.length > 1) return send(res, 409, { error: { code: 'AMBIGUOUS_WINDOW', message: `${matches.length} windows match`, candidates: matches.map((w) => w.name) } });
      target = matches[0];
    } else {
      target = wins.find((w) => w.id === windowId);
      if (!target) return send(res, 400, { error: { code: 'WINDOW_NOT_FOUND', message: `windowId ${windowId} not found` } });
    }
  } catch (e) {
    return send(res, 500, { error: { code: 'INTERNAL', message: e.message } });
  }
  // renderer へ共有開始指示
  try {
    const result = await ctx.startShareForRenderer({
      windowId: target.id,
      windowName: target.name,
      accessMode: accessMode || undefined,
      maxViewers: maxViewers || undefined,
      ttlMinutes: ttlMinutes !== undefined ? ttlMinutes : undefined,
      readonly: !!readonly,
    });
    if (!result || result.error) return send(res, 500, { error: { code: 'INTERNAL', message: result && result.error || 'startShare returned no result' } });
    return send(res, 200, result);
  } catch (e) {
    return send(res, 500, { error: { code: 'INTERNAL', message: e.message } });
  }
}

async function shareStatus(_req, res, ctx) {
  try {
    const st = await ctx.getShareState();
    return send(res, 200, st || { active: false });
  } catch (e) {
    return send(res, 500, { error: { code: 'INTERNAL', message: e.message } });
  }
}

async function shareEnd(_req, res, ctx) {
  try {
    const cur = await ctx.getShareState();
    if (!cur || !cur.active) return send(res, 404, { error: { code: 'NO_ACTIVE_SHARE', message: 'no active session' } });
    await ctx.endShareFromRenderer();
    return send(res, 200, { ok: true });
  } catch (e) {
    return send(res, 500, { error: { code: 'INTERNAL', message: e.message } });
  }
}

module.exports = { listWindows, shareStart, shareStatus, shareEnd };
