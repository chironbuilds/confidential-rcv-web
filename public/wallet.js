// Wallet bridge shared by every Privote page: detection, silent reconnect, the header wallet chip,
// friendly errors and the create -> approve -> submit transaction-request flow.
// Works with Sapient (browser extension) and Tari Universe (dApp browser, via tari-connector.js).
window.RcvWallet = (function () {
  const POLL_TIMEOUT_MS = 5 * 60 * 1000;
  const POLL_INTERVAL_MS = 1200;
  const XTR = 'resource_0101010101010101010101010101010101010101010101010101010101010101';
  const listeners = new Set();
  const state = { provider: null, name: null, account: null, address: null, ready: null };

  // ---------- detection ----------
  function nameOf(p) {
    if (!p) return null;
    return p.info?.name || (p.isEmbedded ? 'Tari Universe' : 'Tari wallet');
  }
  // Several wallets can announce themselves (window.tariProviders). Inside Tari Universe's dApp
  // iframe the embedded provider is the right one; in a normal tab it cannot work, so prefer an
  // extension such as Sapient there.
  function pick() {
    const all = (window.tariProviders ?? []).filter(Boolean);
    if (window.tari && !all.includes(window.tari)) all.unshift(window.tari);
    const framed = window.top !== window;
    const embedded = all.find((p) => p.isEmbedded || p.info?.embedded);
    const extension = all.find((p) => !(p.isEmbedded || p.info?.embedded));
    return (framed ? embedded ?? extension : extension ?? embedded) ?? null;
  }
  function detect(timeoutMs = 1500) {
    if (state.ready) return state.ready;
    state.ready = new Promise((resolve) => {
      const done = () => {
        state.provider = pick();
        state.name = nameOf(state.provider);
        resolve(state.provider);
      };
      if (window.tari || window.tariProviders?.length) return done();
      const t = setTimeout(done, timeoutMs);
      const on = () => { clearTimeout(t); done(); };
      window.addEventListener('tari#initialized', on, { once: true });
      window.addEventListener('tari:announceProvider', on, { once: true });
    });
    return state.ready;
  }

  const call = (method, params) => state.provider.request(params === undefined ? { method } : { method, params });

  // ---------- friendly errors ----------
  function friendly(err) {
    const msg = String(err?.message || err || '');
    if (/locked/i.test(msg)) return 'Your wallet is locked. Unlock it, then try again.';
    if (/not connected|requestAccounts first/i.test(msg)) return 'This site is not connected to your wallet yet. Connect and try again.';
    if (/reject|denied|declined|cancel/i.test(msg)) return 'You declined the request in your wallet.';
    if (/No wallet set up/i.test(msg)) return 'Set up your wallet first, then come back.';
    if (/insufficient|not enough|exceeds/i.test(msg)) return 'Your wallet does not have enough tTARI for this.';
    if (/timed out/i.test(msg)) return 'The wallet did not respond in time. Open it and check for a pending request.';
    return msg || 'Something went wrong in the wallet.';
  }

  // ---------- connection ----------
  async function setAccount(account) {
    state.account = account ?? null;
    state.address = null;
    if (account) {
      try { state.address = await call('tari_getWalletAddress'); } catch { /* optional */ }
    }
    listeners.forEach((fn) => fn(snapshot()));
    renderChip();
  }
  const snapshot = () => ({ connected: !!state.account, account: state.account, address: state.address, name: state.name, available: !!state.provider });

  /** Reconnect without a prompt if this site was approved before. */
  async function silent() {
    await detect();
    if (!state.provider) { renderChip(); return snapshot(); }
    try {
      const accounts = await call('tari_getAccounts');
      if (accounts?.length) await setAccount(accounts[0]);
    } catch { /* provider without getAccounts */ }
    if (!state.hooked) {
      state.hooked = true;
      const onChange = (accounts) => setAccount(accounts?.[0] ?? null);
      try { state.provider.on?.('accountsChanged', onChange); } catch { /* optional */ }
      window.addEventListener('tari#accountsChanged', (e) => onChange(e.detail));
    }
    renderChip();
    return snapshot();
  }

  async function connect() {
    await detect();
    if (!state.provider) throw new Error('NO_WALLET');
    try {
      const accounts = await call('tari_requestAccounts');
      await setAccount(accounts?.[0] ?? null);
    } catch (e) {
      throw new Error(friendly(e));
    }
    return snapshot();
  }

  async function disconnect() {
    try { await call('tari_disconnect'); } catch { /* optional */ }
    await setAccount(null);
  }

  async function ensureView() {
    let r = await call('tari_getViewAccess');
    if (!r?.granted) r = await call('tari_requestViewAccess');
    if (!r?.granted) throw new Error('Privote needs permission to read your private outputs to find your ballot.');
  }

  /** Revealed (public) XTR balance in µT, or null if unknown. */
  async function publicXtr() {
    try {
      const b = await call('tari_getBalances');
      const x = (b ?? []).find((t) => t.resourceAddress === XTR);
      return x ? BigInt(x.amount) : 0n;
    } catch {
      return null;
    }
  }

  // ---------- approval flow ----------
  async function submitTransactionRequest(params, hooks = {}) {
    await detect();
    if (!state.provider) throw new Error('NO_WALLET');
    let requestId;
    try {
      ({ requestId } = await call('tari_createTransactionRequest', params));
    } catch (e) {
      throw new Error(friendly(e));
    }
    hooks.onAwaitingApproval?.();
    const deadline = Date.now() + POLL_TIMEOUT_MS;
    let record;
    for (;;) {
      record = await call('tari_getTransactionRequest', { requestId });
      if (record.status !== 'pending') break;
      if (Date.now() > deadline) throw new Error(friendly('timed out'));
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }
    if (record.status === 'rejected') throw new Error(friendly('rejected'));
    if (record.status === 'failed') throw new Error(friendly(record.error || 'The wallet reported an error.'));
    hooks.onSubmitting?.();
    return record.status === 'submitted' ? record.result : call('tari_submitTransactionRequest', { requestId });
  }

  // ---------- header chip ----------
  function renderChip() {
    const host = document.getElementById('wallet-chip');
    if (!host) return;
    const { icon, esc, avatar, short } = window.UI;
    if (!state.provider) {
      host.innerHTML = `<a class="btn btn-sm" href="https://sapient.tari.mw" target="_blank" rel="noopener" title="Install the Sapient wallet">${icon('wallet')}<span class="hide-sm">Get a wallet</span></a>`;
      return;
    }
    if (!state.account) {
      host.innerHTML = `<button class="btn btn-sm" id="chip-connect">${icon('wallet')}<span class="hide-sm">Connect</span></button>`;
      document.getElementById('chip-connect').onclick = async () => {
        try { await connect(); window.UI.toast(`Connected to ${state.name}`, '', 'ok', 2500); } catch (e) {
          window.UI.toast('Could not connect', e.message === 'NO_WALLET' ? 'No Tari wallet found.' : e.message, 'err');
        }
      };
      return;
    }
    const label = state.address ? short(state.address, 9, 4) : short(state.account, 12, 4);
    host.innerHTML = `<button class="wallet-pill" id="chip-menu" aria-haspopup="true" title="${esc(state.address ?? state.account)}">${avatar((state.address ?? state.account).slice(8), 5)}<span class="hide-sm">${esc(label)}</span></button>`;
    document.getElementById('chip-menu').onclick = async () => {
      const ok = await window.UI.confirmDialog({ title: `${state.name} connected`, body: `${state.address ?? state.account}\n\nDisconnect Privote from this wallet?`, confirm: 'Disconnect', danger: true });
      if (ok) disconnect();
    };
  }

  const onChange = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };

  return { detect, silent, connect, disconnect, ensureView, publicXtr, submitTransactionRequest, friendly, onChange, state: snapshot, call, XTR };
})();
