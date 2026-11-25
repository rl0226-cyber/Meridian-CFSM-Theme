const $ = (selector, root = document) => root.querySelector(selector);
const app = $('#app');
const main = $('#main-view');
const header = $('#site-header');
const gateArea = $('#gate-area');
const poweredLink = $('#powered-link');

const state = {
  contexts: [],
  servers: [],
  serversLoaded: false,
  detail: null,
  detailContext: null,
  history: [],
  route: { type: 'home', id: '' },
  query: '',
  filter: 'all',
  events: [],
  flow: [],
  sockets: [],
  pollTimers: [],
  reconnectTimers: [],
  timeoutTimers: [],
  theme: 'romance',
  themeMenuOpen: false,
  brandMotionPending: true,
  detailLoading: false,
  detailRequestId: 0,
  renderQueued: false,
  hidden: false,
  reconnectStopped: false,
  dataErrors: [],
  bootTime: Date.now()
};

const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
})[char]);
const safeNum = (value) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
};
const clamp = (value, min = 0, max = 100) => Math.max(min, Math.min(max, safeNum(value)));
const bytes = (value, perSecond = false) => {
  let amount = Math.max(0, safeNum(value));
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let index = 0;
  while (amount >= 1024 && index < units.length - 1) { amount /= 1024; index += 1; }
  const digits = index === 0 ? 0 : amount >= 100 ? 0 : amount >= 10 ? 1 : 2;
  return `${amount.toFixed(digits)} ${units[index]}${perSecond ? '/s' : ''}`;
};
const mib = (value) => bytes(safeNum(value) * 1024 * 1024);
const percent = (used, total) => safeNum(total) > 0 ? clamp((safeNum(used) / safeNum(total)) * 100) : null;
const timeLabel = (timestamp) => {
  const date = new Date(timestamp || Date.now());
  return Number.isNaN(date.getTime()) ? '—' : new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', hour12: false }).format(date);
};
const escapeId = (id) => encodeURIComponent(String(id ?? ''));

function readStorage(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}
function writeStorage(key, value) {
  try { localStorage.setItem(key, value); } catch { /* private browsing may disable storage */ }
}
function removeStorage(key) {
  try { localStorage.removeItem(key); } catch { /* private browsing may disable storage */ }
}
function getToken() {
  return readStorage('jwt_token') || '';
}
function getApiBases() {
  const raw = document.querySelector('meta[name="apiBase"]')?.content?.trim() || '';
  const entries = raw ? raw.split(',').map((part) => part.trim()).filter(Boolean) : [window.location.origin];
  const unique = [];
  for (const entry of entries) {
    try {
      const url = new URL(entry, window.location.href);
      if (!['http:', 'https:'].includes(url.protocol)) continue;
      const origin = url.origin.replace(/\/$/, '');
      if (!unique.includes(origin)) unique.push(origin);
    } catch { /* invalid apiBase entries are ignored */ }
  }
  return unique.length ? unique : [window.location.origin];
}
function cachedVerified(base) {
  try {
    const map = JSON.parse(readStorage('cfsm_theme_turnstile') || '{}');
    const item = map[base];
    if (item?.token && Date.now() - item.savedAt < 55 * 60 * 1000) return item.token;
  } catch { /* ignore malformed cache */ }
  return base === window.location.origin ? readStorage('turnstile_verified') || '' : '';
}
function saveVerified(base, token) {
  if (base === window.location.origin) writeStorage('turnstile_verified', token);
  try {
    const map = JSON.parse(readStorage('cfsm_theme_turnstile') || '{}');
    map[base] = { token, savedAt: Date.now() };
    writeStorage('cfsm_theme_turnstile', JSON.stringify(map));
  } catch { /* cache is optional */ }
}
function clearVerified(base) {
  try {
    const map = JSON.parse(readStorage('cfsm_theme_turnstile') || '{}');
    delete map[base];
    writeStorage('cfsm_theme_turnstile', JSON.stringify(map));
  } catch { /* ignore */ }
  if (base === window.location.origin) {
    try { localStorage.removeItem('turnstile_verified'); } catch { /* ignore */ }
  }
}

class ApiError extends Error {
  constructor(status, message, data = null) {
    super(message || `HTTP ${status}`);
    this.name = 'ApiError';
    this.status = status;
    this.data = data;
  }
}
async function request(ctx, path, options = {}) {
  const headers = new Headers(options.headers || {});
  headers.set('Accept', 'application/json');
  const token = getToken();
  if (token) headers.set('Authorization', `Bearer ${token}`);
  if (ctx?.verified) headers.set('X-Turnstile-Verified', ctx.verified);
  if (options.turnstileToken) headers.set('X-Turnstile-Token', options.turnstileToken);
  if (options.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  const response = await fetch(`${ctx.base}${path}`, {
    ...options,
    headers,
    credentials: 'include',
    cache: 'no-store'
  });
  let data = null;
  const text = await response.text();
  if (text) {
    try { data = JSON.parse(text); } catch { data = { message: text.slice(0, 300) }; }
  }
  if (!response.ok) {
    const message = data?.error || data?.message || `HTTP ${response.status}`;
    throw new ApiError(response.status, message, data);
  }
  return data;
}
function normalizeServer(server, ctx) {
  const lastUpdated = safeNum(server?.last_updated);
  const online = typeof server?.is_online === 'boolean'
    ? server.is_online
    : (lastUpdated > 0 ? Date.now() - lastUpdated <= 5 * 60 * 1000 : false);
  return { ...server, _apiBase: ctx.base, _online: online, _updatedAt: lastUpdated };
}
function readRoute() {
  const hash = window.location.hash || '#/';
  const match = hash.match(/^#\/?server\/([^/?#]+)/i);
  if (match) {
    let id = match[1];
    try { id = decodeURIComponent(id); } catch { /* retain source string */ }
    return { type: 'detail', id };
  }
  return { type: 'home', id: '' };
}
function adminHref(ctx = state.contexts[0]) {
  const base = ctx?.base || window.location.origin;
  try { return `${new URL('/admin', base).origin}/admin#/admin`; } catch { return '/admin#/admin'; }
}
function activeContext() {
  return state.detailContext || state.contexts[0] || null;
}
function siteTitle() {
  return state.contexts.map((ctx) => ctx.config?.site_title).find((title) => title && String(title).trim()) || 'Server monitor';
}
function renderHeader() {
  const focusedChoice = document.activeElement?.closest('#theme-menu')?.dataset.themeChoice || '';
  const title = siteTitle();
  const detail = state.route.type === 'detail';
  const openState = window.WebSocket?.OPEN || 1;
  const live = state.sockets.some((socket) => socket.readyState === openState);
  const isPolling = state.pollTimers.length > 0;
  const mode = live ? 'Live' : isPolling ? 'Polling' : state.contexts.length ? 'Connecting' : 'Offline';
  header.innerHTML = `
    <a class="brand" href="#/" aria-label="${esc(title)} overview">
      <span class="brand-mark ${state.brandMotionPending ? 'mark-enter' : ''}" aria-hidden="true"><img class="mark mark-romance" src="assets/mark-romance.svg" alt=""><img class="mark mark-umbrella" src="assets/mark-umbrella.svg" alt=""></span>
      <span class="brand-copy"><span class="brand-name">${esc(title)}</span><span class="brand-kicker">CFSM · INFRASTRUCTURE</span></span>
    </a>
    <div class="top-clock" aria-label="Current time"><span id="clock-time" class="clock-time">--:--:--</span><span id="clock-date" class="clock-date"><span>—</span><span>—</span></span></div>
    <div class="header-actions">
      ${!detail ? `<nav class="nav" aria-label="Main navigation"><a href="#/" aria-current="page">Overview</a><a href="#server-list">Nodes</a></nav>` : `<a class="back-link" href="#/">← Overview</a>`}
      <span class="live-pill ${live ? '' : 'stale'}"><i class="live-dot"></i><span>${mode}</span></span>
      <div class="tone-control">
        <button class="header-button icon tone-button" type="button" data-action="theme-menu-toggle" aria-label="Choose visual theme" aria-haspopup="menu" aria-expanded="${state.themeMenuOpen}" title="Appearance options"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.25a8.75 8.75 0 1 0 0 17.5h1.1a1.8 1.8 0 0 0 1.38-2.96 1.65 1.65 0 0 1 1.28-2.69h1.17a4.82 4.82 0 0 0 4.82-4.82c0-3.88-4.37-7.03-9.75-7.03Z"/><circle cx="7.5" cy="10" r=".8"/><circle cx="10.5" cy="7.5" r=".8"/><circle cx="15" cy="7.5" r=".8"/></svg></button>
        <div class="tone-pop" id="theme-menu" role="menu" aria-label="Visual theme" ${state.themeMenuOpen ? '' : 'hidden'}>
          <button type="button" role="menuitemradio" data-action="theme-choice" data-theme-choice="romance" aria-checked="${state.theme === 'romance'}"><i class="tone-swatch romance" aria-hidden="true"></i>Romance</button>
          <button type="button" role="menuitemradio" data-action="theme-choice" data-theme-choice="umbrella" aria-checked="${state.theme === 'umbrella'}"><i class="tone-swatch umbrella" aria-hidden="true"></i>Umbrella</button>
        </div>
      </div>
      <a class="header-button admin-link" href="${esc(adminHref())}" title="Open the CFSM built-in admin panel">Admin ↗</a>
    </div>`;
  state.brandMotionPending = false;
  if (focusedChoice && state.themeMenuOpen) requestAnimationFrame(() => header.querySelector(`[data-theme-choice="${focusedChoice}"]`)?.focus({ preventScroll: true }));
  document.title = `${title} · CF Server Monitor`;
  const primary = state.contexts.find((ctx) => ctx.config?.version);
  if (primary) poweredLink.title = `Powered by CF-Server-Monitor · ${primary.config.version}`;
  updateClock();
}
function updateClock() {
  const time = $('#clock-time');
  const date = $('#clock-date');
  if (!time || !date) return;
  const now = new Date();
  time.textContent = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(now);
  const parts = new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: '2-digit', weekday: 'short' }).formatToParts(now);
  const get = (type) => parts.find((part) => part.type === type)?.value || '';
  date.innerHTML = `<span>${esc(`${get('year')}/${get('month')}/${get('day')}`)}</span><span>${esc(get('weekday'))}</span>`;
}
function readThemePreference() {
  const stored = readStorage('meridian.site.tone');
  if (stored === 'romance' || stored === 'umbrella') return stored;
  return readStorage('cfsm-theme-tone') === 'night' ? 'umbrella' : 'romance';
}
function setTheme(theme) {
  state.theme = theme === 'umbrella' ? 'umbrella' : 'romance';
  document.documentElement.dataset.theme = state.theme;
  const themeColor = $('meta[name="theme-color"]');
  if (themeColor) themeColor.content = state.theme === 'umbrella' ? '#0a0a0b' : '#fbf0f2';
  const themeIcon = $('link[rel="icon"][data-umbrella]');
  if (themeIcon) themeIcon.href = themeIcon.getAttribute(state.theme === 'umbrella' ? 'data-umbrella' : 'data-romance');
  if (state.theme === 'umbrella') writeStorage('meridian.site.tone', 'umbrella');
  else removeStorage('meridian.site.tone');
  removeStorage('cfsm-theme-tone');
  state.brandMotionPending = true;
  renderHeader();
}

async function loadConfig(ctx) {
  try {
    ctx.config = await request(ctx, '/api/config');
    ctx.verified = cachedVerified(ctx.base);
    ctx.configError = '';
  } catch (error) {
    ctx.configError = error.message;
    ctx.configStatus = error.status || 0;
  }
}
function errorsForHome() {
  return state.contexts.filter((ctx) => ctx.configError || ctx.dataError);
}
function noticeMarkup(ctx) {
  if (ctx.configStatus === 401 || ctx.dataStatus === 401) {
    return `<div class="notice error"><span>This site requires authentication. Sign in through the built-in CFSM admin page, then reload the theme.</span><a class="gate-link" href="${esc(adminHref(ctx))}">Open sign-in ↗</a></div>`;
  }
  if (ctx.config?.turnstile_enabled && !ctx.verified && ctx.dataStatus === 403) {
    return `<div class="notice warning"><span>${esc(ctx.dataError || 'Complete Turnstile verification to load server data.')}</span><button data-action="retry-turnstile" data-base="${esc(ctx.base)}">Verify again</button></div>`;
  }
  const message = ctx.configError || ctx.dataError;
  return message ? `<div class="notice error"><span><b>${esc(ctx.base)}</b>: ${esc(message)}</span><button data-action="retry-base" data-base="${esc(ctx.base)}">Retry</button></div>` : '';
}
function noticesMarkup() {
  return errorsForHome().map(noticeMarkup).join('');
}
function getServers() {
  return state.contexts.flatMap((ctx) => ctx.servers || []);
}
function onlineCount(servers = getServers()) { return servers.filter((server) => server._online).length; }
function regionCounts(servers = getServers()) {
  const counts = new Map();
  for (const server of servers) {
    const region = String(server.region || server.server_group || 'Unknown').trim() || 'Unknown';
    counts.set(region, (counts.get(region) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}
function totalTraffic(servers = getServers()) {
  return servers.reduce((total, server) => ({
    down: total.down + safeNum(server.net_in_speed),
    up: total.up + safeNum(server.net_out_speed)
  }), { down: 0, up: 0 });
}
function statusLevel(servers = getServers()) {
  if (!servers.length) return 'warn';
  const offline = servers.length - onlineCount(servers);
  if (offline === servers.length) return 'bad';
  return offline ? 'warn' : 'good';
}
function statusCopy(servers = getServers()) {
  const total = servers.length;
  const online = onlineCount(servers);
  if (!total) return { title: 'Waiting for nodes', subtitle: 'API connection is ready; no server data has arrived yet.' };
  if (online === total) return { title: 'All nodes are online', subtitle: `${online} of ${total} monitored servers are reporting.` };
  if (!online) return { title: 'No nodes reporting', subtitle: `All ${total} servers currently appear offline.` };
  return { title: `${total - online} node${total - online === 1 ? '' : 's'} need attention`, subtitle: `${online} of ${total} monitored servers are reporting.` };
}
function metricPercent(server, key) {
  const used = key === 'cpu' ? safeNum(server.cpu) : safeNum(server[`${key}_used`]);
  const total = key === 'cpu' ? 100 : safeNum(server[`${key}_total`]);
  return percent(used, total);
}
function levelForPercent(value) { return value == null ? '' : value >= 92 ? 'bad' : value >= 78 ? 'warn' : ''; }
function meterMarkup(value) {
  if (value == null) return '<div class="meter" aria-label="No data"><i style="width:0"></i></div>';
  return `<div class="meter" data-level="${levelForPercent(value)}"><i style="width:${clamp(value)}%"></i></div>`;
}
function renderResourceRows(servers) {
  if (!servers.length) return '<div class="event-empty">No resource data to display yet.</div>';
  return servers.slice(0, 7).map((server) => {
    const cpu = metricPercent(server, 'cpu');
    const ram = metricPercent(server, 'ram');
    const disk = metricPercent(server, 'disk');
    return `<div class="resource-name" title="${esc(server.name)}">${esc(server.name || 'Unnamed')}</div>
      <div class="resource-cell"><div class="resource-value"><span>${cpu == null ? '—' : `${cpu.toFixed(0)}%`}</span><small>CPU</small></div>${meterMarkup(cpu)}</div>
      <div class="resource-cell"><div class="resource-value"><span>${ram == null ? '—' : `${ram.toFixed(0)}%`}</span><small>RAM</small></div>${meterMarkup(ram)}</div>
      <div class="resource-cell"><div class="resource-value"><span>${disk == null ? '—' : `${disk.toFixed(0)}%`}</span><small>Disk</small></div>${meterMarkup(disk)}</div>`;
  }).join('');
}
function renderRegions(servers) {
  const items = regionCounts(servers).slice(0, 8);
  if (!items.length) return '<span class="region-chip">No regions yet</span>';
  return items.map(([name, count]) => `<span class="region-chip" title="${esc(name)}">${esc(name)} <b>${count}</b></span>`).join('');
}
function svgOrbit() {
  return `<svg class="orbit-art" viewBox="0 0 640 360" preserveAspectRatio="xMidYMid meet" aria-hidden="true">
    <defs><radialGradient id="orbGlow"><stop offset="0" stop-color="var(--rose)" stop-opacity=".19"/><stop offset=".62" stop-color="var(--rose)" stop-opacity=".035"/><stop offset="1" stop-color="var(--rose)" stop-opacity="0"/></radialGradient></defs>
    <g class="orbit-shell" fill="none" stroke="currentColor" stroke-width="1">
      <circle cx="320" cy="175" r="122" opacity=".11"/><ellipse cx="320" cy="175" rx="180" ry="76" transform="rotate(-22 320 175)" opacity=".13"/>
      <ellipse cx="320" cy="175" rx="206" ry="112" transform="rotate(18 320 175)" opacity=".09"/>
      <ellipse cx="320" cy="175" rx="118" ry="160" transform="rotate(38 320 175)" opacity=".08"/>
      <path d="M145 179c47-37 99-58 175-58s132 21 175 58M166 208c44-22 94-34 154-34s108 12 154 34M201 116c38 25 78 38 119 38 46 0 85-13 119-38M221 235c28-12 62-18 99-18 40 0 74 6 99 18" opacity=".12"/>
    </g>
    <circle cx="320" cy="175" r="116" fill="url(#orbGlow)"/>
    <g fill="currentColor" opacity=".85"><circle cx="185" cy="105" r="2.7"/><circle cx="462" cy="123" r="2.3"/><circle cx="483" cy="222" r="2.8"/><circle cx="214" cy="262" r="2"/><circle cx="352" cy="47" r="2.1"/><circle cx="302" cy="308" r="2.4"/><circle cx="117" cy="186" r="1.8"/><circle cx="531" cy="168" r="1.7"/></g>
    <g fill="none" stroke="var(--rose)" stroke-width="1.2" opacity=".34"><path d="M185 105Q313 30 462 123"/><path d="M214 262Q354 305 483 222"/><path d="M117 186Q313 109 531 168"/></g>
    <g fill="var(--surface-solid)" stroke="var(--rose)" stroke-width="1.4"><circle cx="185" cy="105" r="4"/><circle cx="462" cy="123" r="4"/><circle cx="483" cy="222" r="4"/><circle cx="214" cy="262" r="4"/></g>
  </svg>`;
}
function renderFlowChart() {
  const samples = state.flow.slice(-30);
  const width = 600, height = 180, left = 2, right = 598, top = 12, bottom = 162;
  const maximum = Math.max(1, ...samples.flatMap((sample) => [sample.down, sample.up]));
  const points = (key) => samples.map((sample, index) => {
    const x = samples.length <= 1 ? (left + right) / 2 : left + (right - left) * index / (samples.length - 1);
    const y = bottom - clamp((sample[key] / maximum) * 100) / 100 * (bottom - top);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  const downPoints = points('down');
  const upPoints = points('up');
  const firstPoint = downPoints.split(' ')[0] || `${left},${bottom}`;
  const lastPoint = downPoints.split(' ').at(-1) || `${right},${bottom}`;
  const areaPoints = `${firstPoint} ${downPoints} ${right},${bottom} ${left},${bottom}`;
  const plot = samples.length > 1 ? `<polygon class="chart-area" points="${areaPoints}"/><polyline class="chart-line-in" points="${downPoints}"/><polyline class="chart-line-out" points="${upPoints}"/><circle cx="${lastPoint.split(',')[0]}" cy="${lastPoint.split(',')[1]}" r="3" fill="var(--rose)"/>` : '';
  const firstTime = samples[0]?.at ? timeLabel(samples[0].at) : '—';
  const lastTime = samples.at(-1)?.at ? timeLabel(samples.at(-1).at) : 'now';
  return `<div class="flow-chart"><svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="img" aria-label="Since this page opened: live download and upload speed">
      <defs><linearGradient id="roseFill" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="var(--rose)" stop-opacity=".20"/><stop offset="1" stop-color="var(--rose)" stop-opacity="0"/></linearGradient></defs>
      <line class="chart-grid" x1="0" y1="24" x2="600" y2="24"/><line class="chart-grid" x1="0" y1="70" x2="600" y2="70"/><line class="chart-grid" x1="0" y1="116" x2="600" y2="116"/><line class="chart-grid" x1="0" y1="162" x2="600" y2="162"/>${plot}
    </svg>${samples.length < 2 ? '<div class="chart-empty">The chart expands as live samples arrive</div>' : ''}</div><div class="chart-axis"><span>${esc(firstTime)}</span><span>since page opened</span><span>${esc(lastTime)}</span></div>`;
}
function renderServerRows() {
  const all = getServers();
  const needle = state.query.trim().toLowerCase();
  const shown = all.filter((server) => {
    if (state.filter === 'online' && !server._online) return false;
    if (state.filter === 'offline' && server._online) return false;
    const text = `${server.name || ''} ${server.server_group || ''} ${server.region || ''} ${server.tags || ''} ${server.os || ''}`.toLowerCase();
    return !needle || text.includes(needle);
  }).sort((a, b) => Number(b._online) - Number(a._online) || safeNum(a.sort_order) - safeNum(b.sort_order) || String(a.name).localeCompare(String(b.name)));
  if (!shown.length) return `<tr><td class="server-empty" colspan="5">${all.length ? 'No servers match these filters.' : 'Waiting for server data…'}</td></tr>`;
  return shown.map((server) => {
    const cpu = metricPercent(server, 'cpu');
    const ram = metricPercent(server, 'ram');
    const region = server.region || server.server_group || '—';
    return `<tr data-action="open-server" data-id="${esc(server.id)}" title="Open ${esc(server.name || 'server')} details">
      <td><div class="server-cell"><i class="server-state ${server._online ? '' : 'offline'}"></i><span class="server-cell-text"><b>${esc(server.name || 'Unnamed server')}</b><small>${esc(region)}${server.os ? ` · ${esc(server.os)}` : ''}</small></span></div></td>
      <td><span class="server-load">CPU ${cpu == null ? '—' : `${cpu.toFixed(0)}%`}</span>${meterMarkup(cpu)}</td>
      <td><span class="server-load">RAM ${ram == null ? '—' : `${ram.toFixed(0)}%`}</span>${meterMarkup(ram)}</td>
      <td class="speed-cell"><span>↓ ${esc(bytes(server.net_in_speed, true))}</span><span>↑ ${esc(bytes(server.net_out_speed, true))}</span></td>
      <td><span class="server-load">${server._online ? 'Online' : 'Offline'}</span></td>
    </tr>`;
  }).join('');
}
function renderEvents() {
  const events = state.events.slice(0, 6);
  if (!events.length) return '<div class="event-empty">No status changes observed this session.</div>';
  return events.map((event) => `<div class="event-row ${event.online ? '' : 'down'}"><time class="event-time">${esc(timeLabel(event.at))}</time><i class="event-dot"></i><div class="event-copy"><b>${event.online ? 'Back online' : 'Went offline'}</b><small>${esc(event.name)} · observed in this session</small></div></div>`).join('');
}
function statusBannerFor(ctx) {
  if (ctx?.configStatus === 401 || ctx?.detailStatus === 401) {
    return `<div class="notice error">This site requires authentication. Sign in through the built-in admin page: <a class="gate-link" href="${esc(adminHref(ctx))}">Open sign-in ↗</a></div>`;
  }
  if (ctx?.configError || ctx?.detailError) return `<div class="notice error">${esc(ctx.configError || ctx.detailError)} <button data-action="reload-current">Retry</button></div>`;
  return '';
}
function renderHome() {
  const servers = getServers();
  const online = onlineCount(servers);
  const total = servers.length;
  const offline = total - online;
  const level = statusLevel(servers);
  const copy = statusCopy(servers);
  const speeds = totalTraffic(servers);
  const regions = regionCounts(servers);
  const sorted = [...servers].sort((a, b) => Number(b._online) - Number(a._online) || safeNum(a.sort_order) - safeNum(b.sort_order));
  const admin = adminHref();
  const serverRows = renderServerRows();
  const savedQuery = state.query;
  const savedFilter = state.filter;
  main.innerHTML = `${noticesMarkup()}
    <div class="dash-grid">
      <section class="column left-column" aria-label="Fleet health and resources">
        <section class="panel"><div class="panel-head"><span class="panel-number"></span><h2 class="panel-title">Fleet health</h2><span class="panel-meta">current snapshot</span></div>
          <div class="status-summary" data-level="${level}"><span class="status-icon" aria-hidden="true">${level === 'good' ? '✓' : level === 'warn' ? '!' : '×'}</span><div class="status-words"><strong>${esc(copy.title)}</strong><span>${esc(copy.subtitle)}</span></div></div>
          <p class="status-lede">This view reports live node state from your CF-Server-Monitor workers. Historical uptime is not inferred when it is not available from the API.</p>
          <div class="status-kpis"><div><span class="status-kpi-value">${online}<small>/${total}</small></span><span class="status-kpi-label">Nodes online now</span></div><div><span class="status-kpi-value">${offline}</span><span class="status-kpi-label">Currently offline</span></div></div>
          <div class="region-list">${renderRegions(servers)}</div>
        </section>
        <section class="panel"><div class="panel-head"><span class="panel-number"></span><h2 class="panel-title">Resources</h2><span class="panel-meta">${servers.length ? `top ${Math.min(servers.length, 7)} nodes` : 'waiting'}</span></div>
          <div class="resource-table"><span class="resource-th">Server</span><span class="resource-th">CPU</span><span class="resource-th">Memory</span><span class="resource-th">Disk</span>${renderResourceRows(sorted)}</div>
          <div class="resource-foot">Latest reported utilization · no historical uptime estimate</div>
        </section>
      </section>
      <section class="column center-column" aria-label="Live fleet and server list">
        <section class="panel"><div class="panel-head"><span class="panel-number"></span><h2 class="panel-title">Fleet field</h2><span class="panel-meta">live node constellation</span></div>
          <div class="center-stage">${svgOrbit()}<div class="orbit-center"><span class="orbit-label">nodes online</span><span class="orbit-count">${online}<small> / ${total}</small></span><span class="orbit-state" data-level="${level}"><i class="orbit-pulse"></i>${level === 'good' ? 'Reporting normally' : level === 'warn' ? 'Attention needed' : 'No live reports'}</span></div><div class="orbit-caption"><span>✦</span> live fleet · abstract view, not geographic coordinates</div></div>
          <div class="kpi-strip"><div class="kpi"><span class="kpi-label">ONLINE</span><span class="kpi-value">${online}<small> / ${total}</small></span><span class="kpi-sub">current heartbeat</span></div><div class="kpi"><span class="kpi-label">DOWNLOAD</span><span class="kpi-value">${esc(bytes(speeds.down, true))}</span><span class="kpi-sub">aggregate now</span></div><div class="kpi"><span class="kpi-label">UPLOAD</span><span class="kpi-value">${esc(bytes(speeds.up, true))}</span><span class="kpi-sub">aggregate now</span></div><div class="kpi"><span class="kpi-label">REGIONS</span><span class="kpi-value">${regions.length}</span><span class="kpi-sub">reported groups</span></div></div>
        </section>
        <section class="panel" id="server-list"><div class="panel-head"><span class="panel-number"></span><h2 class="panel-title">Servers</h2><span class="panel-meta">${online} of ${total} online</span><div class="server-tools"><input id="server-search" class="search-box" type="search" placeholder="Search nodes…" aria-label="Search servers" value="${esc(savedQuery)}"><select id="server-filter" class="filter-select" aria-label="Filter servers"><option value="all" ${savedFilter === 'all' ? 'selected' : ''}>All</option><option value="online" ${savedFilter === 'online' ? 'selected' : ''}>Online</option><option value="offline" ${savedFilter === 'offline' ? 'selected' : ''}>Offline</option></select></div></div>
          <div class="table-scroll"><table class="server-list"><thead><tr><th>Server</th><th>CPU</th><th>Memory</th><th>Traffic now</th><th>State</th></tr></thead><tbody id="server-rows">${serverRows}</tbody></table></div><div class="table-foot">Select a node for detailed metrics and available history. ${servers.length > 500 ? 'Live subscriptions are grouped in batches of 500.' : ''}</div>
        </section>
      </section>
      <aside class="column right-column" aria-label="Live throughput and observed events">
        <section class="panel"><div class="panel-head"><span class="panel-number"></span><h2 class="panel-title">Throughput</h2><span class="panel-meta">live · this session</span></div>
          <div class="flow-labels"><span>↓ download <b>${esc(bytes(speeds.down, true))}</b></span><span>↑ upload <b>${esc(bytes(speeds.up, true))}</b></span></div>
          ${renderFlowChart()}<div class="observed-note">The chart starts filling as live samples arrive; it is not a historical archive.</div>
        </section>
        <section class="panel"><div class="panel-head"><span class="panel-number"></span><h2 class="panel-title">Observed changes</h2><span class="panel-meta">this session</span></div><div class="event-list">${renderEvents()}</div></section>
        ${state.contexts.some((ctx) => ctx.configError || ctx.dataError) ? `<section class="panel"><div class="panel-head"><span class="panel-number"></span><h2 class="panel-title">Connection notes</h2></div>${state.contexts.map((ctx) => noticeMarkup(ctx)).join('')}</section>` : ''}
      </aside>
    </div>`;
  const search = $('#server-search');
  const filter = $('#server-filter');
  if (search) search.value = savedQuery;
  if (filter) filter.value = savedFilter;
  // The server list may contain no data while a Turnstile challenge is being completed.
  if (!state.serversLoaded && !servers.length && !errorsForHome().length) {
    const rows = $('#server-rows');
    if (rows) rows.innerHTML = '<tr><td class="server-empty" colspan="5">Connecting to your monitor…</td></tr>';
  }
  void admin;
}
function detailMetric(title, value, sub, fill = null) {
  const meter = fill == null ? '' : `<div class="detail-meter"><i style="width:${clamp(fill)}%"></i></div>`;
  return `<article class="detail-card"><span class="detail-card-label">${esc(title)}</span><strong class="detail-card-value">${esc(value)}</strong><span class="detail-card-sub">${esc(sub)}</span>${meter}</article>`;
}
function historyGraph(rows) {
  const valid = rows.filter((row) => Number.isFinite(Number(row.timestamp)));
  if (valid.length < 2) return '<div class="history-empty">No history is available for this node yet.<br>Historical points appear here when the API returns them.</div>';
  const width = 720, height = 180, padX = 6, padY = 12;
  const defs = [
    { name: 'CPU', color: 'var(--rose)', value: (row) => safeNum(row.cpu) },
    { name: 'Memory', color: 'var(--lavender)', value: (row) => percent(row.ram_used, row.ram_total) ?? 0 },
    { name: 'Disk', color: 'var(--peach)', value: (row) => percent(row.disk_used, row.disk_total) ?? 0 }
  ];
  const lines = defs.map((series) => {
    const points = valid.map((row, index) => {
      const x = padX + (width - padX * 2) * index / (valid.length - 1);
      const y = height - padY - clamp(series.value(row)) / 100 * (height - padY * 2);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(' ');
    return `<polyline points="${points}" fill="none" stroke="${series.color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`;
  }).join('');
  const grid = [0, 25, 50, 75, 100].map((value) => {
    const y = height - padY - value / 100 * (height - padY * 2);
    return `<line x1="0" y1="${y}" x2="${width}" y2="${y}" stroke="var(--line)"/><text x="4" y="${Math.max(10, y - 3)}" fill="var(--faint)" font-size="9">${value}%</text>`;
  }).join('');
  return `<div class="history-chart"><svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="img" aria-label="CPU, memory and disk history over the last day">${grid}${lines}</svg></div>`;
}
function formatUptime(bootTime) {
  const time = Number(bootTime);
  if (!Number.isFinite(time) || time <= 0) return '—';
  const dateValue = time < 1e12 ? time * 1000 : time;
  const duration = Math.max(0, Date.now() - dateValue);
  const days = Math.floor(duration / 86400000);
  const hours = Math.floor((duration % 86400000) / 3600000);
  return `${days}d ${hours}h`;
}
function gpuLabel(value) {
  let items = value;
  if (typeof items === 'string') { try { items = JSON.parse(items); } catch { items = []; } }
  if (!Array.isArray(items) || !items.length) return '—';
  return items.map((gpu) => gpu.name || gpu.id || 'GPU').join(', ');
}
function renderDetail() {
  const server = state.detail;
  const ctx = state.detailContext;
  if (!server) {
    const error = state.detailLoading ? 'Loading node details…' : ctx?.detailError || 'No server was found for this ID.';
    const feedback = state.detailLoading ? `<div class="loading-state"><span class="loader"></span><span>${esc(error)}</span></div>` : `<div class="notice error" style="margin-top:18px">${esc(error)}</div>`;
    main.innerHTML = `${statusBannerFor(ctx)}<section class="detail-page"><a class="back-link" href="#/">← Back to overview</a>${feedback}<p><a class="gate-link" href="${esc(adminHref(ctx))}">Open CFSM admin ↗</a></p></section>`;
    return;
  }
  const online = server._online;
  const cpu = clamp(server.cpu);
  const ram = percent(server.ram_used, server.ram_total);
  const disk = percent(server.disk_used, server.disk_total);
  const net = `↓ ${bytes(server.net_in_speed, true)}  ·  ↑ ${bytes(server.net_out_speed, true)}`;
  const info = [
    ['Region', server.region || server.server_group || '—'], ['Operating system', server.os || '—'],
    ['Kernel', server.kernel_version || '—'], ['Architecture', server.arch || '—'],
    ['CPU model', server.cpu_info || '—'], ['CPU cores', server.cpu_cores || '—'],
    ['Uptime', formatUptime(server.boot_time)], ['Agent', server.agent_version || '—'],
    ['IPv4', server.ip_v4 === '1' ? 'Available' : server.ip_v4 === '0' ? 'Unavailable' : '—'],
    ['IPv6', server.ip_v6 === '1' ? 'Available' : server.ip_v6 === '0' ? 'Unavailable' : '—'],
    ['GPU', gpuLabel(server.gpu_info)], ['Last report', server._updatedAt ? new Date(server._updatedAt).toLocaleString() : '—']
  ];
  main.innerHTML = `${statusBannerFor(ctx)}<section class="detail-page">
    <div class="detail-heading"><a class="back-link" href="#/">← Overview</a><div class="detail-title"><span class="panel-number">NODE DETAIL</span><h1>${esc(server.name || 'Unnamed server')}</h1><p>${esc(server.server_group || server.region || 'Unassigned')} ${server.tags ? `· ${esc(server.tags)}` : ''}</p></div><span class="detail-status ${online ? '' : 'offline'}"><i class="server-state ${online ? '' : 'offline'}"></i>${online ? 'Online' : 'Offline'}</span></div>
    <div class="detail-cards">
      ${detailMetric('CPU', `${cpu.toFixed(1)}%`, server.cpu_info || `${server.cpu_cores || '—'} cores`, cpu)}
      ${detailMetric('MEMORY', ram == null ? '—' : `${ram.toFixed(1)}%`, `${mib(server.ram_used)} / ${mib(server.ram_total)}`, ram)}
      ${detailMetric('DISK', disk == null ? '—' : `${disk.toFixed(1)}%`, `${mib(server.disk_used)} / ${mib(server.disk_total)}`, disk)}
      ${detailMetric('NETWORK', net, `Processes ${server.processes ?? '—'} · TCP ${server.tcp_conn ?? '—'} · UDP ${server.udp_conn ?? '—'}`)}
    </div>
    <div class="detail-columns"><section class="history-panel"><div class="panel-head"><h2 class="panel-title">Metrics history</h2><span class="panel-meta">last 24 hours · when available</span></div>${ctx?.historyError ? `<div class="notice error"><span>${esc(ctx.historyError)}</span><button data-action="retry-history">Retry</button></div>` : ''}<div class="history-legend"><span><i class="legend-dot"></i>CPU</span><span><i class="legend-dot ram"></i>Memory</span><span><i class="legend-dot disk"></i>Disk</span></div>${ctx?.historyError ? '' : historyGraph(state.history)}</section>
      <section class="system-panel"><div class="panel-head"><h2 class="panel-title">System information</h2><span class="panel-meta">${esc(server._apiBase || '')}</span></div><div class="system-grid">${info.map(([label, value]) => `<div class="system-item"><span class="system-label">${esc(label)}</span><span class="system-value">${esc(value)}</span></div>`).join('')}</div></section>
    </div>
  </section>`;
}
function renderGateCards() {
  const pending = state.contexts.filter((ctx) => ctx.config?.turnstile_enabled && !ctx.verified && !ctx.dataLoaded && !ctx.configError);
  gateArea.innerHTML = pending.map((ctx, index) => `<div class="gate-card" data-gate-base="${esc(ctx.base)}"><div class="gate-copy"><strong>Human verification required</strong><p>${esc(ctx.base)} · verify to load this worker's public monitor data.</p></div><div class="turnstile-slot" id="turnstile-${index}"></div></div>`).join('');
  for (const [index, ctx] of pending.entries()) mountTurnstile(ctx, `turnstile-${index}`);
}
let turnstileLoader = null;
function loadTurnstileScript() {
  if (window.turnstile) return Promise.resolve();
  if (turnstileLoader) return turnstileLoader;
  turnstileLoader = new Promise((resolve, reject) => {
    const existing = document.querySelector('script[data-cfsm-turnstile]');
    if (existing) {
      existing.addEventListener('load', resolve, { once: true });
      existing.addEventListener('error', reject, { once: true });
      return;
    }
    const script = document.createElement('script');
    script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    script.async = true;
    script.defer = true;
    script.dataset.cfsmTurnstile = 'true';
    script.onload = resolve;
    script.onerror = reject;
    document.head.appendChild(script);
  });
  return turnstileLoader;
}
async function mountTurnstile(ctx, elementId) {
  const target = document.getElementById(elementId);
  if (!target) return;
  if (!ctx.config?.turnstile_site_key) {
    target.innerHTML = '<span class="notice warning">The API did not return a Turnstile site key. Check the CFSM verification settings.</span>';
    return;
  }
  try {
    await loadTurnstileScript();
    if (!document.getElementById(elementId) || !window.turnstile) return;
    window.turnstile.render(`#${elementId}`, {
      sitekey: ctx.config.turnstile_site_key,
      callback: async (token) => {
        target.innerHTML = '<span class="detail-live"><i class="loader"></i>Verifying and loading server data…</span>';
        try {
          const fresh = await request(ctx, '/api/config', { turnstileToken: token });
          ctx.config = fresh || ctx.config;
          ctx.verified = fresh?.turnstile_verified || '';
          if (!ctx.verified) throw new ApiError(403, 'The Worker did not return a reusable Turnstile verification credential.');
          saveVerified(ctx.base, ctx.verified);
          if (state.route.type === 'detail') await loadDetail(state.route);
          else await loadServers(ctx);
          renderGateCards();
          render();
          connectAllLive();
        } catch (error) {
          ctx.dataError = error.message;
          ctx.dataStatus = error.status || 0;
          target.innerHTML = `<span class="notice error">Verification failed: ${esc(error.message)}. Please try again.</span>`;
        }
      },
      'expired-callback': () => {
        ctx.verified = '';
        clearVerified(ctx.base);
      },
      'error-callback': () => { target.innerHTML = '<span class="notice error">Turnstile failed to load. Check the site CSP allowlist for connect and script sources.</span>'; }
    });
  } catch {
    target.innerHTML = '<span class="notice error">Could not load Cloudflare Turnstile. Check the network and allow challenges.cloudflare.com in the site CSP.</span>';
  }
}

async function loadServers(ctx) {
  if (!ctx.config || ctx.configError) return;
  try {
    const result = await request(ctx, '/api/servers');
    ctx.servers = (Array.isArray(result?.servers) ? result.servers : []).map((server) => normalizeServer(server, ctx));
    ctx.stats = result?.stats || {};
    ctx.regionStats = result?.regionStats || {};
    ctx.sysConfig = result?.sysConfig || {};
    ctx.dataLoaded = true;
    ctx.dataError = '';
    ctx.dataStatus = 200;
    state.dataErrors = state.contexts.filter((item) => item.dataError);
    state.servers = getServers();
    state.serversLoaded = true;
    appendFlowSample(true);
  } catch (error) {
    ctx.dataError = error.message;
    ctx.dataStatus = error.status || 0;
    if (error.status === 403 && ctx.config?.turnstile_enabled) {
      ctx.verified = '';
      clearVerified(ctx.base);
      ctx.dataLoaded = false;
      renderGateCards();
    }
    state.dataErrors = state.contexts.filter((item) => item.dataError);
  }
}
async function loadAllServers() {
  await Promise.all(state.contexts.map((ctx) => loadServers(ctx)));
  state.servers = getServers();
  state.serversLoaded = true;
  state.contexts.forEach((ctx) => { ctx.initialSnapshot = true; });
  render();
  connectAllLive();
}
function appendFlowSample(force = false) {
  const now = Date.now();
  const last = state.flow.at(-1);
  if (!force && last && now - last.at < 4500) return;
  const speeds = totalTraffic();
  state.flow.push({ at: now, down: speeds.down, up: speeds.up });
  if (state.flow.length > 90) state.flow.splice(0, state.flow.length - 90);
}
function closeLive() {
  for (const timer of state.reconnectTimers) clearTimeout(timer);
  for (const timer of state.pollTimers) clearInterval(timer);
  for (const timer of state.timeoutTimers) clearTimeout(timer);
  state.reconnectTimers = [];
  state.pollTimers = [];
  state.timeoutTimers = [];
  const sockets = state.sockets;
  state.sockets = [];
  for (const socket of sockets) {
    socket.__manualClose = true;
    try { socket.close(1000, 'view changed'); } catch { /* already closed */ }
  }
}
function mergeUpdate(server, patch, stamp) {
  const oldOnline = server._online;
  const next = { ...server, ...patch };
  if (patch.is_online === true || patch.is_online === false) next._online = patch.is_online;
  else {
    const reportTime = safeNum(patch.last_updated || stamp || next.last_updated || server._updatedAt);
    if (reportTime) next._online = Date.now() - reportTime <= 5 * 60 * 1000;
  }
  next._updatedAt = safeNum(next.last_updated || stamp || server._updatedAt);
  if (server._online !== undefined && oldOnline !== next._online) {
    state.events.unshift({ name: server.name || 'Unnamed server', online: next._online, at: stamp || Date.now() });
    state.events = state.events.slice(0, 20);
  }
  Object.assign(server, next);
}
function applyBatch(ctx, message) {
  if (message?.type !== 'batchUpdate' || !Array.isArray(message.updates)) return;
  const index = new Map((ctx.servers || []).map((server) => [String(server.id), server]));
  for (const update of message.updates) {
    const server = index.get(String(update.serverId));
    if (!server) continue;
    for (const sample of update.samples || []) {
      const patch = sample.data || sample.payload || sample.metrics || {};
      mergeUpdate(server, patch, sample.ts || message.ts);
    }
  }
  state.servers = getServers();
  appendFlowSample();
  scheduleRender();
}
function socketUrl(ctx, subscribe) {
  const url = new URL(ctx.base);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = `${url.pathname.replace(/\/$/, '')}/api/ws`.replace(/^\/\//, '/');
  url.search = '';
  url.searchParams.set('subscribe', subscribe);
  const current = new URL(window.location.href);
  const token = getToken();
  if (url.host !== current.host && token) url.searchParams.set('token', token);
  return url.toString();
}
function scheduleSocketReconnect(ctx, subscribe, ids, retryCount) {
  if (state.hidden || state.reconnectStopped) return;
  const retries = Math.min(retryCount + 1, 8);
  const delay = Math.min(30000, 1000 * (2 ** Math.min(retries, 5)));
  const timer = setTimeout(() => {
    state.reconnectTimers = state.reconnectTimers.filter((item) => item !== timer);
    const onHome = subscribe === 'all' && state.route.type === 'home';
    const onDetail = subscribe !== 'all' && state.route.type === 'detail'
      && state.detailContext === ctx && String(state.detail?.id) === String(subscribe);
    if (!state.hidden && !state.reconnectStopped && (onHome || onDetail)) {
      connectSocket(ctx, subscribe, ids, retries);
    }
  }, delay);
  state.reconnectTimers.push(timer);
}
function connectSocket(ctx, subscribe = 'all', ids = null, retryCount = 0) {
  if (state.hidden || state.reconnectStopped) return null;
  if (!('WebSocket' in window)) {
    startPolling(ctx);
    return null;
  }
  let socket;
  try { socket = new window.WebSocket(socketUrl(ctx, subscribe)); }
  catch {
    startPolling(ctx);
    scheduleSocketReconnect(ctx, subscribe, ids, retryCount);
    return null;
  }
  socket.__ctx = ctx;
  socket.__manualClose = false;
  socket.__retries = retryCount;
  state.sockets.push(socket);
  renderHeader();
  const timeout = safeNum(ctx.config?.frontend_ws_timeout_minutes);
  if (timeout > 0) {
    const timer = setTimeout(() => {
      const keepGoing = window.confirm(`This live connection has run for ${timeout} minutes. Reconnect now?`);
      if (keepGoing) {
        try { socket.close(1000, 'user renewed live session'); } catch { /* ignore */ }
        state.reconnectStopped = false;
      } else {
        state.reconnectStopped = true;
        closeLive();
        renderHeader();
      }
    }, timeout * 60 * 1000);
    socket.__timeoutTimer = timer;
    state.timeoutTimers.push(timer);
  }
  let heartbeat = null;
  socket.addEventListener('open', () => {
    socket.__stableTimer = setTimeout(() => { socket.__retries = 0; }, 30000);
    stopPolling(ctx);
    if (subscribe === 'all' && Array.isArray(ids)) {
      socket.send(JSON.stringify({ type: 'subscribe', scope: 'all', ids }));
    }
    heartbeat = setInterval(() => {
      if (socket.readyState === window.WebSocket.OPEN) socket.send(JSON.stringify({ type: 'ping', ts: Date.now() }));
    }, 30000);
    renderHeader();
  });
  socket.addEventListener('message', (event) => {
    try { applyBatch(ctx, JSON.parse(event.data)); } catch { /* malformed push is ignored */ }
  });
  socket.addEventListener('close', () => {
    if (heartbeat) clearInterval(heartbeat);
    if (socket.__stableTimer) clearTimeout(socket.__stableTimer);
    if (socket.__timeoutTimer) {
      clearTimeout(socket.__timeoutTimer);
      state.timeoutTimers = state.timeoutTimers.filter((timer) => timer !== socket.__timeoutTimer);
    }
    state.sockets = state.sockets.filter((item) => item !== socket);
    renderHeader();
    if (!socket.__manualClose && !state.hidden && !state.reconnectStopped) {
      startPolling(ctx);
      scheduleSocketReconnect(ctx, subscribe, ids, socket.__retries || 0);
    }
  });
  socket.addEventListener('error', () => {
    startPolling(ctx);
    renderHeader();
  });
  return socket;
}
function connectListSockets(ctx) {
  const ids = (ctx.servers || []).map((server) => String(server.id)).filter((id) => /^[A-Za-z0-9._:-]{1,64}$/.test(id));
  if (!ids.length) return startPolling(ctx);
  for (let index = 0; index < ids.length; index += 500) connectSocket(ctx, 'all', ids.slice(index, index + 500));
}
function connectAllLive() {
  if (state.route.type === 'detail') return;
  closeLive();
  state.reconnectStopped = false;
  for (const ctx of state.contexts) {
    if (!ctx.dataLoaded || ctx.dataError || ctx.configError || (ctx.config?.turnstile_enabled && !ctx.verified)) continue;
    if (ctx.servers?.length) connectListSockets(ctx);
    else startPolling(ctx);
  }
}
function startPolling(ctx) {
  if (state.pollTimers.some((timer) => timer.__ctx === ctx) || state.hidden) return;
  const timer = setInterval(async () => {
    if (state.hidden) return;
    if (state.route.type === 'detail' && state.detailContext === ctx && state.detail) {
      try {
        const data = await request(ctx, `/api/server?id=${encodeURIComponent(state.detail.id)}`);
        const old = state.detail;
        const next = normalizeServer(data, ctx);
        mergeUpdate(old, next);
        state.detail = old;
        ctx.detailError = '';
        render();
      } catch (error) {
        ctx.detailError = error.message;
        ctx.detailStatus = error.status || 0;
        if (error.status === 403 && ctx.config?.turnstile_enabled) {
          ctx.verified = '';
          ctx.dataLoaded = false;
          clearVerified(ctx.base);
          renderGateCards();
        }
        render();
      }
    } else if (state.route.type === 'home') {
      await loadServers(ctx);
      state.servers = getServers();
      render();
    }
  }, 30000);
  timer.__ctx = ctx;
  state.pollTimers.push(timer);
  renderHeader();
}
function stopPolling(ctx) {
  const keep = [];
  for (const timer of state.pollTimers) {
    if (!ctx || timer.__ctx === ctx) clearInterval(timer);
    else keep.push(timer);
  }
  state.pollTimers = keep;
  renderHeader();
}
function scheduleRender() {
  if (state.renderQueued) return;
  state.renderQueued = true;
  requestAnimationFrame(() => { state.renderQueued = false; render(); });
}
async function loadDetail(route) {
  const requestId = ++state.detailRequestId;
  closeLive();
  state.detail = null;
  state.history = [];
  state.detailLoading = true;
  state.detailContext = null;
  state.route = route;
  renderHeader();
  render();
  const known = getServers().find((server) => String(server.id) === String(route.id));
  const candidates = known ? state.contexts.filter((ctx) => ctx.base === known._apiBase) : state.contexts;
  for (const ctx of candidates) {
    if (!ctx.config || ctx.configError) continue;
    try {
      const data = await request(ctx, `/api/server?id=${encodeURIComponent(route.id)}`);
      if (requestId !== state.detailRequestId || state.route.type !== 'detail' || state.route.id !== route.id) return;
      if (!data || !data.id) continue;
      state.detailContext = ctx;
      state.detail = normalizeServer(data, ctx);
      ctx.detailError = '';
      ctx.historyError = '';
      render();
      void loadHistory(ctx, route.id);
      if (document.visibilityState === 'visible') connectSocket(ctx, String(route.id));
      state.detailLoading = false;
      return;
    } catch (error) {
      if (requestId !== state.detailRequestId || state.route.type !== 'detail' || state.route.id !== route.id) return;
      state.detailContext = ctx;
      ctx.detailError = error.message;
      ctx.detailStatus = error.status || 0;
      if (error.status === 403 && ctx.config?.turnstile_enabled) {
        ctx.verified = '';
        ctx.dataLoaded = false;
        clearVerified(ctx.base);
        renderGateCards();
      }
      if (error.status === 404) continue;
      if (error.status === 401) break;
    }
  }
  if (!state.detailContext) {
    const failed = state.contexts.find((ctx) => ctx.configError);
    if (failed) {
      state.detailContext = failed;
      failed.detailError = failed.configError;
    }
  }
  state.detailLoading = false;
  render();
}
async function loadHistory(ctx, id) {
  try {
    const rows = await request(ctx, `/api/history/all?id=${encodeURIComponent(id)}&hours=24`);
    if (state.route.type !== 'detail' || state.route.id !== String(id) || state.detailContext !== ctx) return;
    state.history = Array.isArray(rows) ? rows : [];
    ctx.historyError = '';
  } catch (error) {
    if (state.route.type !== 'detail' || state.route.id !== String(id) || state.detailContext !== ctx) return;
    state.history = [];
    ctx.historyError = error.message;
    ctx.historyStatus = error.status || 0;
  }
  if (state.route.type === 'detail' && state.route.id === String(id) && state.detailContext === ctx) render();
}
async function handleRoute() {
  const route = readRoute();
  if (route.type === 'detail') {
    if (state.route.type === 'detail' && state.route.id === route.id && state.detail) return;
    await loadDetail(route);
    return;
  }
  state.detailRequestId += 1;
  state.route = { type: 'home', id: '' };
  state.detail = null;
  state.detailContext = null;
  closeLive();
  renderHeader();
  if (!state.serversLoaded) await loadAllServers();
  else {
    render();
    connectAllLive();
  }
}
function render() {
  const active = document.activeElement;
  const keepSearch = active?.id === 'server-search';
  const cursorStart = keepSearch ? active.selectionStart : null;
  const cursorEnd = keepSearch ? active.selectionEnd : null;
  if (state.route.type === 'detail') renderDetail();
  else renderHome();
  renderHeader();
  if (keepSearch) {
    const search = $('#server-search');
    if (search) {
      search.focus({ preventScroll: true });
      if (cursorStart != null && cursorEnd != null) search.setSelectionRange(cursorStart, cursorEnd);
    }
  }
}
function retryContext(base, turnstile = false) {
  const ctx = state.contexts.find((item) => item.base === base);
  if (!ctx) return;
  ctx.dataError = '';
  ctx.dataStatus = 0;
  if (turnstile) {
    ctx.verified = '';
    ctx.dataLoaded = false;
    clearVerified(ctx.base);
    renderGateCards();
    render();
    return;
  }
  loadServers(ctx).then(() => { render(); connectAllLive(); });
}
function exportCurrentAdminPath(ctx) { return adminHref(ctx); }
function onClick(event) {
  const actionEl = event.target.closest('[data-action]');
  if (state.themeMenuOpen && !event.target.closest('.tone-control')) {
    state.themeMenuOpen = false;
    renderHeader();
  }
  if (!actionEl) return;
  const action = actionEl.dataset.action;
  if (action === 'theme-menu-toggle') {
    state.themeMenuOpen = !state.themeMenuOpen;
    renderHeader();
    if (state.themeMenuOpen) header.querySelector(`[data-theme-choice="${state.theme}"]`)?.focus({ preventScroll: true });
    else header.querySelector('[data-action="theme-menu-toggle"]')?.focus({ preventScroll: true });
  } else if (action === 'theme-choice') {
    state.themeMenuOpen = false;
    setTheme(actionEl.dataset.themeChoice);
    header.querySelector('[data-action="theme-menu-toggle"]')?.focus({ preventScroll: true });
  } else if (action === 'retry-history') {
    const ctx = state.detailContext;
    if (ctx && state.detail) void loadHistory(ctx, state.detail.id);
  }
  else if (action === 'open-server') {
    const id = actionEl.dataset.id;
    if (id) window.location.hash = `#/server/${escapeId(id)}`;
  } else if (action === 'retry-base') retryContext(actionEl.dataset.base);
  else if (action === 'retry-turnstile') retryContext(actionEl.dataset.base, true);
  else if (action === 'reload-current') handleRoute();
}
function onKeyDown(event) {
  if (event.key === 'Escape' && state.themeMenuOpen) {
    state.themeMenuOpen = false;
    renderHeader();
    header.querySelector('[data-action="theme-menu-toggle"]')?.focus({ preventScroll: true });
  }
}
function onInput(event) {
  if (event.target.id === 'server-search') {
    state.query = event.target.value;
    const rows = $('#server-rows');
    if (rows) rows.innerHTML = renderServerRows();
  }
}
function onChange(event) {
  if (event.target.id === 'server-filter') {
    state.filter = event.target.value;
    const rows = $('#server-rows');
    if (rows) rows.innerHTML = renderServerRows();
  }
}
async function refreshVisibleView() {
  if (state.route.type === 'detail' && state.detailContext && state.detail) {
    const ctx = state.detailContext;
    try {
      const data = await request(ctx, `/api/server?id=${encodeURIComponent(state.detail.id)}`);
      state.detail = normalizeServer(data, ctx);
      await loadHistory(ctx, state.detail.id);
      ctx.detailError = '';
      render();
      connectSocket(ctx, String(state.detail.id));
    } catch (error) {
      ctx.detailError = error.message;
      ctx.detailStatus = error.status || 0;
      if (error.status === 403 && ctx.config?.turnstile_enabled) {
        ctx.verified = '';
        ctx.dataLoaded = false;
        clearVerified(ctx.base);
        renderGateCards();
      }
      render();
      startPolling(ctx);
    }
  } else if (state.route.type === 'home') {
    await loadAllServers();
  }
}
function onVisibilityChange() {
  state.hidden = document.visibilityState !== 'visible';
  if (state.hidden) {
    closeLive();
    renderHeader();
  } else {
    refreshVisibleView();
  }
}
async function boot() {
  const initialRoute = readRoute();
  state.route = initialRoute;
  state.theme = readThemePreference();
  document.documentElement.dataset.theme = state.theme;
  const themeColor = $('meta[name="theme-color"]');
  if (themeColor) themeColor.content = state.theme === 'umbrella' ? '#0a0a0b' : '#fbf0f2';
  const themeIcon = $('link[rel="icon"][data-umbrella]');
  if (themeIcon) themeIcon.href = themeIcon.getAttribute(state.theme === 'umbrella' ? 'data-umbrella' : 'data-romance');
  if (state.theme === 'umbrella') writeStorage('meridian.site.tone', 'umbrella');
  else removeStorage('meridian.site.tone');
  removeStorage('cfsm-theme-tone');
  const bases = getApiBases();
  state.contexts = bases.map((base) => ({ base, config: null, configError: '', configStatus: 0, dataError: '', dataStatus: 0, servers: [], verified: '' }));
  await Promise.all(state.contexts.map((ctx) => loadConfig(ctx)));
  renderHeader();
  renderGateCards();
  if (initialRoute.type === 'home') {
    for (const ctx of state.contexts) {
      if (ctx.config?.turnstile_enabled && !ctx.verified) continue;
      if (!ctx.configError) await loadServers(ctx);
    }
  }
  state.servers = getServers();
  state.serversLoaded = state.contexts.every((ctx) => ctx.dataLoaded || ctx.configError || (ctx.config?.turnstile_enabled && !ctx.verified));
  state.contexts.forEach((ctx) => { ctx.initialSnapshot = true; });
  state.flow = [];
  appendFlowSample(true);
  render();
  window.setInterval(updateClock, 1000);
  window.addEventListener('hashchange', handleRoute);
  document.addEventListener('click', onClick);
  document.addEventListener('input', onInput);
  document.addEventListener('change', onChange);
  document.addEventListener('keydown', onKeyDown);
  document.addEventListener('visibilitychange', onVisibilityChange);
  await handleRoute();
}

boot().catch((error) => {
  main.innerHTML = `<div class="notice error">Theme initialization failed: ${esc(error?.message || 'Unknown error')}. Refresh or check the Worker API address.</div>`;
});
