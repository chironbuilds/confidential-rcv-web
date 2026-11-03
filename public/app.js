// Privote console: election list, create wizard and live election page. Hash-routed, no framework.
(function () {
  const { $, $$, esc, icon, toast, log, api, avatar, short, relTime, fmtDate, splitDuration, METHODS, phaseOf, badge, explorer, copyBtn } = window.UI;
  UI.mountChrome();

  const MAX_VOTERS_DEFAULT = 16;
  const maxVoters = () => UI.status()?.maxVoters ?? MAX_VOTERS_DEFAULT;

  // =====================================================================
  // Router
  // =====================================================================
  let leaveView = null;
  function route() {
    const h = location.hash.replace(/^#/, '') || '/';
    if (leaveView) { leaveView(); leaveView = null; }
    // Old links: /?election=<id>
    const legacy = new URLSearchParams(location.search).get('election');
    if (legacy && h === '/') { location.replace(`/#/e/${legacy}`); return; }
    $$('.view').forEach((v) => (v.hidden = true));
    $$('[data-nav]').forEach((a) => a.classList.remove('active'));
    let m;
    if (h === '/new') {
      show('view-new', 'new');
      Wizard.enter();
    } else if ((m = h.match(/^\/e\/([^/]+)/))) {
      show('view-election');
      leaveView = Election.enter(decodeURIComponent(m[1]));
    } else {
      show('view-home', 'home');
      Home.enter();
    }
    window.scrollTo({ top: 0 });
  }
  function show(id, nav) {
    const v = document.getElementById(id);
    v.hidden = false;
    v.classList.remove('view');
    void v.offsetWidth;
    v.classList.add('view');
    if (nav) document.querySelector(`[data-nav="${nav}"]`)?.classList.add('active');
  }
  window.addEventListener('hashchange', route);

  // =====================================================================
  // Home
  // =====================================================================
  const Home = (() => {
    let all = [];
    let filter = 'all';
    async function enter() {
      const grid = $('#election-grid');
      if (!all.length) grid.innerHTML = Array.from({ length: 3 }, () => '<div class="skeleton" style="height:178px;border-radius:20px"></div>').join('');
      try {
        all = await api('/api/elections');
        await UI.loadStatus();
        draw();
      } catch (e) {
        grid.innerHTML = `<div class="callout err" style="grid-column:1/-1">${icon('alert')}<div>${esc(e.message)}</div></div>`;
      }
    }
    function draw() {
      const grid = $('#election-grid');
      const epoch = UI.status()?.epoch;
      const list = all
        .map((e) => ({ e, ph: phaseOf(e, epoch) }))
        .filter(({ ph }) => filter === 'all' || (filter === 'ended' ? ph.key === 'ended' || ph.key === 'expired' : ph.key === 'open' || ph.key === 'closing'))
        .sort((a, b) => Date.parse(b.e.createdAt) - Date.parse(a.e.createdAt));
      if (!list.length) {
        grid.innerHTML = `<div class="empty-state" style="grid-column:1/-1"><div class="ico">${icon('ballot')}</div>
          <h3>${all.length ? 'Nothing here' : 'No elections yet'}</h3><p>${all.length ? 'No elections match this filter.' : 'Be the first to run a private election on the new network.'}</p>
          <a class="btn btn-primary" href="#/new">${icon('plus')} Create an election</a></div>`;
        return;
      }
      grid.innerHTML = list.map(({ e, ph }) => card(e, ph)).join('');
    }
    function card(e, ph) {
      const m = METHODS[e.tallyMethod] ?? METHODS.irv;
      const cands = e.candidates ?? [];
      const shown = cands.slice(0, 5).map((c, i) => avatar(c, i)).join('');
      const more = cands.length > 5 ? `<span class="avatar more">+${cands.length - 5}</span>` : '';
      const when = ph.endsAt ? (ph.key === 'ended' || ph.key === 'expired' ? `Closed ${relTime(ph.endsAt)}` : `Closes ${relTime(ph.endsAt)}`) : `Epoch ${e.expiresAtEpoch}`;
      return `<a class="ecard" href="#/e/${encodeURIComponent(e.id)}">
        <div class="e-top">${badge(ph)}<span class="e-method">${esc(m.short)}${e.numWinners > 1 ? ` · ${e.numWinners} seats` : ''}</span></div>
        <h3>${esc(e.title)}</h3>
        <div class="avatars">${shown}${more}</div>
        <div class="e-meta"><span>${icon('users')}${e.voters?.length ?? 0} voters</span><span>${icon('clock')}${esc(when)}</span></div>
      </a>`;
    }
    $('#btn-refresh-list').onclick = enter;
    $$('#filter-pills .pill-btn').forEach((b) => (b.onclick = () => {
      filter = b.dataset.filter;
      $$('#filter-pills .pill-btn').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      draw();
    }));
    return { enter };
  })();

  // =====================================================================
  // Create wizard
  // =====================================================================
  const Wizard = (() => {
    const DRAFT_KEY = 'privote-draft';
    const s = { step: 0, title: '', method: 'irv', winners: 2, candidates: [], votersText: '', deadline: { preset: '3d', custom: '' }, signer: 'server', walletAccount: null, busy: false };
    const PRESETS = [['1h', '1 hour', 3600e3], ['1d', '1 day', 86400e3], ['3d', '3 days', 3 * 86400e3], ['1w', '1 week', 7 * 86400e3], ['custom', 'Pick a date', 0]];
    const ADDR = /^otl_esm_1[02-9ac-hj-np-z]{20,}$/;

    // restore draft
    try {
      const d = JSON.parse(UI.store.get(DRAFT_KEY) || 'null');
      if (d) Object.assign(s, { title: d.title ?? '', method: d.method ?? 'irv', winners: d.winners ?? 2, candidates: d.candidates ?? [], votersText: d.votersText ?? '', deadline: d.deadline ?? s.deadline });
    } catch { /* ignore */ }
    const save = () => UI.store.set(DRAFT_KEY, JSON.stringify({ title: s.title, method: s.method, winners: s.winners, candidates: s.candidates, votersText: s.votersText, deadline: s.deadline }));

    // ---- methods ----
    const methodHost = $('#method-choices');
    methodHost.innerHTML = Object.entries(METHODS).map(([k, m]) => `<button type="button" class="choice" role="radio" data-method="${k}" aria-checked="false"><span class="check"></span>
      <span class="choice-title"><span class="choice-icon">${icon(m.icon)}</span>${esc(m.name)}</span><span class="choice-desc">${esc(m.desc)}</span>
      <span class="tag">${m.multi ? 'Multi-winner' : 'Single winner'}${m.ranked ? ' · ranked' : ''}</span></button>`).join('');
    methodHost.addEventListener('click', (e) => {
      const b = e.target.closest('[data-method]');
      if (!b) return;
      s.method = b.dataset.method;
      if (METHODS[s.method].multi && s.winners < 2) s.winners = 2;
      sync();
    });
    $('#win-dec').onclick = () => { s.winners = Math.max(2, s.winners - 1); sync(); };
    $('#win-inc').onclick = () => { s.winners = Math.min(Math.max(2, s.candidates.length - 1), s.winners + 1); sync(); };

    // ---- deadline ----
    $('#deadline-pills').innerHTML = PRESETS.map(([k, l]) => `<button type="button" class="pill-btn" data-preset="${k}" aria-pressed="false">${l}</button>`).join('');
    $('#deadline-pills').addEventListener('click', (e) => {
      const b = e.target.closest('[data-preset]');
      if (!b) return;
      s.deadline.preset = b.dataset.preset;
      if (s.deadline.preset === 'custom' && !s.deadline.custom) {
        const d = new Date(Date.now() + 2 * 86400e3);
        d.setMinutes(0, 0, 0);
        s.deadline.custom = toLocalInput(d);
      }
      sync();
    });
    $('#in-end').addEventListener('input', (e) => { s.deadline.custom = e.target.value; sync(); });
    function toLocalInput(d) {
      const p = (n) => String(n).padStart(2, '0');
      return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
    }
    function deadlineMs() {
      if (s.deadline.preset === 'custom') {
        const t = Date.parse(s.deadline.custom);
        return Number.isNaN(t) ? null : t;
      }
      const p = PRESETS.find(([k]) => k === s.deadline.preset);
      return p ? Date.now() + p[2] : null;
    }

    // ---- title ----
    $('#in-title').addEventListener('input', (e) => { s.title = e.target.value; sync(); });

    // ---- candidates ----
    function addCandidates(text) {
      const names = text.split(/[\n,;]+/).map((x) => x.trim()).filter(Boolean);
      let added = 0;
      for (const n of names) {
        if (s.candidates.length >= 50) break;
        if (s.candidates.some((c) => c.toLowerCase() === n.toLowerCase())) continue;
        s.candidates.push(n.slice(0, 80));
        added++;
      }
      if (names.length && !added) toast('Already on the list', '', 'info', 2000);
      sync();
    }
    $('#btn-add-candidate').onclick = () => { addCandidates($('#in-candidate').value); $('#in-candidate').value = ''; $('#in-candidate').focus(); };
    $('#in-candidate').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $('#btn-add-candidate').click(); } });
    $('#in-candidate').addEventListener('paste', (e) => {
      const t = e.clipboardData?.getData('text') ?? '';
      if (/[\n,;]/.test(t)) { e.preventDefault(); addCandidates(t); }
    });
    $('#cand-presets').addEventListener('click', (e) => {
      const b = e.target.closest('[data-preset]');
      if (!b) return;
      s.candidates = b.dataset.preset === 'yesno' ? ['Yes', 'No'] : ['Yes', 'No', 'Abstain'];
      if (b.dataset.preset === 'yesno') s.method = 'fptp';
      sync();
    });
    $('#candidate-list').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-act]');
      if (!b) return;
      const i = Number(b.closest('li').dataset.i);
      if (b.dataset.act === 'del') s.candidates.splice(i, 1);
      if (b.dataset.act === 'up' && i > 0) [s.candidates[i - 1], s.candidates[i]] = [s.candidates[i], s.candidates[i - 1]];
      if (b.dataset.act === 'down' && i < s.candidates.length - 1) [s.candidates[i + 1], s.candidates[i]] = [s.candidates[i], s.candidates[i + 1]];
      sync();
    });

    // ---- voters ----
    function parseVoters() {
      const lines = s.votersText.split(/\r?\n/).map((l) => l.split(',')[0].trim().replace(/^"|"$/g, '')).filter(Boolean);
      const valid = [];
      const invalid = [];
      const seen = new Set();
      let dupes = 0;
      lines.forEach((l, i) => {
        if (i === 0 && !l.startsWith('otl_') && /addr|wallet|voter/i.test(l)) return; // CSV header
        if (!ADDR.test(l)) { invalid.push(l); return; }
        if (seen.has(l)) { dupes++; return; }
        seen.add(l);
        valid.push(l);
      });
      return { valid, invalid, dupes };
    }
    $('#in-voters').addEventListener('input', (e) => { s.votersText = e.target.value; sync(); });
    const drop = $('#voter-drop');
    ['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('drag'); }));
    ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, () => drop.classList.remove('drag')));
    drop.addEventListener('drop', async (e) => {
      e.preventDefault();
      const f = e.dataTransfer?.files?.[0];
      if (f) importText(await f.text(), f.name);
    });
    $('#btn-csv').onclick = () => $('#csv-file').click();
    $('#csv-file').onchange = async (e) => {
      const f = e.target.files[0];
      if (f) importText(await f.text(), f.name);
      e.target.value = '';
    };
    function importText(text, name) {
      const before = parseVoters().valid.length;
      s.votersText = (s.votersText.trim() ? s.votersText.trim() + '\n' : '') + text.trim();
      $('#in-voters').value = s.votersText;
      sync();
      toast(`Imported ${name}`, `${parseVoters().valid.length - before} new voter address(es)`, 'ok');
    }

    // ---- signer ----
    $('#signer-choices').addEventListener('click', (e) => {
      const b = e.target.closest('[data-signer]');
      if (!b) return;
      s.signer = b.dataset.signer;
      sync();
    });
    $('#btn-init-connect').onclick = async () => {
      if (!window.tari) return toast('No Tari wallet found', 'Install Sapient, or open Privote inside Tari Universe.', 'err');
      try {
        const [account] = await window.tari.request({ method: 'tari_requestAccounts' });
        s.walletAccount = account;
        toast('Wallet connected', short(account, 14, 8), 'ok');
        sync();
      } catch (e) {
        toast('Wallet connection failed', e?.message || String(e), 'err');
      }
    };

    // ---- validation ----
    function checks() {
      const v = parseVoters();
      const m = METHODS[s.method];
      const end = deadlineMs();
      return {
        title: s.title.trim().length > 0,
        candidates: s.candidates.length >= 2 && (!m.multi || s.winners < s.candidates.length),
        voters: v.valid.length >= 1 && v.valid.length <= maxVoters() && v.invalid.length === 0,
        deadline: end != null && end > Date.now() + 60e3,
        v,
      };
    }
    function stepValid(i) {
      const c = checks();
      return [c.title && c.deadline, c.candidates, c.voters, c.title && c.deadline && c.candidates && c.voters][i];
    }

    // ---- render ----
    function sync() {
      save();
      const m = METHODS[s.method];
      const c = checks();
      $$('#method-choices .choice').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.method === s.method)));
      $('#winners-field').hidden = !m.multi;
      if (m.multi) s.winners = Math.max(2, Math.min(s.winners, Math.max(2, s.candidates.length - 1)));
      $('#in-winners').textContent = String(m.multi ? s.winners : 1);
      $('#win-dec').disabled = s.winners <= 2;
      $('#win-inc').disabled = s.winners >= Math.max(2, s.candidates.length - 1);
      $('#winners-hint').textContent = s.candidates.length > 2 ? `up to ${s.candidates.length - 1}` : 'add candidates first';
      if ($('#in-title').value !== s.title) $('#in-title').value = s.title;

      $$('#deadline-pills .pill-btn').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.preset === s.deadline.preset)));
      $('#in-end').hidden = s.deadline.preset !== 'custom';
      if (s.deadline.preset === 'custom' && $('#in-end').value !== s.deadline.custom) $('#in-end').value = s.deadline.custom;
      const end = deadlineMs();
      const st = UI.status();
      $('#end-preview').innerHTML = end
        ? end <= Date.now() + 60e3
          ? '<span style="color:var(--err)">Pick a time in the future.</span>'
          : `Closes <b>${esc(fmtDate(end))}</b> (${esc(relTime(end))}).${st ? ` About epoch ${st.epoch + Math.ceil((end - Date.now()) / 1000 / (st.epochDurationSecs || 1200))}; voting ends at the first epoch boundary after this.` : ''}`
        : '';

      // candidates
      $('#cand-count').textContent = String(s.candidates.length);
      $('#cand-empty').hidden = s.candidates.length > 0;
      $('#candidate-list').innerHTML = s.candidates.map((n, i) => `<li class="cand-item" data-i="${i}">${avatar(n, i)}<span class="name">${esc(n)}</span><span class="idx">#${i + 1}</span>
        <button class="icon-btn" data-act="up" aria-label="Move up" ${i === 0 ? 'disabled' : ''}>${icon('up')}</button>
        <button class="icon-btn" data-act="down" aria-label="Move down" ${i === s.candidates.length - 1 ? 'disabled' : ''}>${icon('down')}</button>
        <button class="icon-btn" data-act="del" aria-label="Remove ${esc(n)}">${icon('trash')}</button></li>`).join('');

      // voters
      if ($('#in-voters').value !== s.votersText) $('#in-voters').value = s.votersText;
      const max = maxVoters();
      $('#max-voters').textContent = String(max);
      const n = c.v.valid.length;
      const meter = $('#voter-meter');
      meter.querySelector('span').style.width = `${Math.min(100, (n / max) * 100)}%`;
      meter.classList.toggle('full', n === max);
      meter.classList.toggle('over', n > max);
      $('#voter-stats').innerHTML = `<span><b>${n}</b> / ${max} voters</span>${c.v.dupes ? `<span>${c.v.dupes} duplicate${c.v.dupes === 1 ? '' : 's'} skipped</span>` : ''}${c.v.invalid.length ? `<span class="bad">${c.v.invalid.length} invalid</span>` : ''}${n > max ? `<span class="bad">${n - max} over the limit</span>` : ''}`;
      const issues = $('#voter-issues');
      issues.hidden = !c.v.invalid.length;
      issues.innerHTML = c.v.invalid.slice(0, 8).map((l) => `<li>Not an Esmeralda address: <code>${esc(short(l, 22, 6))}</code></li>`).join('') + (c.v.invalid.length > 8 ? `<li>…and ${c.v.invalid.length - 8} more</li>` : '');

      // signer
      $$('#signer-choices .choice').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.signer === s.signer)));
      $('#wallet-row').hidden = s.signer !== 'wallet';
      $('#init-wallet-account').textContent = s.walletAccount ? `Connected ${short(s.walletAccount, 14, 8)}` : 'Not connected';
      $('#launch-summary').innerHTML = `<div class="p-rows">
        <div class="p-row"><span>Title</span><span>${esc(s.title || '—')}</span></div>
        <div class="p-row"><span>Method</span><span>${esc(m.name)}${m.multi ? `, ${s.winners} seats` : ''}</span></div>
        <div class="p-row"><span>Candidates</span><span>${s.candidates.length}</span></div>
        <div class="p-row"><span>Voters</span><span>${n} stealth ballot${n === 1 ? '' : 's'}</span></div>
        <div class="p-row"><span>Closes</span><span>${end ? esc(fmtDate(end)) : '—'}</span></div></div>`;

      // preview
      $('#pv-title').textContent = s.title.trim() || 'Untitled election';
      $('#pv-title').classList.toggle('empty', !s.title.trim());
      $('#pv-method').textContent = m.short;
      $('#pv-cands').innerHTML = s.candidates.slice(0, 12).map((x, i) => `<span class="chip">${avatar(x, i)}<span>${esc(x)}</span></span>`).join('') + (s.candidates.length > 12 ? `<span class="chip" style="padding-left:9px">+${s.candidates.length - 12}</span>` : '');
      $('#pv-seats').textContent = String(m.multi ? s.winners : 1);
      $('#pv-voters').textContent = String(n);
      $('#pv-closes').textContent = end ? relTime(end) : '—';
      $('#pv-checks').innerHTML = [
        [c.title, 'Has a title'],
        [c.deadline, 'Deadline in the future'],
        [c.candidates, m.multi ? `At least ${s.winners + 1} candidates` : 'At least 2 candidates'],
        [c.voters, `1–${max} valid voter addresses`],
      ].map(([ok, t]) => `<li class="${ok ? 'ok' : ''}">${t}</li>`).join('');

      // steps
      $$('#wizard-steps .wstep').forEach((b, i) => {
        b.classList.toggle('active', i === s.step);
        b.classList.toggle('done', i !== s.step && stepValid(i) && i < 3);
      });
      $$('.wizard-panel').forEach((p, i) => p.classList.toggle('active', i === s.step));
      $('#btn-back').style.visibility = s.step === 0 ? 'hidden' : 'visible';
      const next = $('#btn-next');
      if (s.step === 3) {
        next.innerHTML = s.busy ? '<span class="spinner"></span> Launching…' : `${icon('zap')} Launch election`;
        next.disabled = s.busy || !stepValid(3) || (s.signer === 'wallet' && !s.walletAccount);
      } else {
        next.innerHTML = `Continue ${icon('right')}`;
        next.disabled = false;
      }
    }

    function go(step) {
      s.step = Math.max(0, Math.min(3, step));
      sync();
      $('#view-new').scrollIntoView({ behavior: 'smooth', block: 'start' });
      if (s.step === 1) setTimeout(() => $('#in-candidate').focus(), 50);
    }
    $('#wizard-steps').addEventListener('click', (e) => {
      const b = e.target.closest('[data-step]');
      if (b) go(Number(b.dataset.step));
    });
    $('#btn-back').onclick = () => go(s.step - 1);
    $('#btn-next').onclick = () => {
      if (s.step < 3) {
        if (!stepValid(s.step)) {
          const c = checks();
          const msg = [
            !c.title ? 'Give the election a title.' : !c.deadline ? 'Choose a deadline in the future.' : '',
            METHODS[s.method].multi && s.candidates.length <= s.winners ? `Add at least ${s.winners + 1} candidates for ${s.winners} seats.` : 'Add at least two candidates.',
            c.v.invalid.length ? 'Fix the invalid addresses.' : c.v.valid.length > maxVoters() ? `This network allows up to ${maxVoters()} voters per election.` : 'Add at least one voter address.',
          ][s.step];
          toast('Almost there', msg, 'info', 3500);
          return;
        }
        go(s.step + 1);
      } else launch();
    };

    function setStatus(html, kind = '') {
      const el = $('#launch-status');
      el.className = `status-line mt-16 ${kind}`;
      el.innerHTML = html;
    }
    const extractTxId = (r) => r?.transactionId ?? r?.transaction_id ?? r?.result?.Finalized?.execution_result?.finalize?.transaction_hash ?? null;

    async function launch() {
      const c = checks();
      if (!stepValid(3)) return;
      s.busy = true;
      sync();
      const body = {
        title: s.title.trim(),
        tallyMethod: s.method,
        numWinners: METHODS[s.method].multi ? s.winners : 1,
        numCandidates: s.candidates.length,
        candidates: s.candidates,
        voters: c.v.valid,
        endUtc: new Date(deadlineMs()).toISOString(),
      };
      try {
        let e;
        if (s.signer === 'wallet') {
          setStatus('<span class="spinner"></span> Building the ballots…');
          const prep = await api('/api/elections/prepare', { method: 'POST', body });
          setStatus('<span class="spinner"></span> Approve the transaction in your wallet…');
          const result = await window.RcvWallet.submitTransactionRequest({ kind: 'instructions', instructions: prep.instructions, maxFee: prep.maxFee });
          const transactionId = extractTxId(result);
          if (!transactionId) throw new Error('The wallet did not return a transaction id.');
          setStatus('<span class="spinner"></span> Confirming on-chain…');
          e = await api('/api/elections/finalize', { method: 'POST', body: { transactionId, draft: prep.draft, ballots: prep.ballots } });
        } else {
          setStatus(`<span class="spinner"></span> Minting ${c.v.valid.length} stealth ballot${c.v.valid.length === 1 ? '' : 's'} and creating the election…`);
          e = await api('/api/elections', { method: 'POST', body });
        }
        log(`election created: <code>${esc(e.componentAddress)}</code>`);
        UI.store.del(DRAFT_KEY);
        Object.assign(s, { step: 0, title: '', candidates: [], votersText: '', busy: false });
        setStatus('');
        toast('Your election is live', 'Share the voting link with your voters.', 'ok', 6000);
        location.hash = `#/e/${encodeURIComponent(e.id)}?new=1`;
      } catch (err) {
        s.busy = false;
        setStatus(`${icon('alert')} ${esc(err.message)}`, 'err');
        toast('Could not launch', err.message, 'err', 8000);
        sync();
      }
    }

    function enter() {
      UI.loadStatus().then(sync);
      sync();
      setTimeout(() => { if (s.step === 0 && !s.title) $('#in-title').focus(); }, 60);
    }
    return { enter };
  })();

  // =====================================================================
  // Election page
  // =====================================================================
  const Election = (() => {
    let current = null;
    let poll = null;
    let tick = null;
    let lastResultJson = '';

    function enter(id) {
      current = null;
      lastResultJson = '';
      $('#e-loading').hidden = false;
      $('#e-body').hidden = true;
      $('#e-missing').hidden = true;
      const isNew = location.hash.includes('new=1');
      load(id, isNew);
      poll = setInterval(() => load(id), 8000);
      tick = setInterval(drawCountdown, 1000);
      return () => { clearInterval(poll); clearInterval(tick); };
    }

    async function load(id, celebrate = false) {
      try {
        const e = await api(`/api/elections/${encodeURIComponent(id)}`, { quiet: !!current });
        const before = current?.id === e.id ? current?.state?.ballotCount : undefined;
        const after = e.state?.ballotCount;
        if (before != null && after != null && after > before) {
          toast(after - before === 1 ? 'A new ballot arrived' : `${after - before} new ballots arrived`, `${after} of ${e.state.voterCount} cast`, 'ok', 4000);
        }
        current = e;
        draw(e);
        if (celebrate) {
          UI.confetti(document.body);
          history.replaceState(null, '', `#/e/${encodeURIComponent(id)}`);
        }
      } catch (err) {
        if (!current) {
          $('#e-loading').hidden = true;
          $('#e-missing').hidden = false;
        }
      }
    }

    function draw(e) {
      $('#e-loading').hidden = true;
      $('#e-body').hidden = false;
      const ph = phaseOf(e);
      const m = METHODS[e.tallyMethod] ?? METHODS.irv;
      const st = e.state || {};
      document.title = `${e.title} · Privote`;
      $('#e-badges').innerHTML = `${badge(ph)}<span class="badge outline">${esc(m.short)}</span>`;
      $('#e-title').textContent = e.title;
      $('#e-sub').innerHTML = `<span>Created ${esc(relTime(Date.parse(e.createdAt)))}</span><span>·</span><span>${(e.candidates ?? []).length} candidates</span>${e.numWinners > 1 ? `<span>·</span><span>${e.numWinners} seats</span>` : ''}`;
      const cast = st.ballotCount != null ? Number(st.ballotCount) : null;
      const voters = st.voterCount != null ? Number(st.voterCount) : e.voters?.length ?? 0;
      const pct = cast != null && voters ? Math.round((cast / voters) * 100) : 0;
      $('#e-ring').style.setProperty('--p', String(pct));
      $('#e-turnout').textContent = `${pct}%`;
      $('#e-cast').textContent = cast ?? '—';
      $('#e-cast-sub').textContent = `of ${voters} ballots cast`;
      $('#e-voters').textContent = String(voters);
      if (ph.key === 'ended' && e.endedAt && (!ph.endsAt || Date.parse(e.endedAt) < ph.endsAt)) {
        $('#e-deadline').textContent = fmtDate(Date.parse(e.endedAt));
        $('#e-deadline-sub').textContent = `Ended early, ${relTime(Date.parse(e.endedAt))}`;
      } else {
        $('#e-deadline').textContent = ph.endsAt ? fmtDate(ph.endsAt) : `Epoch ${e.expiresAtEpoch}`;
        $('#e-deadline-sub').textContent = `${ph.endsAt ? relTime(ph.endsAt) + ' · ' : ''}epoch ${e.expiresAtEpoch} (now ${e.epoch})`;
      }
      $('#e-method').textContent = m.name;
      $('#e-method-sub').textContent = m.ranked ? 'Ranked ballots' : 'Single choice';
      drawCountdown();

      const link = `${location.origin}/vote?election=${encodeURIComponent(e.id)}`;
      $('#e-link').textContent = link;
      $('#btn-copy-link').onclick = (ev) => UI.copyText(link, ev.currentTarget);
      $('#e-vote-btn').href = link;
      $('#e-vote-btn').hidden = ph.key === 'ended' || ph.key === 'expired';

      // admin
      const isServerInitiated = !e.initiator || e.initiator === 'server';
      $('#btn-end').hidden = ph.key !== 'open' && ph.key !== 'closing';
      $('#btn-end').disabled = !isServerInitiated;
      $('#btn-end-expired').hidden = ph.key !== 'expired';
      $('#e-admin').hidden = ph.key === 'ended';
      $('#e-admin-hint').textContent = ph.key === 'expired'
        ? 'The deadline has passed. Anyone can finalize the count now.'
        : isServerInitiated
          ? 'Ending early freezes the ballots cast so far and publishes the final tally.'
          : "Launched from the organiser's own wallet, so only that wallet can end it early. Anyone can finalize once the deadline passes.";

      // results
      const result = st.result ?? e.endResult;
      const json = JSON.stringify(result ?? null);
      if (st.error && result == null) {
        $('#e-results').innerHTML = `<div class="callout warn">${icon('alert')}<div>Couldn’t read the live tally from the network. Retrying automatically…<div class="tiny muted mt-8 mono" style="word-break:break-all">${esc(st.error.slice(0, 220))}</div></div></div>`;
      } else if (result != null && json !== lastResultJson) {
        lastResultJson = json;
        window.Results.render($('#e-results'), result, e);
        $('#e-raw').textContent = JSON.stringify(result, null, 2);
      } else if (result == null) {
        $('#e-results').innerHTML = `<div class="empty-state" style="padding:32px">${icon('chart')}<p class="mt-8">No ballots counted yet.</p></div>`;
      }
      $('#e-results-hint').textContent = ph.key === 'ended' ? 'Final result, computed on-chain.' : 'Provisional tally of the ballots cast so far. It updates live.';
      $('#e-updated').textContent = `Updated ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`;

      // public ballots (anonymous rankings, exactly as stored on-chain)
      drawPublicBallots(e);

      // ballots
      $('#e-ballot-count').textContent = String(e.voters?.length ?? 0);
      $('#e-ballots').innerHTML = '<tr><th>#</th><th>Commitment</th><th>Sender nonce</th></tr>' + (e.voters ?? []).map((v, i) => `<tr><td class="num">${i + 1}</td><td><code>${esc(short(v.commitment, 14, 8))}</code> ${copyBtn(v.commitment)}</td><td><code>${esc(short(v.nonce, 14, 8))}</code> ${copyBtn(v.nonce)}</td></tr>`).join('');

      // chain
      const rows = [
        ['Component', e.componentAddress, explorer.substate(e.componentAddress)],
        ['Ballot token', e.ballotResource, explorer.substate(e.ballotResource)],
        ['Template', e.templateAddress, explorer.template(e.templateAddress)],
        ['Created in', e.txId, e.txId ? explorer.tx(e.txId) : null],
      ].filter((r) => r[1]);
      $('#e-chain').innerHTML = rows.map(([k, v, href]) => `<div class="kv-row"><span>${k}</span><code title="${esc(v)}">${esc(short(v, 16, 6))}</code><span class="flex" style="gap:2px">${copyBtn(v)}${href ? `<a class="copy-btn" href="${href}" target="_blank" rel="noopener" title="Open in explorer">${icon('ext')}</a>` : ''}</span></div>`).join('');
    }

    function drawPublicBallots(e) {
      const ballots = e.state?.ballots;
      const names = e.candidates ?? [];
      $('#e-verify').hidden = !Array.isArray(ballots);
      if (!Array.isArray(ballots)) return;
      $('#btn-recount').disabled = ballots.length === 0;
      $('#e-public-ballots').innerHTML = ballots.length
        ? '<tr><th>#</th><th>Ranking (first choice first)</th></tr>' + ballots.map((b, i) => `<tr><td class="num">${i + 1}</td><td>${b.map((c) => esc(names[c] ?? `#${c + 1}`)).join(' <span class="muted">›</span> ')}</td></tr>`).join('')
        : '<tr><td class="muted">No ballots yet.</td></tr>';
    }

    let tallyMod = null;
    async function recount() {
      const e = current;
      if (!e?.state?.ballots) return;
      const st = $('#recount-status');
      st.className = 'status-line';
      st.innerHTML = '<span class="spinner"></span> Loading the tally code…';
      try {
        if (!tallyMod) {
          tallyMod = await import('/tally/rcv_tally_wasm.js');
          await tallyMod.default('/tally/rcv_tally_wasm_bg.wasm');
        }
        const t0 = performance.now();
        const mine = JSON.parse(tallyMod.tally(e.tallyMethod, JSON.stringify(e.state.ballots), e.numCandidates, e.numWinners));
        const ms = Math.max(1, Math.round(performance.now() - t0));
        const theirs = e.state.result;
        const same = JSON.stringify(mine) === JSON.stringify(theirs);
        st.className = `status-line ${same ? 'ok' : 'err'}`;
        st.innerHTML = same
          ? `${icon('check')} Recounted ${e.state.ballots.length} ballot${e.state.ballots.length === 1 ? '' : 's'} in ${ms} ms. The result matches.`
          : `${icon('alert')} Your recount differs from the displayed result. Check the raw data below.`;
      } catch (err) {
        st.className = 'status-line err';
        st.innerHTML = `${icon('alert')} ${esc(err.message)}`;
      }
    }
    $('#btn-recount').onclick = recount;

    function drawCountdown() {
      if (!current) return;
      const ph = phaseOf(current);
      const host = $('#e-countdown');
      if (!ph.endsAt || ph.key === 'ended' || ph.key === 'expired') {
        host.className = 'countdown done';
        host.innerHTML = ph.key === 'ended' ? '' : '<div class="unit"><b>00</b><span>closed</span></div>';
        return;
      }
      const d = splitDuration(ph.endsAt - Date.now());
      const pad = (n) => String(n).padStart(2, '0');
      host.className = 'countdown';
      host.innerHTML = [[d.d, 'days'], [d.h, 'hours'], [d.m, 'min'], [d.s, 'sec']].filter(([v, l], i) => i > 0 || v > 0).map(([v, l]) => `<div class="unit"><b>${pad(v)}</b><span>${l}</span></div>`).join('');
    }

    async function end(kind) {
      const e = current;
      if (!e) return;
      const ok = await UI.confirmDialog(kind === 'end'
        ? { title: 'End voting now?', body: 'No more ballots can be cast, and the final tally is published on-chain. This cannot be undone.', confirm: 'End voting', danger: true }
        : { title: 'Finalize the results?', body: 'This locks in the ballots cast before the deadline and publishes the final tally on-chain.', confirm: 'Finalize' });
      if (!ok) return;
      const status = $('#e-admin-status');
      status.className = 'status-line mt-12';
      status.innerHTML = '<span class="spinner"></span> Submitting to the network…';
      $$('#e-admin button').forEach((b) => (b.disabled = true));
      try {
        await api(`/api/elections/${encodeURIComponent(e.id)}/${kind}`, { method: 'POST', body: {} });
        status.innerHTML = '';
        toast('Voting has ended', 'The final result is on-chain.', 'ok');
        await load(e.id);
      } catch (err) {
        status.className = 'status-line mt-12 err';
        status.innerHTML = `${icon('alert')} ${esc(err.message)}`;
      } finally {
        $$('#e-admin button').forEach((b) => (b.disabled = false));
      }
    }
    $('#btn-end').onclick = () => end('end');
    $('#btn-end-expired').onclick = () => end('end-expired');
    $('#btn-ballots-csv').onclick = () => {
      if (!current) return;
      const lines = ['index,ballot_commitment,sender_nonce', ...(current.voters ?? []).map((v, i) => `${i},${v.commitment},${v.nonce}`)];
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/csv' }));
      a.download = `${current.title.replace(/[^\w-]+/g, '_').slice(0, 40) || 'election'}-ballots.csv`;
      a.click();
      URL.revokeObjectURL(a.href);
    };
    return { enter };
  })();

  route();
})();
