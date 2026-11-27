/* CFSM data adapter for the unmodified Meridian status-page UI.
 * All display, theme, menu, motion and view code remains Meridian's; only its API contract is bridged.
 */
(() => {
  'use strict';

  const nativeFetch = window.fetch.bind(window);
  const contexts = new Map();
  const localToRemote = new Map();
  const remoteToLocal = new Map();
  const detailRequests = new Set();
  const liveQueue = [];
  const liveSeen = new Map();
  const MAX_LIVE = 12000;
  const gatePromises = new Map();
  let gateQueue = Promise.resolve();
  let activeGate = null;
  let turnstileLoader = null;
  let authNoticeShown = false;

  const safeRead = (key) => { try { return localStorage.getItem(key) || ''; } catch { return ''; } };
  const safeWrite = (key, value) => { try { localStorage.setItem(key, value); } catch {} };
  const safeRemove = (key) => { try { localStorage.removeItem(key); } catch {} };
  const number = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
  const finite = (v) => v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v));
  const asMs = (v) => { const n = number(v); return n > 0 && n < 1e12 ? n * 1000 : n; };
  const splitLoad = (v) => {
    if (Array.isArray(v)) return v.slice(0, 3).map(number);
    if (typeof v === 'string') return v.trim().split(/[ ,]+/).slice(0, 3).map(number);
    return [];
  };
  const response = (data, status = 200) => new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
  });

  function apiBases() {
    const raw = document.querySelector('meta[name="apiBase"]')?.content?.trim() || '';
    const entries = raw ? raw.split(',').map((x) => x.trim()).filter(Boolean) : [location.origin];
    const list = [];
    for (const value of entries) {
      try {
        const u = new URL(value, location.href);
        if (!['http:', 'https:'].includes(u.protocol)) continue;
        const base = u.origin;
        if (!list.includes(base)) list.push(base);
      } catch {}
    }
    return list.length ? list : [location.origin];
  }

  function context(base) {
    if (!contexts.has(base)) contexts.set(base, {
      base, config: null, servers: [], stats: {}, sysConfig: {}, verified: '', hasSnapshot: false,
      sockets: [], reconnects: [], socketKey: '', retry: 0, userStopped: false,
      timeoutTimers: [], error: '', snapshotPromise: null, needsSnapshot: false
    });
    return contexts.get(base);
  }

  function verifiedFor(ctx) {
    if (ctx.verified && ctx.verifiedUntil > Date.now()) return ctx.verified;
    try {
      const all = JSON.parse(safeRead('cfsm_theme_turnstile') || '{}');
      const saved = all[ctx.base];
      if (saved?.token && Date.now() - Number(saved.savedAt) < 55 * 60 * 1000) {
        ctx.verified = saved.token;
        ctx.verifiedUntil = Number(saved.savedAt) + 55 * 60 * 1000;
        return ctx.verified;
      }
    } catch {}
    if (ctx.base === location.origin) {
      const legacy = safeRead('turnstile_verified');
      if (legacy) return legacy;
    }
    return '';
  }

  function saveVerified(ctx, token) {
    ctx.verified = token;
    ctx.verifiedUntil = Date.now() + 55 * 60 * 1000;
    if (ctx.base === location.origin) safeWrite('turnstile_verified', token);
    try {
      const all = JSON.parse(safeRead('cfsm_theme_turnstile') || '{}');
      all[ctx.base] = { token, savedAt: Date.now() };
      safeWrite('cfsm_theme_turnstile', JSON.stringify(all));
    } catch {}
  }

  function clearVerified(ctx) {
    ctx.verified = '';
    ctx.verifiedUntil = 0;
    try {
      const all = JSON.parse(safeRead('cfsm_theme_turnstile') || '{}');
      delete all[ctx.base];
      safeWrite('cfsm_theme_turnstile', JSON.stringify(all));
    } catch {}
    if (ctx.base === location.origin) safeRemove('turnstile_verified');
  }

  async function rawRequest(ctx, path, init = {}, turnstileToken = '') {
    const url = new URL(path, ctx.base);
    const headers = new Headers(init.headers || {});
    headers.set('Accept', 'application/json');
    const jwt = safeRead('jwt_token');
    if (jwt) headers.set('Authorization', `Bearer ${jwt}`);
    const verified = verifiedFor(ctx);
    if (verified) headers.set('X-Turnstile-Verified', verified);
    if (turnstileToken) headers.set('X-Turnstile-Token', turnstileToken);
    if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
    const res = await nativeFetch(url.toString(), {
      ...init, headers, credentials: 'include', cache: 'no-store'
    });
    return res;
  }

  async function readResponse(res) {
    const text = await res.text();
    let data = null;
    if (text) {
      try { data = JSON.parse(text); } catch { data = { message: text.slice(0, 300) }; }
    }
    return { data, text };
  }

  function gateElement() {
    let el = document.getElementById('cfsm-human-gate');
    if (el) return el;
    el = document.createElement('div');
    el.id = 'cfsm-human-gate';
    el.className = 'cfsm-human-gate';
    el.hidden = true;
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-modal', 'true');
    el.setAttribute('aria-labelledby', 'cfsm-human-title');
    el.innerHTML = '<div class="cfsm-human-card"><strong id="cfsm-human-title">Verification required</strong><p id="cfsm-human-copy"></p><div id="cfsm-human-widget"></div><button type="button" id="cfsm-human-cancel">Close</button></div>';
    document.body.append(el);
    el.querySelector('#cfsm-human-cancel').addEventListener('click', () => {
      el.hidden = true;
      const gate = activeGate;
      activeGate = null;
      gate?.reject(new Error('Turnstile verification was closed.'));
    });
    return el;
  }

  function loadTurnstile() {
    if (window.turnstile) return Promise.resolve();
    if (turnstileLoader) return turnstileLoader;
    turnstileLoader = new Promise((resolve, reject) => {
      const prior = document.querySelector('script[data-cfsm-turnstile]');
      if (prior) {
        prior.addEventListener('load', resolve, { once: true });
        prior.addEventListener('error', reject, { once: true });
        return;
      }
      const script = document.createElement('script');
      script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
      script.async = true;
      script.defer = true;
      script.dataset.cfsmTurnstile = 'true';
      script.onload = resolve;
      script.onerror = () => reject(new Error('Cloudflare Turnstile could not be loaded.'));
      document.head.append(script);
    });
    return turnstileLoader;
  }

  function acquireTurnstile(ctx) {
    if (gatePromises.has(ctx.base)) return gatePromises.get(ctx.base);
    const task = gateQueue.then(() => showTurnstileGate(ctx));
    gatePromises.set(ctx.base, task);
    gateQueue = task.then(() => undefined, () => undefined);
    return task.finally(() => {
      if (gatePromises.get(ctx.base) === task) gatePromises.delete(ctx.base);
    });
  }

  function showTurnstileGate(ctx) {
    const el = gateElement();
    const copy = el.querySelector('#cfsm-human-copy');
    const widget = el.querySelector('#cfsm-human-widget');
    copy.textContent = `${ctx.base} requires a human verification before it can return monitor data.`;
    widget.replaceChildren();
    el.hidden = false;
    return new Promise((resolve, reject) => {
      const gate = { ctx, resolve, reject };
      activeGate = gate;
      loadTurnstile().then(() => {
        if (activeGate !== gate) return;
        if (!window.turnstile) throw new Error('Turnstile is unavailable.');
        window.turnstile.render(widget, {
          sitekey: ctx.config?.turnstile_site_key,
          callback: async (token) => {
            try {
              const res = await rawRequest(ctx, '/api/config', {}, token);
              const { data } = await readResponse(res);
              if (!res.ok) throw new Error(data?.error || data?.message || `HTTP ${res.status}`);
              const verified = data?.turnstile_verified;
              if (!verified) throw new Error('The Worker did not return a reusable verification credential.');
              ctx.config = data;
              saveVerified(ctx, verified);
              if (activeGate === gate) activeGate = null;
              el.hidden = true;
              resolve(verified);
            } catch (err) {
              copy.textContent = `Verification failed: ${err.message || err}. Please try again.`;
              try { window.turnstile.reset(); } catch {}
            }
          },
          'expired-callback': () => clearVerified(ctx),
          'error-callback': () => { copy.textContent = 'Turnstile failed to load. Check the site CSP and network access.'; }
        });
      }).catch((err) => {
        copy.textContent = err.message || 'Turnstile failed to start.';
        if (activeGate === gate) activeGate = null;
        el.hidden = true;
        reject(err);
      });
    });
  }

  async function requestJson(ctx, path, init = {}, allowTurnstile = true) {
    let res = await rawRequest(ctx, path, init);
    if (res.status === 403 && allowTurnstile && ctx.config?.turnstile_enabled && ctx.config?.turnstile_site_key) {
      await acquireTurnstile(ctx);
      res = await rawRequest(ctx, path, init);
    }
    const { data } = await readResponse(res);
    if (!res.ok) {
      if (res.status === 401) showAdminSignIn(ctx);
      if (res.status === 403 && ctx.config?.turnstile_enabled) clearVerified(ctx);
      const err = new Error(data?.error || data?.message || `HTTP ${res.status}`);
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }

  function showAdminSignIn(ctx) {
    if (authNoticeShown) return;
    authNoticeShown = true;
    const apply = () => {
      const form = document.getElementById('loginForm');
      form?.classList.add('hidden');
      const gate = document.getElementById('gateText');
      if (gate) gate.textContent = 'This CFSM site requires authentication. Sign in through its built-in admin panel, then reload this page.';
      const title = document.getElementById('hSignin');
      if (title) title.textContent = 'CFSM sign-in required';
      const host = document.querySelector('#v-signin .gate');
      if (host && !document.getElementById('cfsm-admin-signin')) {
        const link = document.createElement('a');
        link.id = 'cfsm-admin-signin';
        link.className = 'btn primary';
        link.href = new URL('/admin#/admin', ctx.base).toString();
        link.textContent = 'Open CFSM sign-in';
        host.append(link);
      }
    };
    apply();
    const view = document.getElementById('v-signin');
    if (view && !view.dataset.cfsmAuthObserver) {
      view.dataset.cfsmAuthObserver = 'true';
      new MutationObserver(apply).observe(view, { childList: true, subtree: true });
    }
  }

  function hashId(base, remoteId) {
    const key = `${base}\u0000${remoteId}`;
    if (remoteToLocal.has(key)) return remoteToLocal.get(key);
    let h = 2166136261;
    for (let i = 0; i < key.length; i++) { h ^= key.charCodeAt(i); h = Math.imul(h, 16777619); }
    let id = (h >>> 0) % 2147483646 + 1;
    while (localToRemote.has(id) && localToRemote.get(id).key !== key) id = id % 2147483646 + 1;
    const info = { key, base, remoteId: String(remoteId) };
    localToRemote.set(id, info);
    remoteToLocal.set(key, id);
    return id;
  }

  function mapServer(ctx, src) {
    const id = hashId(ctx.base, src.id);
    const updated = asMs(src.last_updated || src.timestamp || src.updated_at);
    const online = typeof src.is_online === 'boolean' ? src.is_online : updated > 0 && Date.now() - updated <= 5 * 60 * 1000;
    const ramTotal = number(src.ram_total);
    const ramUsed = number(src.ram_used);
    const diskTotal = number(src.disk_total);
    const diskUsed = number(src.disk_used);
    const toBytes = (v) => number(v) * 1024 * 1024;
    const boot = asMs(src.boot_time);
    const load = splitLoad(src.load_avg);
    const geo = window.CFSMGeo?.resolveEgressLocation(src) || null;
    const server = {
      id,
      name: String(src.name || 'Unnamed server'),
      cc: geo?.cc || '',
      city: geo?.city || '',
      ...(geo ? { loc: geo.loc, approx: true } : {}),
      online,
      since: updated ? Math.floor(updated / 1000) : 0,
      availability: null,
      speed: { up: number(src.net_out_speed), down: number(src.net_in_speed) },
      sys: {
        cpu: number(src.cpu),
        mem: ramTotal > 0 ? ramUsed * 100 / ramTotal : 0,
        disk: diskTotal > 0 ? diskUsed * 100 / diskTotal : 0,
        uptime: boot ? Math.max(0, Math.floor(Date.now() / 1000 - boot / 1000)) : 0,
        ...(boot ? { booted: Math.floor(boot / 1000) } : {}),
        cores: number(src.cpu_cores),
        ...(load.length ? { load: [load[0] || 0, load[1] || 0, load[2] || 0] } : {}),
        mem_used: toBytes(ramUsed),
        mem_total: toBytes(ramTotal),
        swap_used: toBytes(src.swap_used),
        swap_total: toBytes(src.swap_total),
        disk_used: toBytes(diskUsed),
        disk_total: toBytes(diskTotal),
        tcp: number(src.tcp_conn),
        udp: number(src.udp_conn)
      },
      host: {
        os: String(src.os || ''),
        kernel: String(src.kernel_version || ''),
        arch: String(src.arch || ''),
        cpu: String(src.cpu_info || ''),
        cores: number(src.cpu_cores),
        mem: toBytes(ramTotal),
        disk: toBytes(diskTotal)
      },
      expires: src.expire_date ? String(src.expire_date).slice(0, 10) : undefined,
      _cfsmBase: ctx.base,
      _cfsmId: String(src.id)
    };
    const owner = localToRemote.get(id);
    if (owner) owner.server = server;
    return server;
  }

  function daysNone() { return []; }
  function localDayKey(ts) {
    const d = new Date(Number(ts) * 1000);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  function localMidnight(ts) {
    const d = new Date(Number(ts) * 1000);
    d.setHours(0, 0, 0, 0);
    return Math.floor(d.getTime() / 1000);
  }

  function recentLocalDays(ts) {
    const today = new Date(Number(ts) * 1000);
    today.setHours(0, 0, 0, 0);
    return Array.from({ length: 7 }, (_, index) => {
      const day = new Date(today);
      day.setDate(day.getDate() - (6 - index));
      return localDayKey(day.getTime() / 1000);
    });
  }

  function intervalAvailability(records, start, end) {
    if (!(end > start)) return null;
    const rows = records.filter((row) => Number.isFinite(row.t) && row.t <= end)
      .sort((a, b) => a.t - b.t);
    let index = -1;
    for (let i = 0; i < rows.length; i++) if (rows[i].t <= start) index = i;
    if (index < 0) return null;
    let online = rows[index].is_online === 1;
    let cursor = start;
    let up = 0;
    let down = 0;
    for (let i = index + 1; i < rows.length; i++) {
      const at = Math.max(start, Math.min(end, rows[i].t));
      if (at > cursor) { if (online) up += at - cursor; else down += at - cursor; }
      cursor = at;
      online = rows[i].is_online === 1;
      if (cursor >= end) break;
    }
    if (cursor < end) { if (online) up += end - cursor; else down += end - cursor; }
    const total = up + down;
    return total > 0 ? { ratio: up / total * 100, downMinutes: Math.round(down / 60) } : null;
  }

  function calculateAvailability(records, generatedAt, windowStart) {
    const end = Number(generatedAt);
    const start = Number(windowStart);
    if (!Number.isFinite(end) || !Number.isFinite(start) || !(end > start)) {
      return { h24: null, d30: null, days: [], down: [] };
    }
    const today = new Date(end * 1000);
    today.setHours(0, 0, 0, 0);
    const days = [];
    for (let i = 6; i >= 0; i--) {
      const dayStartDate = new Date(today);
      dayStartDate.setDate(dayStartDate.getDate() - i);
      const nextDayDate = new Date(dayStartDate);
      nextDayDate.setDate(nextDayDate.getDate() + 1);
      const dayStart = Math.floor(dayStartDate.getTime() / 1000);
      const nextDay = Math.floor(nextDayDate.getTime() / 1000);
      days.push({ key: localDayKey(dayStart), start: Math.max(start, dayStart), end: Math.min(end, nextDay) });
    }
    const week = intervalAvailability(records, start, end);
    const h24 = intervalAvailability(records, Math.max(start, end - 86400), end);
    const perDay = days.map((day) => intervalAvailability(records, day.start, day.end));
    return {
      h24: h24?.ratio ?? null,
      d30: week?.ratio ?? null,
      days: perDay.map((item) => item?.ratio ?? null),
      down: perDay.map((item) => item?.downMinutes ?? null)
    };
  }

  function buildStatusHistory(records, generatedAt, windowStart, serverId, localServerId = Number(serverId)) {
    const rows = (Array.isArray(records) ? records : []).filter((row) =>
      String(row.server_id) === String(serverId)
      && (row.event_type === 'baseline' || row.event_type === 'transition')
      && (row.is_online === 0 || row.is_online === 1)
      && Number.isFinite(Number(row.t))
    ).map((row) => ({ ...row, t: Number(row.t), is_online: Number(row.is_online) }))
      .sort((a, b) => a.t - b.t);
    return {
      availability: calculateAvailability(rows, generatedAt, windowStart),
      events: rows.filter((row) => row.event_type === 'transition'
        && row.t >= Number(windowStart) && row.t <= Number(generatedAt)).map((row) => ({
        server_id: Number(localServerId), t: row.t, kind: row.is_online === 0 ? 'offline' : 'online'
      }))
    };
  }

  // Kept public for deterministic adapter tests; no UI behavior is changed by this export.
  window.CFSMStatusHistory = { calculateAvailability, buildStatusHistory };

  async function fetchSnapshot(ctx, force = false) {
    if (!force && ctx.hasSnapshot) return { servers: ctx.servers, stats: ctx.stats, sysConfig: ctx.sysConfig };
    if (ctx.snapshotPromise) return ctx.snapshotPromise;
    const task = (async () => {
      if (!ctx.config) ctx.config = await requestJson(ctx, '/api/config', {}, false);
      const payload = await requestJson(ctx, '/api/servers');
      ctx.servers = Array.isArray(payload?.servers) ? payload.servers : [];
      ctx.stats = payload?.stats || {};
      ctx.sysConfig = payload?.sysConfig || {};
      ctx.hasSnapshot = true;
      ctx.error = '';
      return payload;
    })();
    ctx.snapshotPromise = task;
    try { return await task; }
    finally { if (ctx.snapshotPromise === task) ctx.snapshotPromise = null; }
  }

  async function fetchStatusHistory(ctx, remoteIds) {
    const rows = [];
    const generated = [];
    const starts = [];
    for (let offset = 0; offset < remoteIds.length; offset += 100) {
      const ids = remoteIds.slice(offset, offset + 100);
      try {
        const query = ids.map((id) => encodeURIComponent(String(id))).join(',');
        const payload = await requestJson(ctx, `/api/history/status?ids=${query}`);
        if (Array.isArray(payload?.records)) rows.push(...payload.records);
        if (finite(payload?.generated_at)) generated.push(Number(payload.generated_at));
        if (finite(payload?.window_start)) starts.push(Number(payload.window_start));
      } catch {
        // Status history is optional: a history failure must not block the live dashboard.
      }
    }
    return {
      records: rows,
      generatedAt: generated.length ? Math.max(...generated) : Math.floor(Date.now() / 1000),
      windowStart: starts.length ? Math.min(...starts) : Math.floor(Date.now() / 1000) - 7 * 86400
    };
  }

  async function loadStatusHistory(servers, active) {
    const allEvents = [];
    await Promise.all(active.map(async ({ ctx }) => {
      const localServers = servers.filter((server) => server._cfsmBase === ctx.base);
      if (!localServers.length) return;
      const history = await fetchStatusHistory(ctx, localServers.map((server) => server._cfsmId));
      for (const server of localServers) {
        const result = buildStatusHistory(history.records, history.generatedAt, history.windowStart, server._cfsmId, server.id);
        server.availability = result.availability;
        allEvents.push(...result.events);
      }
    }));
    return allEvents.sort((a, b) => b.t - a.t);
  }

  async function allSnapshots(force = false) {
    const list = apiBases().map(context);
    const results = await Promise.all(list.map(async (ctx) => {
      try { await fetchSnapshot(ctx, force); return { ctx, ok: true }; }
      catch (error) { ctx.error = error.message || String(error); return { ctx, ok: false, error }; }
    }));
    const ok = results.filter((x) => x.ok);
    if (!ok.length) {
      const first = results[0];
      throw first?.error || new Error('No CFSM API responded.');
    }
    const servers = ok.flatMap(({ ctx }) => ctx.servers.map((x) => mapServer(ctx, x)));
    const total = servers.length;
    const online = servers.filter((x) => x.online).length;
    const up = servers.reduce((sum, x) => sum + number(x.speed?.up), 0);
    const down = servers.reduce((sum, x) => sum + number(x.speed?.down), 0);
    const primary = ok[0].ctx.config || {};
    const historyActive = ok;
    const historyGenerated = Math.floor(Date.now() / 1000);
    const historyWindow = historyGenerated - 7 * 86400;
    const events = await loadStatusHistory(servers, historyActive);
    const days = recentLocalDays(historyGenerated);
    const data = {
      title: primary.site_title || 'CF Server Monitor',
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
      generated_at: historyGenerated,
      window_start: historyWindow,
      days,
      servers,
      totals: {
        servers: total,
        online,
        up,
        down,
        today: 0
      },
      history: {},
      events,
      supervisor: false,
      show: { overview: true, events: true }
    };
    setPageTitle(data.title);
    setCfsmPresentation(servers);
    for (const { ctx } of ok) connectSource(ctx);
    return data;
  }

  function setPageTitle(title) {
    document.title = `${title} · Status`;
    document.documentElement.dataset.cfsm = 'true';
    const old = document.getElementById('cfsm-status-about');
    if (!old) return;
  }

  function setCfsmPresentation(servers = []) {
    const hasGeo = servers.some((server) => Array.isArray(server.loc)
      && server.loc.length >= 2 && server.loc.slice(0, 2).every(finite));
    document.documentElement.dataset.cfsm = 'true';
    document.documentElement.classList.toggle('cfsm-no-geo', !hasGeo);
    document.documentElement.classList.remove('cfsm-no-availability');
    const events = document.getElementById('pEvents');
    events?.classList.remove('hidden');
    document.querySelectorAll('[data-view="events"]').forEach((el) => el.classList.remove('hidden'));
    document.querySelectorAll('[data-view="me"], .need-user').forEach((el) => el.classList.add('hidden'));
    const mapTitle = document.getElementById('hGlobe');
    if (mapTitle) mapTitle.textContent = 'Live fleet';
    const globeStage = document.querySelector('#pGlobe .g-stage');
    if (globeStage) {
      globeStage.classList.toggle('cfsm-no-geo', !hasGeo);
      const existingNote = document.getElementById('cfsm-geo-note');
      if (hasGeo) {
        existingNote?.remove();
      } else if (!existingNote) {
        const note = document.createElement('div');
        note.id = 'cfsm-geo-note';
        note.className = 'cfsm-geo-note';
        note.textContent = 'No approximate egress coordinates are available from Cloudflare for this probe';
        globeStage.append(note);
      }
    }
    const mapCredit = document.querySelector('.g-src');
    if (mapCredit) mapCredit.textContent = hasGeo
      ? 'Natural Earth · approximate probe egress locations from Cloudflare IP geolocation'
      : 'Natural Earth · no Cloudflare egress coordinates available';
    const approxLegend = document.getElementById('lgApprox');
    const approxLabel = approxLegend && [...approxLegend.childNodes].find((node) => node.nodeType === 3);
    if (approxLabel) approxLabel.textContent = 'Dashed ring: approximate probe egress location';
    const globe = document.getElementById('globe');
    if (globe && hasGeo) globe.setAttribute('aria-label', 'Globe with approximate IP-geolocated probe egress points; these are not physical server locations. Arrow keys move between points, Enter opens one, F for full screen');
    const foot = document.getElementById('footText');
    if (foot) foot.textContent = 'Live infrastructure data from CF-Server-Monitor';
    const footerCredit = document.querySelector('.foot > span:last-child');
    if (footerCredit) footerCredit.innerHTML = 'Theme and interaction: <a href="https://github.com/Dokoyamo-Lisa/Meridian" rel="noopener noreferrer" target="_blank">Meridian</a> · <a href="https://github.com/huilang-me/CF-Server-Monitor/" rel="noopener noreferrer" target="_blank" title="Powered by CF-Server-Monitor">Powered by CF-Server-Monitor</a>';
    const flow30 = document.querySelector('#flowSeg [data-v="30d"]');
    if (flow30) flow30.hidden = true;
    const today = document.getElementById('kToday');
    today?.closest('.kpi')?.classList.add('hidden');
    const canLongHistory = canAccessExtendedHistory();
    try {
      const prefs = JSON.parse(localStorage.getItem('meridian.details') || '{}');
      if (prefs.range === '30d' || (!canLongHistory && prefs.range === '7d')) {
        prefs.range = canLongHistory ? '7d' : '24h';
        localStorage.setItem('meridian.details', JSON.stringify(prefs));
      }
    } catch {}
    hideUnsupportedHistoryRange();
    hideUnsupportedDetailSections();
    const body = document.getElementById('dBody');
    if (body && !body.dataset.cfsmUnsupportedObserver) {
      body.dataset.cfsmUnsupportedObserver = 'true';
      new MutationObserver(() => { hideUnsupportedHistoryRange(); hideUnsupportedDetailSections(); })
        .observe(body, { childList: true, subtree: true });
    }
  }

  function hideUnsupportedHistoryRange() {
    document.querySelectorAll('.hist .seg button[data-v="30d"]').forEach((button) => {
      button.hidden = true;
      button.setAttribute('aria-hidden', 'true');
      button.tabIndex = -1;
    });
    document.querySelectorAll('.hist .seg button[data-v="7d"]').forEach((button) => {
      const hidden = !canAccessExtendedHistory();
      button.hidden = hidden;
      if (hidden) {
        button.setAttribute('aria-hidden', 'true');
        button.tabIndex = -1;
      } else {
        button.removeAttribute('aria-hidden');
        button.tabIndex = 0;
      }
    });
  }

  function canAccessExtendedHistory() {
    const active = [...contexts.values()].filter((ctx) => ctx.hasSnapshot);
    return active.length > 0 && !active.some((ctx) => ctx.config?.is_public === true && ctx.config?.authorization !== true);
  }

  function hideUnsupportedDetailSections() {
    document.querySelectorAll('#dBody .d-sec').forEach((section) => {
      const heading = section.querySelector('h4')?.textContent || '';
      if (/availability/i.test(heading)) section.classList.remove('cfsm-unavailable');
    });
  }

  function addLive(localId, sample, sourceTs) {
    const atMs = asMs(sample.ts || sourceTs || Date.now());
    const at = Math.floor(atMs / 1000);
    const data = sample.data || sample.payload || sample.metrics || {};
    if (!at) return;
    const key = `${localId}:${at}`;
    if (liveSeen.has(key)) return;
    liveSeen.set(key, true);
    const owner = localToRemote.get(localId);
    if (owner?.server) {
      const bytes = (v) => number(v) * 1024 * 1024;
      const priorSpeed = owner.server.speed || { up: 0, down: 0 };
      if (finite(data.net_out_speed) || finite(data.net_in_speed)) owner.server.speed = {
        up: finite(data.net_out_speed) ? number(data.net_out_speed) : priorSpeed.up,
        down: finite(data.net_in_speed) ? number(data.net_in_speed) : priorSpeed.down
      };
      if (typeof data.is_online === 'boolean') owner.server.online = data.is_online;
      if (finite(data.cpu)) owner.server.sys.cpu = number(data.cpu);
      if (finite(data.ram_total)) owner.server.sys.mem_total = bytes(data.ram_total);
      if (finite(data.ram_used)) owner.server.sys.mem_used = bytes(data.ram_used);
      if (finite(data.swap_total)) owner.server.sys.swap_total = bytes(data.swap_total);
      if (finite(data.swap_used)) owner.server.sys.swap_used = bytes(data.swap_used);
      if (finite(data.disk_total)) owner.server.sys.disk_total = bytes(data.disk_total);
      if (finite(data.disk_used)) owner.server.sys.disk_used = bytes(data.disk_used);
      if (owner.server.sys.disk_total > 0) owner.server.sys.disk = owner.server.sys.disk_used * 100 / owner.server.sys.disk_total;
      if (finite(data.tcp_conn)) owner.server.sys.tcp = number(data.tcp_conn);
      if (finite(data.udp_conn)) owner.server.sys.udp = number(data.udp_conn);
      const load = splitLoad(data.load_avg);
      if (load.length) owner.server.sys.load = [load[0] || 0, load[1] || 0, load[2] || 0];
    }
    if (!finite(data.net_out_speed) && !finite(data.net_in_speed)) return;
    const speed = owner?.server?.speed || { up: number(data.net_out_speed), down: number(data.net_in_speed) };
    liveQueue.push({ id: localId, at, up: speed.up, down: speed.down });
    if (liveQueue.length > MAX_LIVE) liveQueue.splice(0, liveQueue.length - MAX_LIVE);
    if (liveSeen.size > MAX_LIVE * 2) {
      const keepAfter = Math.floor(Date.now() / 1000) - 1800;
      for (const k of liveSeen.keys()) if (Number(k.split(':').at(-1)) < keepAfter) liveSeen.delete(k);
    }
  }

  function wsUrl(ctx, ids) {
    const url = new URL('/api/ws', ctx.base);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.searchParams.set('subscribe', 'all');
    const current = new URL(location.href);
    const jwt = safeRead('jwt_token');
    if (url.host !== current.host && jwt) url.searchParams.set('token', jwt);
    return url.toString();
  }

  function closeSource(ctx, stop = false) {
    if (stop) ctx.userStopped = true;
    for (const timer of ctx.reconnects) clearTimeout(timer);
    for (const timer of ctx.timeoutTimers) clearTimeout(timer);
    ctx.reconnects = [];
    ctx.timeoutTimers = [];
    for (const socket of ctx.sockets) {
      socket.__cfsmManual = true;
      try { socket.close(1000, 'CFSM theme view hidden'); } catch {}
    }
    ctx.sockets = [];
  }

  function connectSource(ctx) {
    if (document.hidden || ctx.userStopped || !('WebSocket' in window) || !ctx.servers.length) return;
    const ids = ctx.servers.map((s) => String(s.id)).filter((id) => /^[A-Za-z0-9._:-]{1,64}$/.test(id));
    if (!ids.length) return;
    const key = ids.join('|');
    if (ctx.socketKey === key && ctx.sockets.some((s) => s.readyState <= WebSocket.OPEN)) return;
    closeSource(ctx);
    ctx.socketKey = key;
    ctx.retry = 0;
    for (let offset = 0; offset < ids.length; offset += 500) {
      const batch = ids.slice(offset, offset + 500);
      openSocket(ctx, batch, 0);
    }
  }

  function openSocket(ctx, ids, retry) {
    if (document.hidden || ctx.userStopped) return;
    let socket;
    try { socket = new WebSocket(wsUrl(ctx, ids)); }
    catch { scheduleReconnect(ctx, ids, retry); return; }
    socket.__cfsmManual = false;
    socket.__cfsmRetry = retry;
    ctx.sockets.push(socket);
    const maxMinutes = number(ctx.config?.frontend_ws_timeout_minutes);
    if (maxMinutes > 0) {
      const timer = setTimeout(() => {
        const reconnect = window.confirm(`This live connection has run for ${maxMinutes} minutes. Reconnect now?`);
        if (reconnect) {
          socket.__cfsmManual = true;
          try { socket.close(1000, 'user renewed live session'); } catch {}
          ctx.sockets = ctx.sockets.filter((s) => s !== socket);
          openSocket(ctx, ids, 0);
        } else closeSource(ctx, true);
      }, maxMinutes * 60 * 1000);
      ctx.timeoutTimers.push(timer);
    }
    socket.addEventListener('open', () => {
      ctx.retry = 0;
      try { socket.send(JSON.stringify({ type: 'subscribe', scope: 'all', ids })); } catch {}
    });
    socket.addEventListener('message', (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type !== 'batchUpdate' || !Array.isArray(msg.updates)) return;
        for (const update of msg.updates) {
          const remoteId = String(update.serverId);
          const localId = remoteToLocal.get(`${ctx.base}\u0000${remoteId}`);
          if (!localId) continue;
          const source = ctx.servers.find((item) => String(item.id) === remoteId);
          for (const sample of update.samples || []) {
            const data = sample.data || sample.payload || sample.metrics || {};
            if (source && data && typeof data === 'object' && !Array.isArray(data)) {
              for (const [key, value] of Object.entries(data)) {
                if (value !== undefined) source[key] = value;
              }
              const ts = asMs(sample.ts || msg.ts);
              if (ts) source.last_updated = ts;
            }
            addLive(localId, sample, msg.ts);
            if (source) mapServer(ctx, source);
          }
        }
      } catch {}
    });
    socket.addEventListener('close', () => {
      ctx.sockets = ctx.sockets.filter((s) => s !== socket);
      if (!socket.__cfsmManual && !document.hidden && !ctx.userStopped) scheduleReconnect(ctx, ids, socket.__cfsmRetry || 0);
    });
    socket.addEventListener('error', () => { try { socket.close(); } catch {} });
  }

  function scheduleReconnect(ctx, ids, retry) {
    if (document.hidden || ctx.userStopped) return;
    const attempt = Math.min(retry + 1, 8);
    const delay = Math.min(30000, 1000 * (2 ** Math.min(attempt, 5)));
    const timer = setTimeout(() => {
      ctx.reconnects = ctx.reconnects.filter((t) => t !== timer);
      openSocket(ctx, ids, attempt);
    }, delay);
    ctx.reconnects.push(timer);
  }

  async function livePayload(url) {
    const since = Number(url.searchParams.get('since') || 0);
    const byServer = {};
    for (const sample of liveQueue) {
      if (sample.at <= since) continue;
      (byServer[sample.id] ||= []).push([sample.at, sample.up, sample.down]);
    }
    const t = Math.floor(Date.now() / 1000);
    for (const [id, list] of Object.entries(byServer)) list.sort((a, b) => a[0] - b[0]);
    while (liveQueue.length && liveQueue[0].at < t - 1800) liveQueue.shift();
    return { t, servers: byServer };
  }

  function historyHours(range) {
    if (range === '1h') return 1;
    if (range === '6h') return 6;
    if (range === '24h') return 24;
    if (range === '7d') return 168;
    if (range === '30d') return 168;
    return 24;
  }

  function historyPayload(rows, range) {
    const list = Array.isArray(rows) ? rows : [];
    const t = [];
    const metrics = {};
    const add = (key, values) => { if (values.some(finite)) metrics[key] = values.map((v) => finite(v) ? Number(v) : null); };
    const cpu = [], mem = [], swap = [], disk = [], dread = [], dwrite = [], tx = [], rx = [], load1 = [], load5 = [], load15 = [];
    for (const row of list) {
      t.push(Math.floor(asMs(row.timestamp) / 1000));
      cpu.push(row.cpu);
      mem.push(finite(row.ram_used) ? number(row.ram_used) * 1024 * 1024 : null);
      swap.push(finite(row.swap_used) ? number(row.swap_used) * 1024 * 1024 : null);
      disk.push(finite(row.disk_used) ? number(row.disk_used) * 1024 * 1024 : null);
      dread.push(row.disk?.read_bps ?? row.disk_read_bps);
      dwrite.push(row.disk?.write_bps ?? row.disk_write_bps);
      tx.push(row.net_out_speed);
      rx.push(row.net_in_speed);
      const load = splitLoad(row.load_avg);
      load1.push(load[0]); load5.push(load[1]); load15.push(load[2]);
    }
    add('cpu', cpu); add('mem', mem); add('swap', swap); add('disk', disk);
    add('dread', dread); add('dwrite', dwrite); add('tx', tx); add('rx', rx);
    add('load1', load1); add('load5', load5); add('load15', load15);
    const charts = [];
    if (metrics.cpu) charts.push('cpu');
    if (metrics.mem || metrics.swap) charts.push('memory');
    if (metrics.disk) charts.push('disk');
    if (metrics.dread || metrics.dwrite) charts.push('diskio');
    if (metrics.tx || metrics.rx) charts.push('network');
    if (metrics.load1 || metrics.load5 || metrics.load15) charts.push('load');
    return {
      range: range === '30d' ? '7d' : range, step: list.length > 1 ? Math.max(1, t[1] - t[0]) : 0,
      t, metrics,
      totals: {
        mem: number(list.at(-1)?.ram_total) * 1024 * 1024,
        disk: number(list.at(-1)?.disk_total) * 1024 * 1024
      },
      charts,
      ping: []
    };
  }

  async function loadServerDetails(localId) {
    const info = localToRemote.get(Number(localId));
    if (!info || detailRequests.has(Number(localId))) return;
    detailRequests.add(Number(localId));
    const ctx = context(info.base);
    try {
      const result = await requestJson(ctx, `/api/server?id=${encodeURIComponent(info.remoteId)}`);
      const detail = result?.server || result?.data || result;
      if (!detail || typeof detail !== 'object') return;
      let gpu = detail.gpu_info;
      if (typeof gpu === 'string') { try { gpu = JSON.parse(gpu); } catch {} }
      const gpuText = Array.isArray(gpu) ? gpu.map((x) => {
        const name = x?.name || x?.model || 'GPU';
        return finite(x?.info) ? `${name} (${number(x.info)}%)` : name;
      }).join(', ') : gpu;
      const values = [
        ['Operating system', detail.os], ['Kernel', detail.kernel_version], ['Architecture', detail.arch],
        ['CPU model', detail.cpu_info], ['CPU cores', detail.cpu_cores], ['GPU', gpuText],
        ['Region', detail.region], ['Agent version', detail.agent_version], ['Processes', detail.processes],
        ['IPv4', detail.ip_v4 === true || detail.ip_v4 === '1' ? 'Available' : detail.ip_v4 === false || detail.ip_v4 === '0' ? 'Unavailable' : ''],
        ['IPv6', detail.ip_v6 === true || detail.ip_v6 === '1' ? 'Available' : detail.ip_v6 === false || detail.ip_v6 === '0' ? 'Unavailable' : '']
      ].filter(([, value]) => value !== undefined && value !== null && value !== '');
      const host = document.getElementById('dBody');
      if (!host || !values.length) return;
      let section = host.querySelector('.cfsm-detail-extra');
      if (!section) {
        section = document.createElement('section');
        section.className = 'd-sec cfsm-detail-extra';
        section.dataset.tab = 'info';
        section.innerHTML = '<h4>CFSM monitor details</h4><div class="kv-grid"></div>';
        host.append(section);
      }
      const grid = section.querySelector('.kv-grid');
      grid.replaceChildren(...values.map(([label, value]) => {
        const item = document.createElement('div');
        item.className = 'kv';
        const key = document.createElement('small');
        key.textContent = label;
        const val = document.createElement('b');
        val.textContent = String(value);
        item.append(key, val);
        return item;
      }));
    } catch {
      // The list snapshot remains useful even if the optional detail endpoint is unavailable.
    } finally {
      setTimeout(() => detailRequests.delete(Number(localId)), 10000);
    }
  }

  async function seriesResponse(url) {
    const match = url.pathname.match(/\/api\/status\/servers\/([^/]+)\/series$/);
    if (!match) return response({ error: 'Not found' }, 404);
    const localId = Number(decodeURIComponent(match[1]));
    const info = localToRemote.get(localId);
    if (!info) return response({ error: 'Server not found' }, 404);
    const ctx = context(info.base);
    const range = url.searchParams.get('range') || '24h';
    const rows = await requestJson(ctx, `/api/history/all?id=${encodeURIComponent(info.remoteId)}&hours=${historyHours(range)}`);
    return response(historyPayload(rows, range));
  }

  async function statusResponse() {
    const force = [...contexts.values()].some((ctx) => ctx.needsSnapshot);
    const data = await allSnapshots(force);
    if (force) for (const ctx of contexts.values()) if (!ctx.error) ctx.needsSnapshot = false;
    return response(data);
  }

  async function metaResponse() {
    const bases = apiBases();
    const ctx = context(bases[0]);
    if (!ctx.config) ctx.config = await requestJson(ctx, '/api/config', {}, false);
    return response({
      site_title: ctx.config?.site_title || 'CF Server Monitor',
      about: '', report_interval: 5,
      logo: null, turnstile: ctx.config?.turnstile_site_key || ''
    });
  }

  async function loginResponse(init = {}) {
    let credentials;
    try {
      const body = init?.body;
      credentials = typeof body === 'string' ? JSON.parse(body) : body;
    } catch {
      return response({ error: 'Could not read the sign-in details. Please try again.' }, 400);
    }
    if (!credentials || typeof credentials !== 'object' || Array.isArray(credentials)) {
      return response({ error: 'Could not read the sign-in details. Please try again.' }, 400);
    }
    const username = String(credentials.username || '').trim();
    const password = String(credentials.password || '');
    if (!username || !password) return response({ error: 'Enter your username and password.' }, 400);

    const ctx = context(location.origin);
    const payload = { action: 'login', username, password };
    const res = await rawRequest(ctx, '/admin/api', {
      method: 'POST',
      headers: { 'X-Meridian': '1' },
      body: JSON.stringify(payload)
    });
    const text = await res.text();
    let data = null;
    let validJson = false;
    try { if (text) { data = JSON.parse(text); validJson = true; } } catch {}
    const objectData = data && typeof data === 'object' && !Array.isArray(data);
    const explicitlyAccepted = objectData
      && (data.success === true || data.ok === true || data.authenticated === true);
    const apiError = objectData ? String(data.error || (!explicitlyAccepted ? data.message || '' : '')) : '';
    const explicitlyRejected = objectData
      && (data.success === false || data.ok === false || data.authenticated === false);
    if (!res.ok || apiError || explicitlyRejected) {
      const fallbackMessage = explicitlyRejected
        ? 'CFSM rejected the sign-in. Check your username and password and try again.'
        : res.status === 401 ? 'Sign-in failed. Check your username and password and try again.'
          : `CFSM sign-in failed (HTTP ${res.status}).`;
      const message = apiError || fallbackMessage;
      return response({ error: message }, res.ok ? 401 : res.status);
    }
    if (!validJson || !objectData) {
      return response({ error: 'CFSM returned an unexpected sign-in response. Please reload and try again.' }, 502);
    }
    window.setTimeout(() => {
      location.replace(new URL('/admin#/admin', location.origin).toString());
    }, 0);
    return response({ kind: 'admin' });
  }

  function isApiPath(path) { return path.startsWith('/api/'); }
  const originalFetchWrapper = window.fetch;
  window.fetch = async function cfsmFetch(input, init) {
    let url;
    try { url = new URL(typeof input === 'string' ? input : input.url, location.href); }
    catch { return originalFetchWrapper(input, init); }
    if (url.origin !== location.origin || !isApiPath(url.pathname)) return originalFetchWrapper(input, init);
    try {
      if (url.pathname === '/api/login') return await loginResponse(init);
      if (url.pathname === '/api/status') return await statusResponse();
      if (url.pathname === '/api/meta') return await metaResponse();
      if (url.pathname === '/api/status/live') return response(await livePayload(url));
      if (url.pathname === '/api/portal/me') return response({ error: 'Not available on CFSM themes' }, 404);
      if (/^\/api\/status\/servers\/[^/]+\/series$/.test(url.pathname)) return await seriesResponse(url);
      if (/^\/api\/status\/servers\/[^/]+\/network$/.test(url.pathname)) return response({ error: 'Network profiles are not provided by CFSM.' }, 404);
      return originalFetchWrapper(input, init);
    } catch (error) {
      const status = Number(error?.status) || 502;
      if (status === 401) showAdminSignIn(context(apiBases()[0]));
      return response({ error: error?.message || 'CFSM API request failed' }, status);
    }
  };

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      for (const ctx of contexts.values()) { ctx.needsSnapshot = true; closeSource(ctx); }
      return;
    }
    for (const ctx of contexts.values()) {
      ctx.userStopped = false;
      ctx.socketKey = '';
      connectSource(ctx);
    }
  });
  window.addEventListener('online', () => {
    for (const ctx of contexts.values()) { ctx.userStopped = false; ctx.socketKey = ''; ctx.needsSnapshot = true; connectSource(ctx); }
  });
  document.addEventListener('click', (event) => {
    if (!(event.target instanceof Element) || !event.target.closest('#dTabs button[data-t="info"]')) return;
    const match = location.hash.match(/^#\/?s\/(\d+)$/);
    if (match) setTimeout(() => { void loadServerDetails(Number(match[1])); }, 80);
  });
})();
