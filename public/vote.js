// Voter flow: connect → find ballot → rank → cast, all through the voter's own window.tari wallet.
// The ballot is spent with its one-time stealth key and the fee comes from a shielded TARI UTXO,
// so the transaction cannot be linked to the voter's wallet.
(function () {
  const { $, $$, esc, icon, toast, api, avatar, short, relTime, fmtDate, METHODS, phaseOf, badge, explorer } = window.UI;
  UI.mountChrome();

  const XTR = 'resource_0101010101010101010101010101010101010101010101010101010101010101';
  const FEE_SHIELD = '500000';
  const MAX_FEE = '100000';
  const FEE_KEY = 'rcv-voter-fee-commitment';
  const BALLOT_AMOUNT = '1';

  const v = { election: null, wallet: null, ballot: null, order: [], pick: null, fee: null, step: 'connect', tapMode: false, tapped: [] };
  const STEPS = ['connect', 'find', 'rank', 'cast'];

  // ---------- step state ----------
  function setStep(name, opts = {}) {
    v.step = name;
    const idx = STEPS.indexOf(name);
    $$('.vstep').forEach((el) => {
      const i = STEPS.indexOf(el.dataset.vstep);
      el.classList.toggle('active', i === idx);
      el.classList.toggle('done', i < idx);
      el.classList.toggle('locked', i > idx);
      el.classList.toggle('blocked', !!opts.blocked && i === idx);
    });
  }
  function status(el, html, kind = '') {
    el.className = `status-line ${kind}`;
    el.innerHTML = html;
  }
  const spin = (t) => `<span class="spinner"></span> ${esc(t)}`;
  const okLine = (t) => `${icon('check')} ${t}`;
  const errLine = (t) => `${icon('alert')} ${t}`;

  // ---------- chain helpers (through the wallet) ----------
  const utxoId = (resource, commitment) => `utxo_${resource.replace('resource_', '')}_${commitment}`;
  async function isLive(resource, commitment) {
    try {
      const res = await window.RcvWallet.call('tari_getSubstate', { substateId: utxoId(resource, commitment), version: null });
      if (res?.state && !('up' in res.state)) return false;
      const value = res?.state?.up?.substate ?? res?.substate;
      const utxo = value?.Utxo ?? value?.substate?.Utxo;
      return !!(utxo && utxo.output);
    } catch {
      return false;
    }
  }
  const ensureView = () => window.RcvWallet.ensureView();
  const walletName = () => window.RcvWallet.state().name || 'your wallet';
  function rankingCbor(ids) {
    const head = (n) => (n < 24 ? [n] : n < 256 ? [0x18, n] : [0x19, n >> 8, n & 255]);
    const bytes = [...(ids.length < 24 ? [0x80 | ids.length] : [0x98, ids.length]), ...ids.flatMap(head)];
    return bytes.map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  // ---------- load ----------
  async function init() {
    const id = new URLSearchParams(location.search).get('election');
    if (!id) return showPicker();
    try {
      const e = await api(`/api/elections/${encodeURIComponent(id)}`);
      v.election = e;
    } catch {
      $('#not-found').hidden = false;
      return;
    }
    const e = v.election;
    const ph = phaseOf(e);
    const m = METHODS[e.tallyMethod] ?? METHODS.irv;
    document.title = `${e.title} · Vote · Privote`;
    $('#ballot').hidden = false;
    $('#v-badges').innerHTML = `${badge(ph)}<span class="badge outline">${esc(m.name)}</span>`;
    $('#v-title').textContent = e.title;
    $('#v-sub').innerHTML = `${(e.candidates ?? []).length} candidates${e.numWinners > 1 ? ` · ${e.numWinners} seats` : ''} · ${ph.key === 'ended' ? 'voting has ended' : ph.key === 'expired' ? 'voting has closed' : ph.endsAt ? `closes ${esc(relTime(ph.endsAt))} (${esc(fmtDate(ph.endsAt))})` : `closes at epoch ${e.expiresAtEpoch}`}`;
    $('#done-results').href = `/#/e/${encodeURIComponent(e.id)}`;
    $('#v-results-link').href = `/#/e/${encodeURIComponent(e.id)}`;
    if (ph.key === 'ended' || ph.key === 'expired') {
      $('#v-closed').hidden = false;
      $('#vflow').hidden = true;
      return;
    }
    v.order = (e.candidates ?? []).map((_, i) => i);
    setupRanking(m);
    const w = await window.RcvWallet.silent();
    if (!w.available) {
      $('#no-wallet').hidden = false;
      $('#btn-connect').hidden = true;
      return;
    }
    $('#btn-connect').innerHTML = `${icon('wallet')} Connect ${esc(w.name)}`;
    if (w.connected) onConnected(w);
    window.RcvWallet.onChange((s) => {
      if (!s.connected) {
        v.wallet = null;
        v.ballot = null;
        $('#s1-sub').textContent = 'Sapient or Tari Universe. Privote never sees your keys.';
        setStep('connect');
      } else if (s.address && s.address !== v.wallet) onConnected(s);
    });
  }

  function onConnected(w) {
    v.wallet = w.address || w.account;
    $('#s1-sub').innerHTML = `<span class="wallet-chip">${avatar(v.wallet.slice(8), 5)}${esc(short(v.wallet, 12, 6))}</span> <span class="small muted">via ${esc(w.name)}</span>`;
    setStep('find');
    findBallot();
  }

  async function showPicker() {
    $('#picker').hidden = false;
    const host = $('#picker-list');
    host.innerHTML = '<div class="skeleton" style="height:64px"></div><div class="skeleton" style="height:64px"></div>';
    try {
      const [list, st] = await Promise.all([api('/api/elections'), UI.loadStatus()]);
      const open = list.map((e) => ({ e, ph: phaseOf(e, st?.epoch) })).filter(({ ph }) => ph.key === 'open' || ph.key === 'closing');
      host.innerHTML = open.length
        ? open.map(({ e, ph }) => `<a class="pick" href="/vote?election=${encodeURIComponent(e.id)}">${avatar(e.title, e.title.length)}<span><span class="p-name">${esc(e.title)}</span><br><span class="small muted">${esc(METHODS[e.tallyMethod]?.short ?? '')} · ${ph.endsAt ? `closes ${esc(relTime(ph.endsAt))}` : ''}</span></span><span style="margin-left:auto">${icon('right', 'inline-svg')}</span></a>`).join('')
        : `<div class="empty-state"><div class="ico">${icon('ballot')}</div><h3>No open elections</h3><p>When an election is running, it shows up here.</p></div>`;
    } catch (e) {
      host.innerHTML = `<div class="callout err">${icon('alert')}<div>${esc(e.message)}</div></div>`;
    }
  }

  // ---------- 1 connect ----------
  $('#btn-connect').onclick = async () => {
    const btn = $('#btn-connect');
    const label = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = `<span class="spinner"></span> Approve in ${esc(walletName())}…`;
    try {
      onConnected(await window.RcvWallet.connect());
    } catch (e) {
      if (e.message === 'NO_WALLET') $('#no-wallet').hidden = false;
      else toast('Could not connect', e.message, 'err');
    } finally {
      btn.disabled = false;
      btn.innerHTML = label;
    }
  };

  // ---------- 2 find ----------
  async function findBallot() {
    const e = v.election;
    const st = $('#find-status');
    $('#find-actions').hidden = true;
    setStep('find');
    try {
      status(st, spin(`Asking ${walletName()} for permission to look for your ballot…`));
      await ensureView();
      status(st, spin('Checking your wallet…'));
      const known = await window.RcvWallet.call('tari_getShieldedOutputs', { resourceAddress: e.ballotResource });
      let match = known?.[0];
      if (!match) {
        status(st, spin('Scanning the election’s mint transaction for a ballot addressed to you…'));
        const { found } = await window.RcvWallet.call('tari_scanForResourceUtxos', { resourceAddress: e.ballotResource, transactionIds: e.txId ? [e.txId] : [], maxPages: 20, pageSize: 50, limit: 1 });
        match = found?.[0];
      }
      if (!match) {
        status(st, errLine('This wallet has no ballot for this election. Check you connected the account that was invited.'), 'err');
        $('#find-actions').hidden = false;
        setStep('find', { blocked: true });
        return;
      }
      status(st, spin('Ballot found. Checking it hasn’t been used…'));
      if (!(await isLive(e.ballotResource, match.commitment))) {
        status(st, `${icon('check')} You’ve already voted in this election. <a href="/#/e/${encodeURIComponent(e.id)}">See the results</a>`, 'ok');
        setStep('find', { blocked: true });
        return;
      }
      v.ballot = match.commitment;
      $('#s2-sub').innerHTML = `Ballot <code>${esc(short(v.ballot, 8, 6))}</code> is ready.`;
      status(st, '');
      setStep('rank');
      prepareFee();
    } catch (err) {
      status(st, errLine(esc(window.RcvWallet.friendly(err))), 'err');
      $('#find-actions').hidden = false;
      setStep('find', { blocked: true });
    }
  }
  $('#btn-rescan').onclick = findBallot;

  // ---------- 3 rank ----------
  const EXPLAIN = {
    irv: [['repeat', 'Your top choice gets your vote first.'], ['split', 'If they are eliminated, your vote moves to your next choice, so ranking everyone never hurts.'], ['trophy', 'Counting stops when someone has a majority.']],
    'sequential-irv': [['repeat', 'Each seat is filled by an instant runoff.'], ['layers', 'Once someone wins a seat, they are removed and the next seat is counted from everyone’s rankings.'], ['trophy', 'Your lower choices matter for the later seats.']],
    stv: [['target', 'Candidates who reach the quota are elected.'], ['split', 'Votes beyond the quota, and votes for eliminated candidates, move to the next choice.'], ['trophy', 'Seats end up shared in proportion to support.']],
    fptp: [['target', 'You get one choice.'], ['trophy', 'The option with the most votes wins. A tie has no winner.']],
  };
  function drawExplain(method) {
    $('#explain').innerHTML = `<div class="small" style="font-weight:650;color:var(--text)">How your vote counts</div>` + (EXPLAIN[method] ?? EXPLAIN.irv).map(([ic, t]) => `<div class="ex-row">${icon(ic)}<span>${esc(t)}</span></div>`).join('');
  }

  function setupRanking(m) {
    const names = v.election.candidates ?? [];
    drawExplain(v.election.tallyMethod);
    if (!m.ranked) {
      $('#rank-ui').hidden = true;
      $('#pick-ui').hidden = false;
      $('#s3-title').textContent = 'Make your choice';
      $('#s3-sub').textContent = 'Pick one option.';
      $('#pick-ui').innerHTML = names.map((n, i) => `<button type="button" class="pick" role="radio" aria-checked="false" data-id="${i}">${avatar(n, i)}<span class="p-name">${esc(n)}</span><span class="radio"></span></button>`).join('');
      $('#pick-ui').onclick = (e) => {
        const b = e.target.closest('[data-id]');
        if (!b) return;
        v.pick = Number(b.dataset.id);
        $$('#pick-ui .pick').forEach((x) => x.setAttribute('aria-checked', String(x === b)));
        $('#btn-rank-done').disabled = false;
      };
      $('#btn-rank-done').disabled = true;
      return;
    }
    if (m.multi) $('#rank-hint').textContent = `Top is your first choice. ${v.election.numWinners} seats will be filled.`;
    drawRank();
  }

  function drawRank(flipFrom) {
    const names = v.election.candidates ?? [];
    const list = $('#rank-list');
    list.innerHTML = v.order.map((id, pos) => `<li class="rank-item" data-id="${id}">
        <span class="grip" aria-hidden="true">${icon('grip')}</span>
        <span class="pos">${v.tapMode ? (v.tapped.includes(id) ? v.tapped.indexOf(id) + 1 : '·') : pos + 1}</span>
        ${avatar(names[id], id)}<span class="r-name">${esc(names[id])}</span>
        <span class="moves"><button type="button" data-mv="-1" aria-label="Move ${esc(names[id])} up" ${pos === 0 ? 'disabled' : ''}>${icon('up')}</button><button type="button" data-mv="1" aria-label="Move ${esc(names[id])} down" ${pos === v.order.length - 1 ? 'disabled' : ''}>${icon('down')}</button></span>
      </li>`).join('');
    if (flipFrom) {
      $$('.rank-item', list).forEach((el) => {
        const prev = flipFrom.get(el.dataset.id);
        if (prev == null) return;
        const dy = prev - el.getBoundingClientRect().top;
        if (!dy) return;
        el.style.transform = `translateY(${dy}px)`;
        requestAnimationFrame(() => { el.classList.add('flip'); el.style.transform = ''; });
        el.addEventListener('transitionend', () => el.classList.remove('flip'), { once: true });
      });
    }
  }
  const positions = () => new Map($$('#rank-list .rank-item').map((el) => [el.dataset.id, el.getBoundingClientRect().top]));

  $('#rank-list').addEventListener('click', (e) => {
    const mv = e.target.closest('[data-mv]');
    const li = e.target.closest('.rank-item');
    if (!li) return;
    const id = Number(li.dataset.id);
    if (mv) {
      const i = v.order.indexOf(id);
      const j = i + Number(mv.dataset.mv);
      if (j < 0 || j >= v.order.length) return;
      const before = positions();
      [v.order[i], v.order[j]] = [v.order[j], v.order[i]];
      drawRank(before);
      li.parentElement?.querySelector(`[data-id="${id}"] [data-mv="${mv.dataset.mv}"]`)?.focus();
      return;
    }
    if (v.tapMode && !e.target.closest('.grip')) {
      if (v.tapped.includes(id)) return;
      v.tapped.push(id);
      const before = positions();
      const rest = v.order.filter((x) => !v.tapped.includes(x));
      v.order = [...v.tapped, ...rest];
      if (v.tapped.length >= v.order.length - 1) {
        v.tapMode = false;
        v.tapped = [];
        $('#btn-tap-mode').innerHTML = `${icon('sparkles')} Tap to rank`;
        toast('Ranking complete', 'Adjust with the arrows if you like.', 'ok', 2200);
      }
      drawRank(before);
    }
  });
  $('#btn-tap-mode').onclick = () => {
    v.tapMode = !v.tapMode;
    v.tapped = [];
    $('#btn-tap-mode').innerHTML = v.tapMode ? `${icon('x')} Cancel` : `${icon('sparkles')} Tap to rank`;
    if (v.tapMode) toast('Tap candidates in order', 'Your first tap is your first choice.', 'info', 3000);
    drawRank();
  };
  $('#btn-rank-reset').onclick = () => {
    const before = positions();
    v.order = (v.election.candidates ?? []).map((_, i) => i);
    v.tapped = [];
    drawRank(before);
  };

  // Pointer-events drag (HTML5 drag-and-drop does not work in Tari Universe's dApp iframe).
  (function enableDrag() {
    const list = $('#rank-list');
    let drag = null;
    list.addEventListener('pointerdown', (e) => {
      const grip = e.target.closest('.grip');
      if (!grip || v.tapMode) return;
      const li = grip.closest('.rank-item');
      e.preventDefault();
      grip.setPointerCapture(e.pointerId);
      const rect = li.getBoundingClientRect();
      drag = { li, id: Number(li.dataset.id), startY: e.clientY, offset: 0, h: rect.height + 8, grip, pointerId: e.pointerId };
      li.classList.add('dragging');
    });
    list.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const dy = e.clientY - drag.startY;
      drag.li.style.transform = `translateY(${dy}px)`;
      const i = v.order.indexOf(drag.id);
      const shift = Math.round(dy / drag.h);
      const target = Math.max(0, Math.min(v.order.length - 1, i + shift));
      $$('.rank-item', list).forEach((el) => {
        if (el === drag.li) return;
        const j = v.order.indexOf(Number(el.dataset.id));
        let t = 0;
        if (target > i && j > i && j <= target) t = -drag.h;
        if (target < i && j < i && j >= target) t = drag.h;
        el.style.transition = 'transform .18s cubic-bezier(.2,.8,.2,1)';
        el.style.transform = t ? `translateY(${t}px)` : '';
      });
      drag.target = target;
    });
    const finish = () => {
      if (!drag) return;
      const i = v.order.indexOf(drag.id);
      const target = drag.target ?? i;
      v.order.splice(i, 1);
      v.order.splice(target, 0, drag.id);
      drag = null;
      drawRank();
    };
    list.addEventListener('pointerup', finish);
    list.addEventListener('pointercancel', finish);
  })();

  $('#btn-rank-done').onclick = () => {
    const m = METHODS[v.election.tallyMethod] ?? METHODS.irv;
    if (!m.ranked && v.pick == null) return;
    const names = v.election.candidates ?? [];
    const ids = m.ranked ? v.order : [v.pick];
    $('#review').innerHTML = ids.map((id) => `<li>${esc(names[id])}</li>`).join('');
    $('#review').style.listStyle = m.ranked ? '' : 'none';
    $('#review').style.paddingLeft = m.ranked ? '20px' : '0';
    setStep('cast');
    updateCastButton();
  };
  $('#btn-edit').onclick = () => setStep('rank');

  // ---------- 4 fee + cast ----------
  async function prepareFee() {
    const st = $('#fee-status');
    status(st, spin('Looking for shielded TARI to pay the fee privately…'));
    $('#fee-actions').hidden = true;
    const saved = UI.store.get(FEE_KEY);
    try {
      const outputs = (await window.RcvWallet.call('tari_getShieldedOutputs', { resourceAddress: XTR })) ?? [];
      const sorted = [...outputs].sort((a, b) => (BigInt(b.amount) > BigInt(a.amount) ? 1 : -1));
      if (saved && !sorted.some((o) => o.commitment === saved)) sorted.unshift({ commitment: saved, amount: '0' });
      for (const o of sorted) {
        if (o.amount !== '0' && BigInt(o.amount) < BigInt(MAX_FEE)) continue;
        if (await isLive(XTR, o.commitment)) {
          setFee(o.commitment, o.amount);
          return;
        }
      }
    } catch { /* fall through to shield */ }
    v.fee = null;
    const bal = await window.RcvWallet.publicXtr();
    const need = BigInt(FEE_SHIELD) + 200000n;
    if (bal != null && bal < need) {
      status(st, errLine(`Your wallet needs about ${(Number(need) / 1e6).toFixed(1)} tTARI to pay the fee privately. It has ${(Number(bal) / 1e6).toFixed(2)}.`), 'err');
      v.feeBlocked = true;
    } else {
      v.feeBlocked = false;
      status(st, `${icon('shield')} First, 0.5 tTARI will be moved into your private balance to pay fees, so nothing links this vote to you. You'll approve twice.`);
    }
    updateCastButton();
  }
  function setFee(commitment, amount) {
    v.fee = commitment;
    UI.store.set(FEE_KEY, commitment);
    $('#fee-commitment').value = commitment;
    const amt = amount && amount !== '0' ? ` (${(Number(amount) / 1e6).toLocaleString(undefined, { maximumFractionDigits: 3 })} tTARI)` : '';
    status($('#fee-status'), okLine(`Fee will be paid privately from shielded TARI${esc(amt)}.`), 'ok');
    $('#fee-actions').hidden = true;
    updateCastButton();
  }
  $('#fee-commitment').addEventListener('change', (e) => {
    const c = e.target.value.trim().replace(/^0x/, '').toLowerCase();
    if (/^[0-9a-f]{64}$/.test(c)) setFee(c);
    else if (c) toast('That is not a commitment', 'Expected 64 hex characters.', 'err');
  });
  $('#btn-shield').onclick = async () => {
    const b = $('#btn-shield');
    b.disabled = true;
    status($('#fee-status'), spin('Approve the shield in your wallet…'));
    try {
      const r = await window.RcvWallet.submitTransactionRequest({ kind: 'shield', resourceAddress: XTR, amount: FEE_SHIELD });
      setFee(r.commitment, FEE_SHIELD);
      toast('Shielded 0.5 tTARI', 'Enough for several private ballots.', 'ok');
    } catch (e) {
      status($('#fee-status'), errLine(esc(e?.message || String(e))), 'err');
    } finally {
      b.disabled = false;
    }
  };
  function updateCastButton() {
    $('#btn-cast').disabled = !(v.ballot && v.step === 'cast' && (v.fee || !v.feeBlocked));
    $('#btn-cast').innerHTML = `${icon('vote')} ${v.fee ? 'Cast ballot' : 'Cast ballot privately'}`;
  }

  async function shieldFee(p) {
    p.step(`Approve the private fee in ${walletName()}`, 'Moves 0.5 tTARI into your private balance. This covers fees for several votes.', 'Step 1 of 2');
    const r = await window.RcvWallet.submitTransactionRequest({ kind: 'shield', resourceAddress: XTR, amount: FEE_SHIELD }, {
      onSubmitting: () => p.step('Shielding…', 'Waiting for the network to confirm.', 'Step 1 of 2'),
    });
    setFee(r.commitment, FEE_SHIELD);
  }

  $('#btn-cast').onclick = async () => {
    const e = v.election;
    const m = METHODS[e.tallyMethod] ?? METHODS.irv;
    const ids = m.ranked ? v.order : [v.pick];
    const btn = $('#btn-cast');
    const st = $('#cast-status');
    btn.disabled = true;
    status(st, '');
    let p = null;
    try {
      const caps = await window.RcvWallet.call('tari_getCapabilities');
      if (!caps?.stealthRedeemPrivateFee) throw new Error('This wallet cannot pay fees privately yet. Update Sapient or Tari Universe and try again.');
      p = UI.pending(walletName());
      const twoStep = !v.fee;
      if (twoStep) await shieldFee(p);
      p.step(`Approve your ballot in ${walletName()}`, 'Your ranking is sent with a one-time key. Nothing ties it to your wallet.', twoStep ? 'Step 2 of 2' : '');
      const result = await window.RcvWallet.submitTransactionRequest({
        kind: 'redeemStealthOutputWithPrivateFee',
        resourceAddress: e.ballotResource,
        commitmentHex: v.ballot,
        revealedAmount: BALLOT_AMOUNT,
        followUpInstructions: [{ CallMethod: { call: { Address: e.componentAddress }, method: 'cast_ballot', args: [{ Workspace: { id: 0, offset: null } }, { Literal: rankingCbor(ids) }] } }],
        feeResourceAddress: XTR,
        feeCommitmentHex: v.fee,
        maxFee: MAX_FEE,
        relatedComponents: [e.componentAddress],
      }, { onSubmitting: () => p.step('Casting your ballot…', 'Waiting for the network to confirm.', twoStep ? 'Step 2 of 2' : '') });
      p.close();
      p = null;
      if (result?.feeChangeCommitment) UI.store.set(FEE_KEY, result.feeChangeCommitment);
      status(st, '');
      $('#vflow').hidden = true;
      $('#done').hidden = false;
      const tx = result?.transactionId;
      $('#done-tx').hidden = !tx;
      if (tx) $('#done-tx').href = explorer.tx(tx);
      UI.confetti($('#done'));
      $('#done').scrollIntoView({ behavior: 'smooth', block: 'center' });
    } catch (err) {
      p?.close();
      const msg = window.RcvWallet.friendly(err);
      if (/is down|already spent/i.test(msg) && v.fee && msg.includes(v.fee)) {
        UI.store.del(FEE_KEY);
        v.fee = null;
        status(st, errLine('That shielded TARI was already spent. Shield a fresh amount and cast again.'), 'err');
        prepareFee();
      } else {
        status(st, errLine(esc(msg)), 'err');
      }
    } finally {
      updateCastButton();
    }
  };

  init();
})();
