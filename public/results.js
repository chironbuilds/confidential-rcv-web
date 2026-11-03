// Turns the template's on-chain `VoteResult` into a visual, round-by-round result.
// VoteResult variants (v2 template): Irv=0, Fptp=1, SequentialIrv=2, Stv=3.
// The legacy pre-FPTP template used Irv=0, SequentialIrv=1, Stv=2.
(function () {
  const { esc, icon, avatar, colorFor } = window.UI;
  const STV_SCALE = 10_000;

  // ---------- normalisation (tolerates every decoded shape the indexer has produced) ----------
  function normCounts(counts) {
    const out = {};
    if (!counts) return out;
    if (counts instanceof Map) for (const [k, v] of counts) out[String(k)] = Number(v ?? 0);
    else if (counts['@cbor'] === 'map' && Array.isArray(counts.entries)) for (const [k, v] of counts.entries) out[String(k)] = Number(v ?? 0);
    else if (Array.isArray(counts)) for (const [k, v] of counts) out[String(k)] = Number(v ?? 0);
    else if (typeof counts === 'object') for (const [k, v] of Object.entries(counts)) out[k] = Number(v ?? 0);
    return out;
  }
  const opt = (v) => (Array.isArray(v) ? (v.length ? Number(v[0]) : null) : v == null ? null : Number(v));
  const field = (obj, i, name) => (Array.isArray(obj) ? obj[i] : obj?.[name]);
  const irvRound = (r) => ({ counts: normCounts(field(r, 0, 'counts')), eliminated: opt(field(r, 1, 'eliminated')) });
  const stvRound = (r) => ({
    counts: normCounts(field(r, 0, 'counts')),
    elected: (field(r, 1, 'elected') ?? []).map(Number),
    eliminated: opt(field(r, 2, 'eliminated')),
    quota: opt(field(r, 3, 'quota')),
  });

  function normalize(result, schema = 'v2') {
    if (result == null) return null;
    let variant;
    let payload;
    if (Array.isArray(result)) {
      [variant, payload] = result;
      if (Array.isArray(payload) && payload.length === 1 && Array.isArray(payload[0])) payload = payload[0];
    } else if (typeof result === 'object') {
      const key = Object.keys(result)[0];
      payload = result[key];
      variant = { Irv: 0, Fptp: 1, SequentialIrv: 2, Stv: 3 }[key];
      if (variant === undefined) return null;
      schema = 'v2';
    } else return null;
    const kinds = schema === 'legacy' ? ['Irv', 'SequentialIrv', 'Stv'] : ['Irv', 'Fptp', 'SequentialIrv', 'Stv'];
    const kind = kinds[Number(variant)];
    if (kind === 'Irv') return { kind, winner: opt(field(payload, 0, 'winner')), rounds: (field(payload, 1, 'rounds') ?? []).map(irvRound) };
    if (kind === 'Fptp') return { kind, winner: opt(field(payload, 0, 'winner')), counts: normCounts(field(payload, 1, 'counts')) };
    if (kind === 'SequentialIrv') {
      return {
        kind,
        winners: (field(payload, 0, 'winners') ?? []).map(Number),
        seats: (field(payload, 1, 'seats') ?? []).map((s) => ({ winner: opt(field(s, 0, 'winner')), rounds: (field(s, 1, 'irv_rounds') ?? []).map(irvRound) })),
      };
    }
    if (kind === 'Stv') return { kind, winners: (field(payload, 0, 'winners') ?? []).map(Number), rounds: (field(payload, 1, 'rounds') ?? []).map(stvRound) };
    return null;
  }

  // ---------- rendering ----------
  function render(host, result, election) {
    const names = election?.candidates ?? [];
    const name = (id) => (id != null && Number(id) < names.length ? names[Number(id)] : `Candidate ${Number(id) + 1}`);
    const r = normalize(result, election?.resultSchema);
    if (!r) {
      host.innerHTML = '<div class="callout warn">' + icon('alert') + '<div>The tally came back in a shape this page does not recognise. The raw result is below.</div></div>';
      return;
    }
    const ballots = election?.state?.ballotCount != null ? Number(election.state.ballotCount) : null;
    const winnerIds = r.kind === 'Irv' || r.kind === 'Fptp' ? (r.winner != null ? [r.winner] : []) : r.winners;
    const banner = winnerIds.length
      ? `<div class="winner-banner"><div class="trophy">${icon('trophy')}</div><div>
          <div class="w-label">${winnerIds.length > 1 ? `${winnerIds.length} winners` : 'Winner'}</div>
          <div class="w-name">${winnerIds.map((id) => esc(name(id))).join(' · ')}</div>
          <div class="w-sub">${methodLine(r, ballots)}</div></div></div>`
      : `<div class="winner-banner none"><div class="trophy">${icon('flag')}</div><div>
          <div class="w-label">No winner</div><div class="w-name">${ballots === 0 ? 'No ballots were cast' : 'The count ended in a tie'}</div>
          <div class="w-sub">${ballots === 0 ? 'An election with zero turnout has no winner.' : 'A tied election must be re-run.'}</div></div></div>`;
    host.innerHTML = banner + '<div class="r-detail"></div>';
    const detail = host.querySelector('.r-detail');

    if (r.kind === 'Fptp') {
      detail.innerHTML = '<h3 class="mt-24" style="font-size:15px">First-choice votes</h3><div class="bars mt-12"></div>';
      drawBars(detail.querySelector('.bars'), r.counts, { names, winners: winnerIds, total: sum(r.counts) });
      return;
    }
    if (r.kind === 'Irv') return roundsView(detail, r.rounds, { names, name, final: winnerIds });
    if (r.kind === 'Stv') return roundsView(detail, r.rounds, { names, name, stv: true, final: winnerIds });
    if (r.kind === 'SequentialIrv') {
      detail.innerHTML = '<div class="seat-tabs pills"></div><div class="seat-body"></div>';
      const tabs = detail.querySelector('.seat-tabs');
      const body = detail.querySelector('.seat-body');
      r.seats.forEach((seat, i) => {
        const b = document.createElement('button');
        b.className = 'pill-btn';
        b.textContent = `Seat ${i + 1}${seat.winner != null ? ` · ${name(seat.winner)}` : ''}`;
        b.onclick = () => {
          tabs.querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', 'false'));
          b.setAttribute('aria-pressed', 'true');
          roundsView(body, seat.rounds, { names, name, final: seat.winner != null ? [seat.winner] : [] });
        };
        tabs.appendChild(b);
      });
      tabs.querySelector('button')?.click();
    }
  }

  const sum = (c) => Object.values(c).reduce((a, b) => a + b, 0);

  function methodLine(r, ballots) {
    const n = ballots != null ? `${ballots} ballot${ballots === 1 ? '' : 's'}` : '';
    if (r.kind === 'Fptp') return [n, 'most first choices'].filter(Boolean).join(' · ');
    if (r.kind === 'Irv') return [n, `decided in ${r.rounds.length} round${r.rounds.length === 1 ? '' : 's'}`].filter(Boolean).join(' · ');
    if (r.kind === 'Stv') return [n, `${r.rounds.length} counting rounds`, 'Droop quota'].filter(Boolean).join(' · ');
    return [n, `${r.seats.length} seats filled by repeated runoff`].filter(Boolean).join(' · ');
  }

  function roundsView(host, rounds, opts) {
    if (!rounds.length) {
      host.innerHTML = '<p class="muted mt-16">No counting rounds were recorded.</p>';
      return;
    }
    host.innerHTML = `<div class="round-nav">
        <button class="icon-btn" data-dir="-1" aria-label="Previous round">${icon('left')}</button>
        <span class="round-label"></span>
        <button class="icon-btn" data-dir="1" aria-label="Next round">${icon('right')}</button>
        <div class="round-dots"></div>
        <button class="btn btn-sm btn-ghost" data-play>${icon('zap')} Replay</button>
      </div>
      <div class="bars"></div>
      <div class="round-note"></div>`;
    const dots = host.querySelector('.round-dots');
    rounds.forEach((_, i) => {
      const d = document.createElement('button');
      d.setAttribute('aria-label', `Round ${i + 1}`);
      d.onclick = () => show(i);
      dots.appendChild(d);
    });
    const outBefore = (i) => {
      const s = new Set();
      for (let k = 0; k < i; k++) if (rounds[k].eliminated != null) s.add(rounds[k].eliminated);
      return s;
    };
    const electedBefore = (i) => {
      const s = new Set();
      for (let k = 0; k <= i; k++) (rounds[k].elected ?? []).forEach((c) => s.add(c));
      return s;
    };
    let cur = 0;
    let timer = null;
    function show(i) {
      cur = Math.max(0, Math.min(rounds.length - 1, i));
      const r = rounds[cur];
      const last = cur === rounds.length - 1;
      host.querySelector('.round-label').textContent = `Round ${cur + 1} of ${rounds.length}`;
      dots.querySelectorAll('button').forEach((d, k) => d.classList.toggle('active', k === cur));
      host.querySelector('[data-dir="-1"]').disabled = cur === 0;
      host.querySelector('[data-dir="1"]').disabled = last;
      const counts = { ...r.counts };
      for (const c of outBefore(cur)) if (!(c in counts)) counts[c] = 0;
      drawBars(host.querySelector('.bars'), counts, {
        names: opts.names,
        out: outBefore(cur),
        elim: r.eliminated,
        winners: opts.stv ? [...electedBefore(cur)] : last ? opts.final : [],
        scale: opts.stv ? STV_SCALE : 1,
        quota: opts.stv && r.quota ? r.quota : null,
        total: opts.stv ? null : sum(r.counts),
      });
      const note = host.querySelector('.round-note');
      const parts = [];
      if (opts.stv && r.quota) parts.push(`<span class="badge outline">Quota ${fmtNum(r.quota / STV_SCALE)}</span>`);
      if (r.elected?.length) parts.push(`Elected <b>${r.elected.map((c) => esc(opts.name(c))).join(', ')}</b>.`);
      if (r.eliminated != null) parts.push(`Lowest count: <b>${esc(opts.name(r.eliminated))}</b> is eliminated and their ballots move to each voter's next choice.`);
      else if (last && !opts.stv) parts.push(opts.final.length ? `<b>${esc(opts.name(opts.final[0]))}</b> wins with a majority of continuing ballots.` : 'No candidate could be separated, so there is no winner.');
      note.innerHTML = parts.join(' ');
    }
    host.querySelectorAll('[data-dir]').forEach((b) => (b.onclick = () => { stop(); show(cur + Number(b.dataset.dir)); }));
    const stop = () => { clearInterval(timer); timer = null; };
    host.querySelector('[data-play]').onclick = () => {
      stop();
      show(0);
      timer = setInterval(() => (cur >= rounds.length - 1 ? stop() : show(cur + 1)), 1300);
    };
    show(0);
    if (rounds.length > 1) timer = setInterval(() => (cur >= rounds.length - 1 ? stop() : show(cur + 1)), 1300);
  }

  const fmtNum = (n) => (Number.isInteger(n) ? String(n) : n.toFixed(2));

  function drawBars(host, counts, o) {
    const scale = o.scale || 1;
    const ids = Object.keys(counts).map(Number).sort((a, b) => a - b);
    const max = Math.max(1, ...ids.map((id) => counts[id]), o.quota ?? 0);
    const existing = new Map([...host.children].map((el) => [el.dataset.id, el]));
    ids.forEach((id) => {
      let row = existing.get(String(id));
      if (!row) {
        row = document.createElement('div');
        row.className = 'bar-row';
        row.dataset.id = String(id);
        const nm = o.names[id] ?? `Candidate ${id + 1}`;
        row.innerHTML = `<div class="b-name">${avatar(nm, id)}<span title="${esc(nm)}">${esc(nm)}</span></div>
          <div class="bar-track"><div class="bar-fill" style="--c:${colorFor(id)}"></div></div><div class="b-val"></div>`;
        host.appendChild(row);
      }
      const v = counts[id];
      row.classList.toggle('out', o.out?.has(id) ?? false);
      row.classList.toggle('elim', o.elim === id);
      row.classList.toggle('win', o.winners?.includes(id) ?? false);
      const pct = (v / max) * 100;
      requestAnimationFrame(() => (row.querySelector('.bar-fill').style.width = `${pct}%`));
      const shown = fmtNum(v / scale);
      const pctLabel = o.total ? `<span class="pct">${Math.round((v / o.total) * 100)}%</span>` : '';
      row.querySelector('.b-val').innerHTML = o.out?.has(id) ? '<span class="muted">—</span>' : `${shown}${pctLabel}`;
      row.title = o.total ? `${shown} votes (${Math.round((v / o.total) * 100)}%)` : `${shown} votes`;
      let q = row.querySelector('.quota-line');
      if (o.quota) {
        if (!q) {
          q = document.createElement('div');
          q.className = 'quota-line';
          row.querySelector('.bar-track').appendChild(q);
        }
        q.style.left = `${(o.quota / max) * 100}%`;
      } else q?.remove();
    });
  }

  window.Results = { normalize, render };
})();
