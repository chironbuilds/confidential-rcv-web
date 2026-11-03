// Shared UI kit for every Privote page: icons, toasts, theme, API + activity log, formatting.
// Plain script (no modules) so it works in Tari Universe's dApp iframe without a bundler.
(function () {
  const $ = (sel, root = document) => (sel.startsWith('#') && !/[\s.[>]/.test(sel) ? document.getElementById(sel.slice(1)) : root.querySelector(sel));
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  // ---------- icons (Lucide-style strokes, inline so nothing loads cross-origin) ----------
  const P = {
    plus: '<path d="M12 5v14M5 12h14"/>',
    vote: '<path d="m9 12 2 2 4-4"/><path d="M5 7c0-1.1.9-2 2-2h10a2 2 0 0 1 2 2v12H5V7Z"/><path d="M22 19H2"/>',
    lock: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
    shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z"/><path d="m9 12 2 2 4-4"/>',
    eyeoff: '<path d="M9.9 4.24A9 9 0 0 1 12 4c7 0 10 8 10 8a13.2 13.2 0 0 1-1.67 2.68"/><path d="M6.61 6.61A13.5 13.5 0 0 0 2 12s3 8 10 8a9.7 9.7 0 0 0 5.39-1.61"/><path d="M14.12 14.12a3 3 0 1 1-4.24-4.24"/><path d="m2 2 20 20"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
    x: '<path d="M18 6 6 18M6 6l12 12"/>',
    copy: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
    link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
    ext: '<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
    clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
    users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>',
    ballot: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6M9 15l2 2 4-4"/>',
    trophy: '<path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6M18 9h1.5a2.5 2.5 0 0 0 0-5H18M4 22h16M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22"/><path d="M18 2H6v7a6 6 0 0 0 12 0V2Z"/>',
    chart: '<path d="M3 3v18h18"/><path d="M7 16v-4M12 16V8M17 16v-7"/>',
    layers: '<path d="m12 2 10 5-10 5L2 7l10-5Z"/><path d="m2 17 10 5 10-5M2 12l10 5 10-5"/>',
    split: '<path d="M16 3h5v5M8 3H3v5M12 22v-8.3a4 4 0 0 0-1.17-2.83L3 3M21 3l-7.83 7.87A4 4 0 0 0 12 13.7"/>',
    target: '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/>',
    repeat: '<path d="m17 2 4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14M7 22l-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/>',
    wallet: '<path d="M19 7V4a1 1 0 0 0-1-1H5a2 2 0 0 0 0 4h15a1 1 0 0 1 1 1v4h-3a2 2 0 0 0 0 4h3a1 1 0 0 0 1-1v-2a1 1 0 0 0-1-1"/><path d="M3 5v14a2 2 0 0 0 2 2h15a1 1 0 0 0 1-1v-4"/>',
    server: '<rect x="2" y="2" width="20" height="8" rx="2"/><rect x="2" y="14" width="20" height="8" rx="2"/><path d="M6 6h.01M6 18h.01"/>',
    search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
    up: '<path d="m18 15-6-6-6 6"/>',
    down: '<path d="m6 9 6 6 6-6"/>',
    left: '<path d="m15 18-6-6 6-6"/>',
    right: '<path d="m9 18 6-6-6-6"/>',
    grip: '<circle cx="9" cy="6" r="1"/><circle cx="15" cy="6" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="9" cy="18" r="1"/><circle cx="15" cy="18" r="1"/>',
    trash: '<path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
    upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12"/>',
    download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>',
    refresh: '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/>',
    moon: '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>',
    info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/>',
    alert: '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><path d="M12 9v4M12 17h.01"/>',
    terminal: '<path d="m4 17 6-6-6-6M12 19h8"/>',
    flag: '<path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1zM4 22v-7"/>',
    sparkles: '<path d="m12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3L21 12l-5.8-1.9a2 2 0 0 1-1.3-1.3Z"/>',
    calendar: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
    zap: '<path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z"/>',
    code: '<path d="m16 18 6-6-6-6M8 6l-6 6 6 6"/>',
    home: '<path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M9 22V12h6v10"/>',
  };
  const icon = (name, cls = '') => `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${P[name] || ''}</svg>`;
  const hydrateIcons = (root = document) => $$('[data-icon]', root).forEach((el) => {
    el.insertAdjacentHTML('afterbegin', icon(el.dataset.icon));
    el.removeAttribute('data-icon');
  });

  // ---------- theme ----------
  const THEME_KEY = 'privote-theme';
  const store = {
    get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
    set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* storage unavailable */ } },
    del: (k) => { try { localStorage.removeItem(k); } catch { /* storage unavailable */ } },
  };
  function applyTheme(t) {
    document.documentElement.dataset.theme = t;
    const b = document.getElementById('btn-theme');
    if (b) {
      b.innerHTML = icon(t === 'light' ? 'moon' : 'sun');
      b.title = t === 'light' ? 'Dark mode' : 'Light mode';
    }
  }
  const initialTheme = store.get(THEME_KEY) || (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
  applyTheme(initialTheme);

  // ---------- toasts ----------
  function toast(title, msg = '', kind = 'info', ms = 5000) {
    let host = document.querySelector('.toasts');
    if (!host) {
      host = document.createElement('div');
      host.className = 'toasts';
      host.setAttribute('role', 'status');
      host.setAttribute('aria-live', 'polite');
      document.body.appendChild(host);
    }
    const el = document.createElement('div');
    el.className = `toast ${kind}`;
    el.innerHTML = `<span class="t-ico">${icon(kind === 'ok' ? 'check' : kind === 'err' ? 'alert' : 'info')}</span>
      <div class="t-body"><div class="t-title">${esc(title)}</div>${msg ? `<div class="t-msg">${esc(msg)}</div>` : ''}</div>
      <button class="t-close" aria-label="Dismiss">×</button>`;
    const close = () => {
      el.classList.add('leaving');
      setTimeout(() => el.remove(), 250);
    };
    el.querySelector('.t-close').onclick = close;
    host.appendChild(el);
    if (ms) setTimeout(close, ms);
    return close;
  }

  // ---------- activity log (the old "terminal", now a drawer) ----------
  const logLines = [];
  function log(msg, cls = '') {
    const t = new Date().toISOString().slice(11, 19);
    logLines.push({ t, msg, cls });
    if (logLines.length > 400) logLines.shift();
    const c = document.getElementById('activity-count');
    if (c) c.textContent = String(logLines.length);
    const pre = document.getElementById('activity-log');
    if (pre && !pre.closest('[hidden]')) renderLog();
  }
  function renderLog() {
    const pre = document.getElementById('activity-log');
    if (!pre) return;
    pre.innerHTML = logLines.map((l) => `<div class="${l.cls}"><span class="t">${l.t}</span> ${l.msg}</div>`).join('');
    pre.scrollTop = pre.scrollHeight;
  }
  function mountActivity() {
    if (document.getElementById('activity-fab')) return;
    document.body.insertAdjacentHTML('beforeend', `
      <button class="activity-fab" id="activity-fab" aria-expanded="false" aria-controls="activity-drawer">${icon('terminal')} Activity <span class="count" id="activity-count">${logLines.length}</span></button>
      <div class="drawer" id="activity-drawer" hidden>
        <div class="drawer-head">${icon('terminal', 'inline-svg')} Activity log <span class="spacer"></span>
          <button class="btn btn-sm btn-ghost" id="activity-copy">Copy</button>
          <button class="btn btn-sm btn-ghost" id="activity-clear">Clear</button>
          <button class="icon-btn" id="activity-close" aria-label="Close" style="width:30px;height:30px;border:0">${icon('x')}</button>
        </div>
        <pre class="log" id="activity-log"></pre>
      </div>`);
    const fab = document.getElementById('activity-fab');
    const drawer = document.getElementById('activity-drawer');
    const toggle = (open) => {
      drawer.hidden = !open;
      fab.setAttribute('aria-expanded', String(open));
      if (open) renderLog();
    };
    fab.onclick = () => toggle(drawer.hidden);
    document.getElementById('activity-close').onclick = () => toggle(false);
    document.getElementById('activity-clear').onclick = () => {
      logLines.length = 0;
      document.getElementById('activity-count').textContent = '0';
      renderLog();
    };
    document.getElementById('activity-copy').onclick = () => copyText(logLines.map((l) => `[${l.t}] ${l.msg.replace(/<[^>]+>/g, '')}`).join('\n'));
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') toggle(false); });
  }

  // ---------- API ----------
  async function api(path, opts = {}) {
    const method = opts.method || 'GET';
    if (!opts.quiet) log(`<span class="ok">→</span> ${esc(method)} ${esc(path)}`);
    let res;
    try {
      res = await fetch(path, {
        method,
        headers: opts.body ? { 'Content-Type': 'application/json' } : undefined,
        body: opts.body ? JSON.stringify(opts.body) : undefined,
      });
    } catch (e) {
      log(`<span class="err">✗ network</span> ${esc(e.message)}`, 'err');
      throw new Error('Could not reach the Privote server. Check your connection.');
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      log(`<span class="err">✗ ${res.status}</span> ${esc(JSON.stringify(data))}`, 'err');
      throw new Error(data.error || `HTTP ${res.status}`);
    }
    if (!opts.quiet) log(`<span class="ok">✓</span> ${esc(JSON.stringify(data).slice(0, 220))}`);
    return data;
  }

  // ---------- clipboard ----------
  async function copyText(text, btn) {
    let ok = false;
    try {
      await navigator.clipboard.writeText(text);
      ok = true;
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try { ok = document.execCommand('copy'); } catch { ok = false; }
      ta.remove();
    }
    if (btn) {
      const prev = btn.innerHTML;
      btn.classList.add('copied');
      btn.innerHTML = btn.classList.contains('copy-btn') ? icon('check') : `${icon('check')} Copied`;
      setTimeout(() => { btn.classList.remove('copied'); btn.innerHTML = prev; }, 1400);
    } else {
      toast(ok ? 'Copied to clipboard' : 'Copy failed', '', ok ? 'ok' : 'err', 1800);
    }
    return ok;
  }
  const copyBtn = (value, label = 'Copy') => `<button type="button" class="copy-btn" data-copy="${esc(value)}" title="${esc(label)}" aria-label="${esc(label)}">${icon('copy')}</button>`;
  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-copy]');
    if (b) { e.preventDefault(); copyText(b.dataset.copy, b); }
  });

  // ---------- formatting ----------
  const PALETTE = ['#8b7bff', '#4fd1e8', '#f472b6', '#f6c453', '#3ddc97', '#fb923c', '#60a5fa', '#c084fc', '#2dd4bf', '#f87171', '#a3e635', '#e879f9'];
  const colorFor = (i) => PALETTE[Number(i) % PALETTE.length];
  const initials = (name) => {
    const parts = String(name || '?').trim().split(/\s+/).filter(Boolean);
    const s = parts.length > 1 ? parts[0][0] + parts[1][0] : (parts[0] || '?').slice(0, 2);
    return s.toUpperCase();
  };
  const avatar = (name, i, cls = '') => `<span class="avatar ${cls}" style="--c:${colorFor(i)}">${esc(initials(name))}</span>`;
  const short = (s, a = 10, b = 6) => (s && s.length > a + b + 1 ? `${s.slice(0, a)}…${s.slice(-b)}` : s || '');

  function relTime(ms) {
    const diff = ms - Date.now();
    const abs = Math.abs(diff);
    const units = [['day', 86400e3], ['hour', 3600e3], ['minute', 60e3]];
    for (const [u, v] of units) {
      if (abs >= v) {
        const n = Math.round(abs / v);
        return diff > 0 ? `in ${n} ${u}${n === 1 ? '' : 's'}` : `${n} ${u}${n === 1 ? '' : 's'} ago`;
      }
    }
    return diff > 0 ? 'in under a minute' : 'just now';
  }
  const fmtDate = (ms) => new Date(ms).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  function splitDuration(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    return { d: Math.floor(s / 86400), h: Math.floor((s % 86400) / 3600), m: Math.floor((s % 3600) / 60), s: s % 60 };
  }

  const METHODS = {
    irv: { name: 'Instant runoff', short: 'IRV', icon: 'repeat', desc: 'One winner. Lowest candidate is eliminated each round and their ballots move to the next choice until someone has a majority.', ranked: true, multi: false },
    'sequential-irv': { name: 'Sequential IRV', short: 'Seq. IRV', icon: 'layers', desc: 'Several winners. Runs instant runoff once per seat, removing each winner before the next seat.', ranked: true, multi: true },
    stv: { name: 'Single transferable vote', short: 'STV', icon: 'split', desc: 'Several winners, proportional. Candidates reaching the Droop quota are elected and surplus votes transfer.', ranked: true, multi: true },
    fptp: { name: 'First past the post', short: 'FPTP', icon: 'target', desc: 'One winner, one choice per voter. Most votes wins. Two candidates make it a yes / no vote.', ranked: false, multi: false },
  };

  /** Election phase from a record: { key, label, cls, endsAt } */
  function phaseOf(e, nowEpoch) {
    const endsAt = e.expiresAtUtc ? Date.parse(e.expiresAtUtc) : null;
    const epoch = nowEpoch ?? e.epoch;
    if (e.status === 'ended') return { key: 'ended', label: 'Results final', cls: 'ended', endsAt };
    if (epoch != null && e.expiresAtEpoch != null && epoch > e.expiresAtEpoch) return { key: 'expired', label: 'Voting closed', cls: 'closing', endsAt };
    if (endsAt && endsAt - Date.now() < 3600e3) return { key: 'closing', label: 'Closing soon', cls: 'closing', endsAt };
    return { key: 'open', label: 'Voting open', cls: 'open', endsAt };
  }
  const badge = (ph) => `<span class="badge ${ph.cls}"><span class="dot"></span>${esc(ph.label)}</span>`;

  // ---------- header ----------
  let statusCache = null;
  async function loadStatus() {
    try {
      statusCache = await api('/api/status', { quiet: true });
      const chip = document.getElementById('net-chip');
      if (chip) {
        chip.innerHTML = `<span class="dot live"></span><span class="net-label">${esc(statusCache.network)}</span> · epoch ${esc(statusCache.epoch)}`;
        chip.title = `Indexer ${statusCache.indexerUrl}\nTemplate ${statusCache.templateAddress || 'not set'}`;
      }
    } catch {
      const chip = document.getElementById('net-chip');
      if (chip) chip.innerHTML = '<span class="dot bad"></span> offline';
    }
    return statusCache;
  }

  function mountChrome() {
    hydrateIcons();
    const b = document.getElementById('btn-theme');
    if (b) {
      applyTheme(document.documentElement.dataset.theme);
      b.onclick = () => {
        const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
        store.set(THEME_KEY, next);
        applyTheme(next);
      };
    }
    mountActivity();
    loadStatus();
    setInterval(loadStatus, 30000);
  }

  const explorer = {
    tx: (id) => `https://explorer.tari.mw/tx/${encodeURIComponent(id)}`,
    substate: (id) => `https://explorer.tari.mw/substate/${encodeURIComponent(id)}`,
    template: (id) => `https://explorer.tari.mw/template/${encodeURIComponent(id)}`,
  };

  function confirmDialog({ title, body, confirm = 'Confirm', danger = false }) {
    return new Promise((resolve) => {
      const d = document.createElement('dialog');
      d.className = 'modal';
      d.innerHTML = `<div class="modal-body"><h3>${esc(title)}</h3><p>${esc(body)}</p></div>
        <div class="modal-foot"><button class="btn btn-ghost" value="no">Cancel</button><button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" value="yes">${esc(confirm)}</button></div>`;
      document.body.appendChild(d);
      d.querySelectorAll('button').forEach((btn) => (btn.onclick = () => d.close(btn.value)));
      d.addEventListener('close', () => { resolve(d.returnValue === 'yes'); d.remove(); });
      d.showModal();
    });
  }

  function confetti(host) {
    const box = document.createElement('div');
    box.className = 'confetti';
    for (let i = 0; i < 70; i++) {
      const p = document.createElement('i');
      p.style.left = `${Math.random() * 100}%`;
      p.style.background = PALETTE[i % PALETTE.length];
      p.style.animationDuration = `${1.6 + Math.random() * 1.8}s`;
      p.style.animationDelay = `${Math.random() * 0.4}s`;
      p.style.transform = `rotate(${Math.random() * 360}deg)`;
      box.appendChild(p);
    }
    host.appendChild(box);
    setTimeout(() => box.remove(), 4200);
  }

  window.UI = {
    $, $$, esc, icon, hydrateIcons, toast, log, api, copyText, copyBtn, colorFor, initials, avatar, short,
    relTime, fmtDate, splitDuration, METHODS, phaseOf, badge, loadStatus, mountChrome, explorer, confirmDialog,
    confetti, store, status: () => statusCache,
  };
})();
