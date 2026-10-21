// KeyVault UI. Plain JavaScript, no dependencies, no network calls except to
// the local KeyVault process that served this page.
'use strict';

(() => {
  // ---------------------------------------------------------------- helpers
  const $ = (sel, root = document) => root.querySelector(sel);

  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v == null || v === false) continue;
        if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
        else if (k === 'class') el.className = v;
        else if (k === 'dataset') Object.assign(el.dataset, v);
        else el.setAttribute(k, v === true ? '' : String(v));
      }
    }
    for (const kid of kids.flat(Infinity)) {
      if (kid == null || kid === false) continue;
      el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
    }
    return el;
  }

  const ICONS = {
    down: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14"/><path d="M19 12l-7 7-7-7"/></svg>',
    note: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4h16v12H8l-4 4z"/></svg>',
    up: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5"/><path d="M5 12l7-7 7 7"/></svg>',
    close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="square"><path d="M6 6l12 12"/><path d="M18 6L6 18"/></svg>',
    sub: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="square" stroke-linejoin="miter"><path d="M6 3v10h12"/><path d="M14 9l4 4-4 4"/></svg>',
    copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>',
    edit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>',
    trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/></svg>',
    play: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 4.5v15l13-7.5z"/></svg>',
    stop: '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="1.5"/></svg>',
    restart: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/></svg>',
    logs: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 6h16M4 12h16M4 18h10"/></svg>',
    open: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 4h6v6"/><path d="M20 4 10 14"/><path d="M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5"/></svg>',
  };
  function iconBtn(name, label, onclick, extra = '') {
    const b = h('button', { type: 'button', class: `icon-btn ${extra}`.trim(), title: label, 'aria-label': label, onclick });
    b.innerHTML = ICONS[name];   // static, trusted markup
    return b;
  }

  const TYPES = ['LLM', 'Cloud', 'Database', 'Payments', 'Service', 'Other'];
  const ENVS = ['Production', 'Staging', 'Development', 'Personal'];
  const STATUSES = { active: 'Active', rotated: 'Rotated', revoked: 'Revoked' };
  const PROVIDERS = {
    'Anthropic': ['LLM', 'ANTHROPIC_API_KEY'], 'OpenAI': ['LLM', 'OPENAI_API_KEY'], 'Google Gemini': ['LLM', 'GEMINI_API_KEY'],
    'Mistral': ['LLM', 'MISTRAL_API_KEY'], 'Groq': ['LLM', 'GROQ_API_KEY'], 'xAI': ['LLM', 'XAI_API_KEY'],
    'DeepSeek': ['LLM', 'DEEPSEEK_API_KEY'], 'Perplexity': ['LLM', 'PERPLEXITY_API_KEY'], 'OpenRouter': ['LLM', 'OPENROUTER_API_KEY'],
    'Together AI': ['LLM', 'TOGETHER_API_KEY'], 'Hugging Face': ['LLM', 'HF_TOKEN'], 'Cohere': ['LLM', 'CO_API_KEY'],
    'ElevenLabs': ['Service', 'ELEVENLABS_API_KEY'], 'AWS': ['Cloud', 'AWS_SECRET_ACCESS_KEY'], 'Azure': ['Cloud', ''],
    'Google Cloud': ['Cloud', ''], 'Cloudflare': ['Cloud', 'CLOUDFLARE_API_TOKEN'], 'Vercel': ['Cloud', 'VERCEL_TOKEN'],
    'Hetzner': ['Cloud', 'HCLOUD_TOKEN'], 'Supabase': ['Database', 'SUPABASE_SERVICE_ROLE_KEY'], 'Neon': ['Database', 'DATABASE_URL'],
    'Pinecone': ['Database', 'PINECONE_API_KEY'], 'Stripe': ['Payments', 'STRIPE_SECRET_KEY'], 'GoCardless': ['Payments', 'GOCARDLESS_ACCESS_TOKEN'],
    'GitHub': ['Service', 'GITHUB_TOKEN'], 'Twilio': ['Service', 'TWILIO_AUTH_TOKEN'], 'Resend': ['Service', 'RESEND_API_KEY'],
    'SendGrid': ['Service', 'SENDGRID_API_KEY'], 'Slack': ['Service', 'SLACK_BOT_TOKEN'], 'Xero': ['Service', 'XERO_CLIENT_SECRET'],
  };

  const S = {
    state: null, vault: null, tab: 'keys',
    filter: { org: 'all', type: 'all', status: 'all', q: '' },
    revealed: new Map(), editingId: null, services: null, svcBusy: false,
    lastTouch: 0, clipTimer: 0, logsRef: null, linksProject: null,
  };

  const fmtDate = ms => new Date(ms).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  const fmtDateTime = ms => new Date(ms).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  function ago(ms) {
    const d = Math.floor((Date.now() - ms) / 86400000);
    return d <= 0 ? 'today' : d === 1 ? 'yesterday' : `${d} days ago`;
  }

  // ---------------------------------------------------------------- Ranger One R1 mark
  // Port of Ranger One's LogoMark component. The boot sequence (pixels light
  // bottom to top, hold, fade, loop) is the only approved animation for the mark.
  const R1_R = [[1,1,1,1,0],[1,0,0,0,1],[1,0,0,0,1],[1,1,1,1,0],[1,0,1,0,0],[1,0,0,1,0],[1,0,0,0,1]];
  const R1_ONE = [[0,1,0],[1,1,0],[0,1,0],[0,1,0],[0,1,0],[0,1,0],[1,1,1]];
  const R1_SIZES = { sm: [4, 1], md: [7, 1.8], lg: [10, 2.5] };
  const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

  function buildR1(mark) {
    const [px, gap] = R1_SIZES[mark.dataset.size] || R1_SIZES.md;
    const anim = reduceMotion ? '' : (mark.dataset.anim || '');
    const grid = (data, lit, dim) => {
      const el = document.createElement('div');
      el.style.gridTemplateColumns = `repeat(${data[0].length}, ${px}px)`;
      el.style.gap = `${gap}px`;
      const rows = data.map(row => row.map(cell => {
        const d = document.createElement('div');
        d.style.width = `${px}px`; d.style.height = `${px}px`;
        d.dataset.lit = lit; d.dataset.dim = dim; d.dataset.on = cell ? '1' : '0';
        d.style.background = cell && !anim ? lit : dim;
        el.append(d);
        return d;
      }));
      mark.append(el);
      return rows;
    };
    const grids = [grid(R1_R, '#F8FAFC', 'rgba(248,250,252,0.06)'), grid(R1_ONE, '#0074D9', 'rgba(0,116,217,0.1)')];
    if (!anim) return;
    const n = R1_R.length;
    const each = fn => grids.forEach(g => g.forEach(r => r.forEach(fn)));
    const boot = () => {
      each(p => { p.style.transition = 'background-color 0.08s'; p.style.background = p.dataset.dim; });
      setTimeout(() => {
        for (let r = n - 1; r >= 0; r--) {
          setTimeout(() => grids.forEach(g => g[r].forEach(p => {
            if (p.dataset.on === '1') { p.style.transition = 'background-color 0.13s ease'; p.style.background = p.dataset.lit; }
          })), (n - 1 - r) * 120);
        }
        if (anim !== 'loop') return;          // "once": boot, then stay lit
        setTimeout(() => {
          each(p => { p.style.transition = 'background-color 350ms ease'; p.style.background = p.dataset.dim; });
          setTimeout(boot, 950);
        }, n * 120 + 2800);
      }, 400);
    };
    boot();
  }
  document.querySelectorAll('.r1').forEach(buildR1);

  // ---------------------------------------------------------------- toast
  let toastTimer = 0;
  function toast(msg, kind = '') {
    const t = $('#toast');
    t.textContent = msg;
    t.className = `toast show ${kind}`;
    if (t.showPopover) { try { t.hidePopover(); } catch {} try { t.showPopover(); } catch {} }
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.className = 'toast'; if (t.hidePopover) { try { t.hidePopover(); } catch {} } }, 3600);
  }

  // ---------------------------------------------------------------- session
  // The one-time login link lands here as /#session=TOKEN. Keep the token in
  // localStorage, which belongs to this exact origin (host and port), so every
  // KeyVault tab in this browser shares one sign-in and it survives restarts.
  // Wipe it from the address bar and history entry immediately.
  let SESSION = '';
  const readSession = () => {
    try { return localStorage.getItem('kv-session') || sessionStorage.getItem('kv-session') || ''; } catch { return ''; }
  };
  (() => {
    const m = /(?:^#|&)session=([A-Za-z0-9_-]+)/.exec(location.hash);
    if (m) {
      SESSION = m[1];
      history.replaceState(null, '', location.pathname);
    } else {
      SESSION = readSession();
    }
    try { localStorage.setItem('kv-session', SESSION); sessionStorage.removeItem('kv-session'); } catch {}
  })();
  // Another tab signed in with a fresh link: use its session here too.
  window.addEventListener('storage', e => {
    if (e.key === 'kv-session' && e.newValue && e.newValue !== SESSION) { SESSION = e.newValue; location.reload(); }
  });

  // ---------------------------------------------------------------- API
  class ApiError extends Error { constructor(m, status, data) { super(m); this.status = status; this.data = data; } }

  async function api(method, path, body, { raw = false } = {}) {
    let res;
    try {
      res = await fetch(path, {
        method, credentials: 'omit', cache: 'no-store',
        headers: { 'x-keyvault': '1', 'x-keyvault-session': SESSION, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch {
      showExpired(true);
      throw new ApiError('KeyVault is not responding', 0);
    }
    if (res.status === 401) { showExpired(false); throw new ApiError('Session ended', 401); }
    if (raw && res.ok) return res;
    let data = null;
    try { data = await res.json(); } catch {}
    if (res.status === 423) { lockUi('KeyVault locked itself.'); throw new ApiError('Locked', 423); }
    if (!res.ok) throw new ApiError(data?.error || `Something went wrong (${res.status})`, res.status, data);
    return data;
  }

  // ---------------------------------------------------------------- dialogs
  // Focus a field after a dialog opens, unless you already clicked or typed into another one.
  function focusIfIdle(dlg, field) {
    setTimeout(() => {
      const a = document.activeElement;
      if (a && a !== $(field) && $(dlg).contains(a) && a.matches('input, textarea, select')) return;
      $(field).focus();
    }, 30);
  }
  function openDialog(id) { const d = $(id); if (!d.open) d.showModal(); return d; }
  document.addEventListener('click', e => {
    const c = e.target.closest('[data-close]');
    if (c) c.closest('dialog')?.close();
  });

  function confirmBox({ title, body, ok = 'Confirm', danger = false, requireText = null }) {
    return new Promise(resolve => {
      const d = $('#dlg-confirm');
      $('#confirm-title').textContent = title;
      $('#confirm-body').textContent = body;
      const okBtn = $('#confirm-ok');
      okBtn.textContent = ok;
      okBtn.className = `btn ${danger ? 'danger' : 'primary'}`;
      const wrap = $('#confirm-input-wrap'); const input = $('#confirm-input');
      wrap.hidden = !requireText; input.value = '';
      if (requireText) $('#confirm-input-label').textContent = `Type ${requireText} to confirm`;
      let settled = false;
      const finish = v => {
        if (settled) return; settled = true;
        $('#confirm-form').onsubmit = null; $('#confirm-cancel').onclick = null; d.onclose = null;
        if (d.open) d.close();
        resolve(v);
      };
      $('#confirm-form').onsubmit = e => {
        e.preventDefault();
        if (requireText && input.value.trim() !== requireText) { input.focus(); return; }
        finish(true);
      };
      $('#confirm-cancel').onclick = () => finish(false);
      d.onclose = () => finish(false);
      d.showModal();
      (requireText ? input : okBtn).focus();
    });
  }

  function download(name, blob) {
    const url = URL.createObjectURL(blob);
    const a = h('a', { href: url, download: name });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  function filenameFrom(res, fallback) {
    const m = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') || '');
    return m ? m[1] : fallback;
  }

  // ---------------------------------------------------------------- screens
  function show(id) {
    for (const s of ['#boot', '#gate', '#expired', '#app']) $(s).hidden = s !== id;
  }

  let reconnectTimer = 0;
  function showExpired(notRunning) {
    stopTimers();
    clearInterval(reconnectTimer);
    // KeyVault stopped (for example the computer restarted). Keep checking, and
    // come back by ourselves as soon as it is running again.
    if (notRunning) {
      reconnectTimer = setInterval(async () => {
        try {
          const r = await fetch('/api/status', { credentials: 'omit', cache: 'no-store', headers: { 'x-keyvault': '1', 'x-keyvault-session': SESSION } });
          if (r.status === 200 || r.status === 401) location.reload();
        } catch {}
      }, 3000);
    }
    document.querySelectorAll('dialog[open]').forEach(d => d.close());
    $('#expired-title').textContent = notRunning ? 'KeyVault is not running' : 'This window is no longer connected';
    $('#expired-body').textContent = notRunning
      ? 'KeyVault has stopped. Double-click KeyVault.exe to start it again, and this page will reconnect by itself.'
      : 'This browser is not signed in to KeyVault, or was signed out. Double-click KeyVault.exe to sign in again. Every KeyVault tab in this browser will then work.';
    show('#expired');
  }

  let gateMode = 'unlock';
  function showGate(mode, info) {
    gateMode = mode;
    wipeSecrets();
    S.vault = null;
    stopServicesTimer();
    document.querySelectorAll('dialog[open]').forEach(d => d.close());
    const create = mode === 'create';
    $('#gate-title').textContent = create ? 'Create your vault' : 'Unlock your vault';
    $('#gate-sub').textContent = create
      ? 'Choose a master password. It encrypts everything you store and cannot be recovered, so pick a phrase you will remember.'
      : 'Enter your master password.';
    $('#pw2-wrap').hidden = !create;
    $('#orgs-wrap').hidden = !create;
    $('#pw').autocomplete = create ? 'new-password' : 'current-password';
    $('#gate-submit').textContent = create ? 'Create vault' : 'Unlock';
    $('#gate-info').hidden = !info;
    $('#gate-info').textContent = info || '';
    $('#gate-err').hidden = true;
    $('#pw').value = ''; $('#pw2').value = '';
    gatePass(null);
    show('#gate');
    setTimeout(() => $('#pw').focus(), 30);
  }

  function gateError(msg) { const e = $('#gate-err'); e.textContent = msg; e.hidden = !msg; }

  $('#gate-form').addEventListener('submit', async e => {
    e.preventDefault();
    const btn = $('#gate-submit');
    if (btn.disabled) return;
    gateError('');
    const pw = $('#pw').value;
    if (gateMode === 'create') {
      if (pw.length < 10) return gateError('Use at least 10 characters. A short phrase like "copper kettle morning" works well.');
      if (pw !== $('#pw2').value) return gateError('The two passwords do not match.');
    } else if (!pw) return gateError('Enter your master password.');
    const label = btn.textContent;
    btn.disabled = true; btn.textContent = gateMode === 'create' ? 'Creating…' : 'Unlocking…';
    try {
      if (gateMode === 'create') {
        const orgs = $('#orgs-init').value.split(',').map(s => s.trim()).filter(Boolean);
        await api('POST', '/api/create', { password: pw, orgs });
        $('#orgs-init').value = '';
      } else {
        await api('POST', '/api/unlock', { password: pw });
      }
      $('#pw').value = ''; $('#pw2').value = '';
      await enterApp();
      poll();
    } catch (err) {
      if (err.status === 403) { gateError('Incorrect password.'); $('#pw').select(); }
      else if (err.status && err.status !== 401) gateError(err.message);
    } finally {
      btn.disabled = false; btn.textContent = label;
    }
  });

  $('#btn-restore-gate').addEventListener('click', () => $('#file-restore').click());
  $('#file-restore').addEventListener('change', async e => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    if (file.size > 20 * 1024 * 1024) return toast('That file is too big to be a KeyVault backup.', 'bad');
    const text = await file.text();
    if (S.state !== 'none') {
      const go = await confirmBox({
        title: 'Replace the current vault?',
        body: 'Restoring replaces the vault on this computer with the backup. The current version is kept next to it as vault.previous.json, but download a backup first if you are unsure.',
        ok: 'Restore backup', danger: true,
      });
      if (!go) return;
    }
    try {
      await api('POST', '/api/restore', { text });
      S.state = 'locked';
      showGate('unlock', 'Backup restored. Unlock it with the master password that was in use when the backup was made.');
    } catch (err) { if (err.status) toast(err.message, 'bad'); }
  });

  // ---------------------------------------------------------------- app shell
  async function enterApp() {
    S.vault = await api('GET', '/api/vault');
    S.state = 'unlocked';
    S.lastTouch = Date.now();
    show('#app');
    render();
    setTab(TABS.includes(location.hash.slice(1)) ? location.hash.slice(1) : 'keys');
    offerAutostart();
  }

  // ----- start at sign-in: asked once, then lives in Settings
  async function autostartStatus() {
    try { S.autostart = await api('GET', '/api/autostart'); } catch { S.autostart = { supported: false }; }
    return S.autostart;
  }
  async function setAutostart(on) {
    try {
      S.autostart = await api('PUT', '/api/autostart', { enabled: on });
      toast(on ? 'KeyVault will start in the background when you sign in.' : 'KeyVault will no longer start when you sign in.');
    } catch (err) { if (err.status) toast(err.message, 'bad'); }
    fillAutostart();
  }
  function fillAutostart() {
    const st = S.autostart || {};
    $('#s-autostart-sec').hidden = !st.supported;
    $('#s-autostart').checked = !!st.enabled;
    $('#s-autostart-note').textContent = st.enabled && st.current === false
      ? 'The current entry starts a different copy of KeyVault. Switch this off and on again to use this one.'
      : st.enabled ? 'On. KeyVault starts hidden when you sign in; the vault stays locked until you unlock it here.'
        : 'No more opening KeyVault after a restart. It starts hidden; the vault stays locked until you unlock it here.';
  }
  async function offerAutostart() {
    if (lsGet('kv-autostart-asked')) return;
    const st = await autostartStatus();
    $('#as-banner').hidden = !st.supported || st.enabled;
  }
  $('#as-yes').addEventListener('click', async () => { lsSet('kv-autostart-asked', '1'); $('#as-banner').hidden = true; await setAutostart(true); });
  $('#as-no').addEventListener('click', () => { lsSet('kv-autostart-asked', '1'); $('#as-banner').hidden = true; toast('You can turn it on any time in Settings.'); });
  $('#s-autostart').addEventListener('change', e => setAutostart(e.target.checked));

  async function reloadVault() {
    S.vault = await api('GET', '/api/vault');
    render();
  }

  function lockUi(info) {
    S.state = 'locked';
    showGate('unlock', info);
    setTimeout(poll, 50);   // shows whether an agent pass is still running
  }


  // ---------------------------------------------------------------- agent pass
  // Keeps the vault available to AI tools until a set time while this page still locks.
  const hhmm = ms => new Date(ms).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  function passWhen(ms) {
    const d = new Date(ms); const today = new Date();
    const tomorrow = new Date(); tomorrow.setDate(today.getDate() + 1);
    const day = d.toDateString() === today.toDateString() ? 'today' : d.toDateString() === tomorrow.toDateString() ? 'tomorrow' : d.toLocaleDateString('en-GB', { weekday: 'long' });
    return `${day} at ${hhmm(ms)}`;
  }
  function leftFor(ms) {
    const m = Math.max(0, Math.round((ms - Date.now()) / 60000));
    return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`;
  }
  // The next time the clock shows HH:MM, at least 5 minutes from now.
  function nextAt(value) {
    const [h, mi] = String(value || '').split(':').map(Number);
    if (!Number.isFinite(h) || !Number.isFinite(mi)) return null;
    const d = new Date(); d.setSeconds(0, 0); d.setHours(h, mi);
    if (d.getTime() < Date.now() + 5 * 60_000) d.setDate(d.getDate() + 1);
    return d.getTime();
  }
  function setPass(pass) {
    S.pass = pass || null;
    const b = $('#btn-pass');
    b.textContent = S.pass ? `Agent pass · until ${hhmm(S.pass.until)}` : 'Agent pass';
    b.classList.toggle('glow-start', !!S.pass);
    b.title = S.pass
      ? `Your AI tools can use KeyVault until ${passWhen(S.pass.until)}${S.pass.project ? `, only ${S.pass.project.name} and its keys` : ''}. Click to change or end it.`
      : 'Keep KeyVault available to your AI tools while you are away';
  }
  function passWhenNote() {
    const at = nextAt($('#pass-time').value);
    $('#pass-when').textContent = at ? `Ends ${passWhen(at)}, in ${leftFor(at)}.` : '';
  }
  function passDialog() {
    $('#pass-autolock').textContent = plural(S.vault.settings.autoLockMin, 'minute');
    const projs = projects().filter(x => x.status !== 'archived').sort(projSort);
    $('#pass-scope').replaceChildren(
      h('option', { value: '' }, 'Everything: all keys and projects'),
      ...projs.map(x => h('option', { value: x.id }, `Only ${x.name} and its ${plural((x.keyIds || []).length, 'linked key')}`)));
    $('#pass-err').hidden = true;
    const p = S.pass;
    $('#pass-active').hidden = !p;
    if (p) {
      $('#pass-active-text').textContent = `Running until ${passWhen(p.until)} (${leftFor(p.until)} left)${p.project ? `, only ${p.project.name}` : ', everything'}.`;
      $('#pass-time').value = hhmm(p.until);
      $('#pass-scope').value = p.project?.id || '';
    }
    $('#pass-go').textContent = p ? 'Update pass' : 'Start agent pass';
    passWhenNote();
    openDialog('#dlg-pass');
  }
  $('#btn-pass').addEventListener('click', passDialog);
  $('#pass-time').addEventListener('input', passWhenNote);
  $('#pass-scope').addEventListener('change', () => {
    const x = projById($('#pass-scope').value);
    $('#pass-err').hidden = !(x && !(x.keyIds || []).length);
    $('#pass-err').textContent = x && !(x.keyIds || []).length ? `${x.name} has no keys linked yet, so your AI tools would get no keys. Link them in the project under "Keys this project uses".` : '';
  });
  $('#pass-form').addEventListener('submit', async e => {
    e.preventDefault();
    const until = nextAt($('#pass-time').value);
    if (!until) { $('#pass-err').textContent = 'Choose a time.'; $('#pass-err').hidden = false; return; }
    try {
      const { pass } = await api('POST', '/api/agent-pass', { until, projectId: $('#pass-scope').value || null });
      setPass(pass);
      $('#dlg-pass').close();
      toast(`Agent pass on until ${passWhen(pass.until)}. This page still locks as usual; your AI tools keep working.`);
    } catch (err) { if (err.status) { $('#pass-err').textContent = err.message; $('#pass-err').hidden = false; } }
  });
  async function endPass() {
    try { await api('DELETE', '/api/agent-pass'); } catch (err) { if (err.status) toast(err.message, 'bad'); return false; }
    setPass(null);
    return true;
  }
  $('#pass-end').addEventListener('click', async () => { if (await endPass()) { $('#dlg-pass').close(); toast('Agent pass ended. KeyVault locks after the usual time again.'); } });
  $('#gate-pass-end').addEventListener('click', async () => {
    if (await endPass()) { S.state = 'locked'; showGate('unlock', 'Agent pass ended. KeyVault is fully locked.'); }
  });
  // On the lock screen: say that AI tools are still working, and offer to stop them.
  function gatePass(pass) {
    $('#gate-pass').hidden = !pass;
    if (pass) $('#gate-pass-text').textContent = `Agent pass running until ${passWhen(pass.until)}. Your AI tools can keep working while this page is locked.`;
  }

  $('#btn-lock').addEventListener('click', async () => {
    const hadPass = !!S.pass;
    try { await api('POST', '/api/lock'); } catch {}
    setPass(null);
    lockUi(hadPass ? 'Locked. The agent pass has ended.' : 'Locked.');
  });

  const TABS = ['keys', 'projects', 'apps', 'services'];
  function setTab(tab) {
    S.tab = tab;
    for (const t of TABS) {
      $(`#tab-${t}`).setAttribute('aria-selected', String(tab === t));
      $(`#view-${t}`).hidden = tab !== t;
    }
    history.replaceState(null, '', tab === 'keys' ? '#' : `#${tab}`);
    if (tab === 'apps' || tab === 'services') { loadServices(); startServicesTimer(); } else stopServicesTimer();
    if (tab === 'projects') { renderProjects(); loadProjectStatus(); }
  }
  for (const t of TABS) $(`#tab-${t}`).addEventListener('click', () => setTab(t));

  function render() {
    if (!S.vault) return;
    renderSidebar(); renderStats(); renderKeys();
    if (S.tab === 'projects') renderProjects();
    const st = S.vault.settings;
    $('#appfoot').textContent = `KeyVault ${S.version ? `v${S.version}` : ''}  ·  Vault ${S.vault.vaultPath}  ·  Auto-locks after ${st.autoLockMin} min idle  ·  MIT licence`;
  }

  // ---------------------------------------------------------------- keys: filters
  const orgById = id => S.vault.orgs.find(o => o.id === id);

  function navItem(label, count, active, color, onclick) {
    const dot = h('span', { class: 'dot' });
    if (color) dot.style.background = color;
    return h('li', null, h('button', { type: 'button', class: `nav${active ? ' active' : ''}`, 'aria-pressed': String(active), onclick },
      dot, h('span', { class: 'nav-label' }, label), count != null ? h('span', { class: 'count' }, count) : null));
  }

  function renderSidebar() {
    const { keys, orgs } = S.vault; const f = S.filter;
    const set = (k, v) => () => { f[k] = v; render(); };
    $('#nav-orgs').replaceChildren(
      navItem('All keys', keys.length, f.org === 'all', null, set('org', 'all')),
      ...orgs.map(o => navItem(o.name, keys.filter(k => k.orgId === o.id).length, f.org === o.id, o.color, set('org', o.id))),
    );
    $('#nav-types').replaceChildren(
      navItem('All types', null, f.type === 'all', null, set('type', 'all')),
      ...TYPES.map(t => navItem(t, keys.filter(k => k.type === t).length, f.type === t, null, set('type', t))),
    );
    $('#nav-status').replaceChildren(
      navItem('Any status', null, f.status === 'all', null, set('status', 'all')),
      ...Object.entries(STATUSES).map(([k, v]) => navItem(v, keys.filter(x => x.status === k).length, f.status === k,
        { active: 'var(--ok)', rotated: 'var(--warn)', revoked: 'var(--danger)' }[k], set('status', k))),
    );
    const org = f.org !== 'all' ? orgById(f.org) : null;
    $('#keys-title').textContent = org ? org.name : 'All keys';
  }

  function expiryInfo(k) {
    if (!k.expires) return null;
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const days = Math.round((new Date(`${k.expires}T00:00:00`) - today) / 86400000);
    if (days < 0) return { cls: 'bad', text: `Expired ${fmtDate(new Date(`${k.expires}T00:00:00`))}`, days };
    if (days <= 30) return { cls: 'warn', text: days === 0 ? 'Expires today' : `Expires in ${plural(days, 'day')}`, days };
    return { cls: '', text: `Expires ${fmtDate(new Date(`${k.expires}T00:00:00`))}`, days };
  }

  function renderStats() {
    const { keys, orgs, settings } = S.vault;
    const active = keys.filter(k => k.status === 'active').length;
    const soon = keys.filter(k => k.status !== 'revoked' && (expiryInfo(k)?.days ?? 999) <= 30).length;
    const lb = settings.lastBackup;
    const backupStale = !lb || Date.now() - lb > 30 * 86400000;
    const stat = (n, l, cls = '', text = false) => h('div', { class: `stat ${cls}` }, h('div', { class: `n${text ? ' text' : ''}` }, n), h('div', { class: 'l' }, l));
    const backup = h('button', { type: 'button', class: `stat ${backupStale ? 'warn' : 'good'}`, title: 'Download an encrypted backup now', onclick: downloadBackup },
      h('div', { class: 'n text' }, lb ? ago(lb) : 'Never'), h('div', { class: 'l' }, 'Last backup (click to back up)'));
    $('#stats').replaceChildren(
      stat(keys.length, 'Keys stored'),
      stat(active, 'Active', 'good'),
      stat(orgs.length, 'Organisations'),
      stat(soon, 'Expired or due in 30 days', soon ? 'warn' : ''),
      backup,
    );
  }

  function filteredKeys() {
    const f = S.filter; const q = f.q.trim().toLowerCase();
    const rank = { active: 0, rotated: 1, revoked: 2 };
    return S.vault.keys.filter(k =>
      (f.org === 'all' || k.orgId === f.org) &&
      (f.type === 'all' || k.type === f.type) &&
      (f.status === 'all' || k.status === f.status) &&
      (!q || [k.name, k.provider, k.notes, k.env, k.envVar, orgById(k.orgId)?.name].join(' ').toLowerCase().includes(q)),
    ).sort((a, b) => (rank[a.status] - rank[b.status]) || (orgById(a.orgId)?.name || '').localeCompare(orgById(b.orgId)?.name || '') || a.name.localeCompare(b.name));
  }

  // ---------------------------------------------------------------- keys: list
  const maskFor = len => '•'.repeat(Math.max(8, Math.min(len || 12, 28)));

  function renderKeys() {
    const list = $('#key-list');
    if (!S.vault.keys.length) {
      list.replaceChildren(h('div', { class: 'empty' },
        h('h3', null, 'No keys yet'),
        h('p', { class: 'muted' }, 'Add the API keys you use across your organisations. Next time a provider only shows a key once, it goes straight in here.'),
        h('button', { type: 'button', class: 'btn primary', onclick: () => openKeyDialog() }, 'Add your first key')));
      return;
    }
    const items = filteredKeys();
    if (!items.length) {
      list.replaceChildren(h('div', { class: 'empty' },
        h('h3', null, 'Nothing matches'),
        h('button', { type: 'button', class: 'btn ghost', onclick: () => { S.filter = { org: 'all', type: 'all', status: 'all', q: '' }; $('#search').value = ''; render(); } }, 'Clear filters')));
      return;
    }
    list.replaceChildren(...items.map(keyRow));
  }

  function keyRow(k) {
    const org = orgById(k.orgId);
    const exp = expiryInfo(k);
    const rev = S.revealed.get(k.id);
    const statusCls = { active: 'ok', rotated: 'warn', revoked: 'bad' }[k.status];
    const row = h('article', { class: `key${k.status === 'revoked' ? ' revoked' : ''}` },
      h('div', null,
        h('div', { class: 'key-name' }, k.name),
        h('div', { class: 'chips' },
          h('span', { class: 'chip strong' }, org ? org.name : 'Unassigned'),
          h('span', { class: 'chip' }, k.provider),
          h('span', { class: 'chip' }, k.type),
          h('span', { class: 'chip' }, k.env),
          h('span', { class: `chip ${statusCls}` }, STATUSES[k.status]),
          k.envVar ? h('span', { class: 'chip mono', title: 'Environment variable name' }, k.envVar) : null,
          exp ? h('span', { class: `chip ${exp.cls}` }, exp.text) : null),
        k.notes ? h('div', { class: 'notes' }, k.notes) : null,
        h('div', { class: 'meta' }, `Added ${fmtDate(k.created)}`, k.valueChanged ? `  ·  Key changed ${fmtDate(k.valueChanged)}` : k.updated && k.updated !== k.created ? `  ·  Updated ${fmtDate(k.updated)}` : '')),
      h('button', {
        type: 'button', class: `secret${rev ? ' on' : ''}`, title: rev ? 'Click to hide' : 'Click to show for 20 seconds',
        'aria-label': rev ? `Hide ${k.name}` : `Show ${k.name}`, onclick: () => toggleReveal(k),
      }, rev ? rev.value : maskFor(k.length)),
      h('div', { class: 'actions' },
        iconBtn('copy', `Copy ${k.name}`, () => copyKey(k)),
        iconBtn('edit', `Edit ${k.name}`, () => openKeyDialog(k.id)),
        iconBtn('trash', `Delete ${k.name}`, () => deleteKey(k), 'danger')),
    );
    if (org) row.style.setProperty('--org', org.color);
    return row;
  }

  async function fetchSecret(k) {
    return (await api('GET', `/api/keys/${k.id}/secret`)).value;
  }

  async function toggleReveal(k) {
    const cur = S.revealed.get(k.id);
    if (cur) { clearTimeout(cur.timer); S.revealed.delete(k.id); renderKeys(); return; }
    try {
      const value = await fetchSecret(k);
      const timer = setTimeout(() => { S.revealed.delete(k.id); if (S.vault) renderKeys(); }, 20000);
      S.revealed.set(k.id, { value, timer });
      renderKeys();
    } catch (err) { if (err.status) toast(err.message, 'bad'); }
  }

  function wipeSecrets() {
    for (const r of S.revealed.values()) clearTimeout(r.timer);
    S.revealed.clear();
    $('#key-list').replaceChildren();
    $('#f-value').value = '';
  }

  async function writeClipboard(text) {
    try { await navigator.clipboard.writeText(text); return true; } catch {}
    try {
      const ta = h('textarea', { 'aria-hidden': 'true' });
      ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.append(ta); ta.select();
      const ok = document.execCommand('copy'); ta.remove();
      return ok;
    } catch { return false; }
  }

  async function copyKey(k) {
    let value;
    try { value = await fetchSecret(k); } catch (err) { if (err.status) toast(err.message, 'bad'); return; }
    if (!(await writeClipboard(value))) { toast('Copy failed. Show the key and copy it by hand.', 'bad'); return; }
    toast(`Copied ${k.name}. The clipboard clears in 30 seconds.`);
    clearTimeout(S.clipTimer);
    S.clipTimer = setTimeout(() => { navigator.clipboard?.writeText('').catch(() => {}); }, 30000);
  }

  async function deleteKey(k) {
    const go = await confirmBox({ title: 'Delete this key?', body: `"${k.name}" will be removed from the vault. Only a backup can bring it back.`, ok: 'Delete key', danger: true });
    if (!go) return;
    try { await api('DELETE', `/api/keys/${k.id}`); S.revealed.delete(k.id); await reloadVault(); toast('Key deleted.'); }
    catch (err) { if (err.status) toast(err.message, 'bad'); }
  }

  $('#search').addEventListener('input', e => { S.filter.q = e.target.value; renderKeys(); });
  $('#btn-add').addEventListener('click', () => openKeyDialog());
  document.addEventListener('keydown', e => {
    if (e.key === '/' && S.tab === 'keys' && !$('#app').hidden && !document.querySelector('dialog[open]') && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName)) {
      e.preventDefault(); $('#search').focus();
    }
  });

  // ---------------------------------------------------------------- keys: add / edit
  const fillSelect = (sel, items) => sel.replaceChildren(...items.map(([v, l]) => h('option', { value: v }, l)));
  $('#providers').replaceChildren(...Object.keys(PROVIDERS).map(p => h('option', { value: p })));
  fillSelect($('#f-type'), TYPES.map(t => [t, t]));
  fillSelect($('#f-env'), ENVS.map(e => [e, e]));
  fillSelect($('#f-status'), Object.entries(STATUSES));

  let typeTouched = false; let envVarTouched = false;
  function keyError(msg) { const e = $('#key-err'); e.textContent = msg; e.hidden = !msg; }

  function openKeyDialog(id) {
    const k = id ? S.vault.keys.find(x => x.id === id) : null;
    S.editingId = k ? k.id : null;
    $('#key-title').textContent = k ? 'Edit key' : 'Add key';
    fillSelect($('#f-org'), S.vault.orgs.map(o => [o.id, o.name]));
    $('#f-name').value = k?.name || '';
    $('#f-org').value = k?.orgId || (S.filter.org !== 'all' ? S.filter.org : S.vault.orgs[0].id);
    $('#f-provider').value = k?.provider || '';
    $('#f-type').value = k?.type || 'LLM';
    $('#f-env').value = k?.env || 'Production';
    $('#f-status').value = k?.status || 'active';
    $('#f-envvar').value = k?.envVar || '';
    $('#f-expires').value = k?.expires || '';
    $('#f-notes').value = k?.notes || '';
    $('#f-value').value = '';
    $('#f-value').type = 'password';
    $('#f-value-toggle').textContent = 'Show';
    $('#f-value').placeholder = k ? 'Leave blank to keep the current key' : 'Paste the full key';
    $('#f-value-hint').hidden = !k;
    typeTouched = !!k; envVarTouched = !!k?.envVar;
    keyError('');
    openDialog('#dlg-key');
    $('#f-name').focus();
  }

  $('#f-type').addEventListener('change', () => { typeTouched = true; });
  $('#f-envvar').addEventListener('input', () => { envVarTouched = true; });
  $('#f-provider').addEventListener('input', e => {
    const hit = Object.entries(PROVIDERS).find(([name]) => name.toLowerCase() === e.target.value.trim().toLowerCase());
    if (!hit) return;
    if (!typeTouched) $('#f-type').value = hit[1][0];
    if (!envVarTouched && hit[1][1]) $('#f-envvar').value = hit[1][1];
  });
  $('#f-value-toggle').addEventListener('click', () => {
    const i = $('#f-value');
    i.type = i.type === 'password' ? 'text' : 'password';
    $('#f-value-toggle').textContent = i.type === 'password' ? 'Show' : 'Hide';
  });
  $('#dlg-key').addEventListener('close', () => { $('#f-value').value = ''; $('#f-value').type = 'password'; });

  $('#key-form').addEventListener('submit', async e => {
    e.preventDefault();
    keyError('');
    const data = {
      name: $('#f-name').value.trim(), orgId: $('#f-org').value, provider: $('#f-provider').value.trim(),
      type: $('#f-type').value, env: $('#f-env').value, status: $('#f-status').value,
      envVar: $('#f-envvar').value.trim(), expires: $('#f-expires').value, notes: $('#f-notes').value.trim(),
      value: $('#f-value').value.trim(),
    };
    if (!data.name) return keyError('Give the key a name.');
    if (!data.provider) return keyError('Which provider issued this key?');
    if (!S.editingId && !data.value) return keyError('Paste the key itself.');
    if (data.envVar && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(data.envVar)) return keyError('Environment variable names can only use letters, numbers and underscores, and cannot start with a number.');
    const editing = S.editingId;
    const send = body => editing ? api('PUT', `/api/keys/${editing}`, body) : api('POST', '/api/keys', body);
    const btn = $('#key-save'); btn.disabled = true;
    try {
      try { await send(data); }
      catch (err) {
        if (err.data?.code !== 'duplicate') throw err;
        const go = await confirmBox({ title: 'Already saved', body: `${err.message} Save it again anyway?`, ok: 'Save anyway' });
        if (!go) return;
        await send({ ...data, force: true });
      }
      $('#dlg-key').close();
      if (editing) { const r = S.revealed.get(editing); if (r) { clearTimeout(r.timer); S.revealed.delete(editing); } }
      await reloadVault();
      toast(editing ? 'Key updated.' : 'Key saved.');
    } catch (err) {
      if (err.status) keyError(err.message);
    } finally { btn.disabled = false; }
  });

  // ---------------------------------------------------------------- organisations
  $('#btn-orgs').addEventListener('click', () => { renderOrgEditor(); openDialog('#dlg-orgs'); });

  function renderOrgEditor() {
    const { orgs, keys } = S.vault;
    $('#org-edit').replaceChildren(...orgs.map(o => {
      const count = keys.filter(k => k.orgId === o.id).length;
      const color = h('input', { type: 'color', value: o.color, 'aria-label': `Colour for ${o.name}` });
      color.addEventListener('change', () => updateOrg(o, { color: color.value }));
      const name = h('input', { type: 'text', value: o.name, maxlength: '60', 'aria-label': 'Organisation name' });
      name.addEventListener('change', () => {
        const v = name.value.trim();
        if (!v) { name.value = o.name; return; }
        updateOrg(o, { name: v }).catch(() => { name.value = o.name; });
      });
      const del = h('button', {
        type: 'button', class: 'btn ghost sm', disabled: count > 0 || orgs.length === 1,
        title: count ? 'Move or delete its keys first' : orgs.length === 1 ? 'You need at least one organisation' : 'Delete organisation',
        onclick: async () => {
          if (!await confirmBox({ title: 'Delete organisation?', body: `Remove "${o.name}"?`, ok: 'Delete', danger: true })) return;
          try { await api('DELETE', `/api/orgs/${o.id}`); if (S.filter.org === o.id) S.filter.org = 'all'; await reloadVault(); renderOrgEditor(); }
          catch (err) { if (err.status) toast(err.message, 'bad'); }
        },
      }, 'Delete');
      return h('li', { class: 'org-row' }, color, name, h('span', { class: 'count' }, plural(count, 'key')), del);
    }));
  }

  async function updateOrg(o, patch) {
    try { await api('PUT', `/api/orgs/${o.id}`, patch); await reloadVault(); }
    catch (err) { if (err.status) toast(err.message, 'bad'); throw err; }
  }

  $('#org-add').addEventListener('submit', async e => {
    e.preventDefault();
    const name = $('#org-new').value.trim();
    if (!name) return;
    try { await api('POST', '/api/orgs', { name }); $('#org-new').value = ''; await reloadVault(); renderOrgEditor(); }
    catch (err) { if (err.status) toast(err.message, 'bad'); }
  });

  // ---------------------------------------------------------------- settings
  $('#btn-settings').addEventListener('click', () => {
    const st = S.vault.settings;
    $('#s-autolock').value = String(st.autoLockMin);
    $('#s-path').textContent = S.vault.vaultPath;
    $('#s-url').textContent = location.origin;
    $('#s-version').textContent = S.version ? `v${S.version}` : '';
    $('#s-backup-note').textContent = st.lastBackup ? `Last backup downloaded ${ago(st.lastBackup)} (${fmtDate(st.lastBackup)}).` : 'You have not downloaded a backup yet. Do it now: browser data and disks fail.';
    for (const id of ['#s-pw-cur', '#s-pw-new', '#s-pw-new2']) $(id).value = '';
    $('#s-pw-err').hidden = true;
    fillAutostart(); autostartStatus().then(fillAutostart);
    openDialog('#dlg-settings');
  });

  $('#s-autolock').addEventListener('change', async e => {
    try { await api('PUT', '/api/settings', { autoLockMin: Number(e.target.value) }); await reloadVault(); toast('Auto-lock updated.'); }
    catch (err) { if (err.status) toast(err.message, 'bad'); }
  });

  $('#s-signout-others').addEventListener('click', async () => {
    try { await api('POST', '/api/sessions/revoke'); toast('Other browsers are signed out. This one stays signed in.'); }
    catch (err) { if (err.status) toast(err.message, 'bad'); }
  });

  $('#s-stop').addEventListener('click', async () => {
    const go = await confirmBox({
      title: 'Stop KeyVault?',
      body: 'This locks the vault and stops the background process. Your AI tools will not be able to use keys until you double-click KeyVault.exe again.',
      ok: 'Stop KeyVault', danger: true,
    });
    if (!go) return;
    try { await api('POST', '/api/shutdown'); } catch {}
    setTimeout(() => showExpired(true), 400);
  });

  async function downloadBackup() {
    try {
      const res = await api('GET', '/api/backup', undefined, { raw: true });
      download(filenameFrom(res, 'keyvault-backup.json'), await res.blob());
      await reloadVault();
      toast('Encrypted backup downloaded. Keep it somewhere safe, away from this computer.');
      if ($('#dlg-settings').open) $('#s-backup-note').textContent = 'Last backup downloaded today.';
    } catch (err) { if (err.status) toast(err.message, 'bad'); }
  }
  $('#s-backup').addEventListener('click', downloadBackup);
  $('#s-restore').addEventListener('click', () => $('#file-restore').click());
  $('#s-csv').addEventListener('click', async () => {
    try {
      const res = await api('GET', '/api/export.csv', undefined, { raw: true });
      download(filenameFrom(res, 'keyvault-inventory.csv'), await res.blob());
    } catch (err) { if (err.status) toast(err.message, 'bad'); }
  });

  $('#s-pw-form').addEventListener('submit', async e => {
    e.preventDefault();
    const err = $('#s-pw-err'); err.hidden = true;
    const fail = m => { err.textContent = m; err.hidden = false; };
    const cur = $('#s-pw-cur').value; const next = $('#s-pw-new').value;
    if (!cur) return fail('Enter your current password.');
    if (next.length < 10) return fail('Use at least 10 characters for the new password.');
    if (next !== $('#s-pw-new2').value) return fail('The new passwords do not match.');
    try {
      await api('POST', '/api/password', { current: cur, next });
      for (const id of ['#s-pw-cur', '#s-pw-new', '#s-pw-new2']) $(id).value = '';
      toast('Master password changed. Download a fresh backup: older backups still use the old password.');
    } catch (e2) { if (e2.status === 403) fail('Current password is incorrect.'); else if (e2.status) fail(e2.message); }
  });

  $('#s-delete').addEventListener('click', async () => {
    const go = await confirmBox({
      title: 'Delete this vault?',
      body: 'Every key in this vault will be gone from KeyVault. The encrypted file is moved aside, not destroyed, but you will need your old password to ever open it again.',
      ok: 'Delete vault', danger: true, requireText: 'DELETE',
    });
    if (!go) return;
    try { await api('POST', '/api/delete-vault', { confirm: 'DELETE' }); S.state = 'none'; showGate('create', 'Vault deleted. Create a new one, or restore a backup.'); }
    catch (err) { if (err.status) toast(err.message, 'bad'); }
  });

  // ---------------------------------------------------------------- connect AI
  $('#btn-connect').addEventListener('click', async () => {
    openDialog('#dlg-connect');
    const list = $('#connect-list');
    list.replaceChildren(h('p', { class: 'muted' }, 'Loading…'));
    try {
      const { clients } = await api('GET', '/api/connect');
      list.replaceChildren(...clients.map((c, i) => {
        const pre = h('pre', null, c.snippet);
        const copy = h('button', { type: 'button', class: 'btn ghost sm', onclick: async () => { if (await writeClipboard(c.snippet)) toast(`Copied setup for ${c.name}.`); } }, 'Copy');
        return h('details', { class: 'connect-item', open: i === 0 },
          h('summary', null, c.name),
          h('div', { class: 'inner' }, h('p', { class: 'small' }, c.how), h('div', { class: 'snippet' }, copy, pre)));
      }));
    } catch (err) { if (err.status) list.replaceChildren(h('p', { class: 'err' }, err.message)); }
  });

  // ---------------------------------------------------------------- activity
  const ACTIONS = {
    'env-file': 'wrote keys to a .env file', 'run': 'ran a command with keys', 'compose-up': 'started a compose project with keys',
    'container-start': 'started a container', 'container-stop': 'stopped a container', 'container-restart': 'restarted a container',
    'stop-process': 'stopped a process', 'password-changed': 'changed the master password',
  };
  $('#btn-activity').addEventListener('click', async () => {
    await reloadVault().catch(() => {});
    const items = S.vault?.audit || [];
    $('#activity-list').replaceChildren(...(items.length ? items.map(a => h('li', null,
      h('span', { class: 'when' }, fmtDateTime(a.at)),
      h('span', { class: 'what' }, h('strong', null, a.source === 'you' ? 'You' : a.source), ` ${ACTIONS[a.action] || a.action}`,
        a.keys?.length ? `: ${a.keys.join(', ')}` : ''),
      a.target ? h('span', { class: 'target' }, a.target) : null,
    )) : [h('li', null, h('span', { class: 'muted' }, 'Nothing yet. When an AI tool uses a key or changes a service, it shows up here.'))]));
    openDialog('#dlg-activity');
  });

  // ---------------------------------------------------------------- services
  let svcTimer = 0;
  function startServicesTimer() {
    stopServicesTimer();
    // Skip the refresh while an action is running or the pointer is on a button,
    // so the list is never rebuilt under a click.
    svcTimer = setInterval(() => {
      if (document.hidden || (S.tab !== 'apps' && S.tab !== 'services') || document.querySelector('dialog[open]')) return;
      if (S.svcActions > 0 || document.querySelector('#view-services button:hover, #view-services button:active, #view-apps .card:hover, #view-apps button:active')) return;
      loadServices();
    }, 5000);
  }
  function stopServicesTimer() { clearInterval(svcTimer); svcTimer = 0; }

  async function loadServices() {
    if (S.svcBusy) return;
    S.svcBusy = true;
    try {
      S.services = await api('GET', '/api/services');
      renderServices();
    } catch (err) {
      if (err.status) $('#svc-docker').replaceChildren(h('div', { class: 'callout' }, err.message));
    } finally { S.svcBusy = false; }
  }
  $('#svc-refresh').addEventListener('click', () => loadServices());
  $('#apps-refresh').addEventListener('click', () => loadServices());
  $('#svc-system').addEventListener('change', () => renderServices());

  // Runs a Docker action with visible progress: the button shows what is
  // happening and stays disabled until Docker answers, and any container that
  // failed is reported instead of a false "done".
  async function svcAction(label, fn, btn, busyText) {
    S.svcActions = (S.svcActions || 0) + 1;
    const old = btn?.textContent;
    if (btn) { btn.disabled = true; btn.classList.add('busy'); if (busyText) btn.textContent = busyText; }
    try {
      const r = await fn();
      const failed = (r?.results || []).filter(x => !x.ok);
      if (failed.length) toast(`${failed.length} of ${r.results.length} failed. ${failed.map(f => `${f.name}: ${f.error}`).join('; ')}`, 'bad');
      else toast(label);
    } catch (err) {
      if (err.status) toast(err.message, 'bad');
    } finally {
      S.svcActions--;
      if (btn?.isConnected) { btn.disabled = false; btn.classList.remove('busy'); if (busyText) btn.textContent = old; }
    }
    loadServices();
  }

  function containerRow(c) {
    const running = c.state === 'running';
    const portLinks = c.ports.filter(p => p.proto === 'tcp').map(p =>
      h('a', { class: 'chip mono', href: `http://localhost:${p.hostPort}`, target: '_blank', rel: 'noopener noreferrer', title: `Open localhost:${p.hostPort}` }, `:${p.hostPort}`));
    const enc = encodeURIComponent(c.name);
    return h('div', { class: 'row' },
      h('span', { class: `state ${c.state}`, title: c.state }),
      h('div', null, h('div', { class: 'row-title' }, c.service ? `${c.service}` : c.name), h('div', { class: 'row-sub' }, c.service ? c.name : c.image)),
      h('div', { class: 'row-mid' }, h('div', { class: 'row-sub' }, c.status), portLinks.length ? h('div', { class: 'chips' }, portLinks) : null),
      h('div', { class: 'btn-row' },
        running
          ? iconBtn('stop', `Stop ${c.name}`, e => svcAction(`Stopped ${c.name}.`, () => api('POST', `/api/services/containers/${enc}/stop`), e.currentTarget))
          : iconBtn('play', `Start ${c.name}`, e => svcAction(`Started ${c.name}.`, () => api('POST', `/api/services/containers/${enc}/start`), e.currentTarget)),
        iconBtn('restart', `Restart ${c.name}`, e => svcAction(`Restarted ${c.name}.`, () => api('POST', `/api/services/containers/${enc}/restart`), e.currentTarget)),
        iconBtn('logs', `Logs for ${c.name}`, () => openLogs(c.name))),
    );
  }

  function renderDocker() {
    const { docker, containers, composeLinks = {} } = S.services;
    const box = $('#svc-docker');
    if (!docker.available) {
      box.replaceChildren(h('div', { class: 'callout' }, h('strong', null, 'Docker is not available. '), docker.error, ' Start Docker, then press Refresh.'));
      return;
    }
    if (!containers.length) {
      box.replaceChildren(h('div', { class: 'callout' }, `Docker ${docker.version || ''} is running, with no containers yet.`));
      return;
    }
    const groups = new Map();
    for (const c of containers) {
      const k = c.project || '';
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(c);
    }
    const cards = [];
    const ordered = [...groups].sort(([a], [b]) => (a === '') - (b === '') || a.localeCompare(b));
    for (const [project, list] of ordered) {
      const up = list.filter(c => c.state === 'running').length;
      const enc = encodeURIComponent(project);
      const linked = Object.keys(composeLinks[project]?.vars || {}).length;
      const dir = list.find(c => c.workingDir)?.workingDir;
      const head = project
        ? h('div', { class: 'proj-head' },
          h('div', null, h('div', { class: 'proj-name' }, project, h('span', { class: 'count' }, `  ${up} of ${list.length} running`)), dir ? h('div', { class: 'proj-dir' }, dir) : null),
          h('div', { class: 'btn-row' },
            h('button', { type: 'button', class: 'btn primary sm', title: 'docker compose up -d, with this project\'s linked keys', onclick: () => composeUp(project) }, linked ? `Up with ${plural(linked, 'key')}` : 'Up'),
            h('button', { type: 'button', class: 'btn ghost sm', onclick: () => openLinks(project) }, linked ? 'Edit keys' : 'Link keys'),
            h('button', { type: 'button', class: 'btn ghost sm', onclick: e => svcAction(`Restarted ${project}.`, () => api('POST', `/api/services/projects/${enc}/restart`), e.currentTarget, 'Restarting…') }, 'Restart'),
            up
              ? h('button', { type: 'button', class: 'btn ghost sm glow-stop', onclick: e => svcAction(`Stopped ${project}.`, () => api('POST', `/api/services/projects/${enc}/stop`), e.currentTarget, 'Stopping…') }, 'Stop all')
              : h('button', { type: 'button', class: 'btn ghost sm glow-start', onclick: e => svcAction(`Started ${project}.`, () => api('POST', `/api/services/projects/${enc}/start`), e.currentTarget, 'Starting…') }, 'Start all')))
        : h('div', { class: 'proj-head' }, h('div', { class: 'proj-name' }, 'Standalone containers', h('span', { class: 'count' }, `  ${up} of ${list.length} running`)));
      cards.push(h('div', { class: 'proj' }, head, ...list.map(containerRow)));
    }
    box.replaceChildren(...cards);
  }

  function renderPorts() {
    const { listeners, portsError } = S.services;
    const showSystem = $('#svc-system').checked;
    const box = $('#svc-ports');
    const rows = listeners.filter(l => showSystem || !l.system);
    const hidden = listeners.length - rows.length;
    const parts = [];
    if (portsError) parts.push(h('div', { class: 'callout' }, portsError));
    if (!rows.length) parts.push(h('div', { class: 'callout' }, 'Nothing else is listening on this computer right now.'));
    else {
      parts.push(h('div', { class: 'ports-table' }, ...rows.map(l => {
        const p = l.probe;
        const isWeb = p?.http;
        const portEl = isWeb
          ? h('a', { class: 'port-no', href: `http://localhost:${l.port}`, target: '_blank', rel: 'noopener noreferrer', title: `Open localhost:${l.port}` }, l.port)
          : h('span', { class: 'port-no' }, l.port);
        const what = l.container
          ? [h('span', { class: 'chip info' }, `Docker: ${l.container.name}`)]
          : l.pid == null
            ? [h('span', { class: 'row-title' }, l.process || 'Another user\'s program'), h('span', { class: 'row-sub' }, '  not yours, so KeyVault cannot see or stop it')]
            : [h('span', { class: 'row-title' }, l.process || 'Unknown program'), h('span', { class: 'row-sub' }, `  pid ${l.pid}`)];
        const canStop = !l.container && !l.system && !l.dockerProcess && l.pid != null;
        return h('div', { class: 'port-row' },
          portEl,
          h('div', null, ...what,
            h('div', { class: 'chips' },
              l.exposure === 'local'
                ? h('span', { class: 'chip ok', title: l.addresses.join(', ') }, 'This computer only')
                : h('span', { class: 'chip warn', title: `Listening on ${l.addresses.join(', ')}: other devices on your network can reach it` }, 'Open to your network'),
              l.system ? h('span', { class: 'chip' }, 'System') : null)),
          h('div', { class: 'row-sub' }, isWeb ? (p.title ? `${p.title}` : `Web server, HTTP ${p.status}`) : p ? 'Not a web page' : ''),
          h('div', { class: 'btn-row' },
            isWeb ? h('a', { class: 'icon-btn', href: `http://localhost:${l.port}`, target: '_blank', rel: 'noopener noreferrer', title: 'Open in browser', 'aria-label': `Open port ${l.port}` }) : null,
            canStop ? iconBtn('stop', `Stop ${l.process || 'process'} on port ${l.port}`, () => stopPort(l), 'danger') : null));
      })));
    }
    if (hidden && !showSystem) parts.push(h('p', { class: 'muted small' }, `${plural(hidden, 'system service')} hidden.`));
    box.replaceChildren(...parts);
    box.querySelectorAll('a.icon-btn').forEach(a => { a.innerHTML = ICONS.open; });
  }

  function renderServices() {
    if (!S.services) return;
    renderApps();
    renderDocker();
    renderPorts();
    const n = S.services.containers.filter(c => c.state === 'running').length;
    const ports = S.services.listeners.filter(l => !l.system).length;
    $('#svc-sub').textContent = `${S.services.docker.available ? `${n} container${n === 1 ? '' : 's'} running` : 'Docker not available'}  ·  ${plural(ports, 'port')} in use  ·  refreshed ${new Date(S.services.at).toLocaleTimeString('en-GB')}`;
  }

  // ---------------------------------------------------------------- projects
  // The "pick up where you left off" harness. Projects live in the vault; the
  // daemon checks folders and git, and opens folders in Explorer, VS Code,
  // Cursor or a terminal. AI tools reach the same data through MCP.
  const PSTATUS = { active: 'Active', paused: 'Paused', done: 'Done', archived: 'Archived' };
  const OPEN_LABEL = { folder: 'Explorer', vscode: 'VS Code', cursor: 'Cursor', terminal: 'Terminal' };
  const lsGet = k => { try { return localStorage.getItem(k); } catch { return null; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch {} };
  S.projFilter = lsGet('kv-proj-filter') || 'active';
  S.projStatus = {};
  S.projTools = null;
  const projects = () => S.vault?.projects || [];
  const projById = id => projects().find(x => x.id === id);
  const opener = () => lsGet('kv-opener') || 'folder';
  const folderName = p => String(p || '').split(/[\\/]/).filter(Boolean).pop() || p;

  async function projTools() {
    if (!S.projTools) { try { S.projTools = await api('GET', '/api/projects-tools'); } catch { S.projTools = { openers: { folder: true }, picker: false, roots: [] }; } }
    return S.projTools;
  }
  async function loadProjectStatus() {
    try { S.projStatus = (await api('GET', '/api/projects-status')).status || {}; if (S.tab === 'projects') renderProjects(); } catch {}
  }
  function replaceProject(x) {
    const list = S.vault.projects; const i = list.findIndex(q => q.id === x.id);
    if (i >= 0) list[i] = x; else list.push(x);
  }

  function gitLine(st) {
    if (!st) return null;
    if (!st.exists) return h('span', { class: 'chip warn', title: st.error || '' }, 'Folder missing');
    if (!st.git) return h('span', { class: 'muted' }, 'Not a git repo');
    const g = st.git;
    return h('span', { class: 'gitline' },
      h('span', { class: 'chip mono' }, `⎇ ${g.branch}`),
      g.changes ? h('span', { class: 'chip warn' }, `${g.changes} uncommitted`) : h('span', { class: 'chip ok' }, 'clean'),
      g.lastCommit ? h('span', { class: 'muted', title: g.lastCommit.subject }, `last commit ${ago(g.lastCommit.at)}`) : null);
  }

  function projSort(a, b) {
    return (b.pinned - a.pinned) || ((b.lastWorked || 0) - (a.lastWorked || 0)) || ((b.updated || 0) - (a.updated || 0));
  }

  function renderProjects() {
    if (!S.vault) return;
    const all = projects();
    const q = ($('#proj-search').value || '').trim().toLowerCase();
    const counts = { active: 0, paused: 0, done: 0, archived: 0 };
    for (const x of all) counts[x.status] = (counts[x.status] || 0) + 1;
    $('#proj-filters').replaceChildren(...['active', 'paused', 'done', 'archived', 'all'].map(f =>
      h('button', { type: 'button', role: 'tab', class: 'pf', 'aria-selected': String(S.projFilter === f), onclick: () => { S.projFilter = f; lsSet('kv-proj-filter', f); renderProjects(); } },
        f === 'all' ? 'All' : PSTATUS[f], h('span', { class: 'count' }, f === 'all' ? all.length : counts[f]))));
    const list = all
      .filter(x => S.projFilter === 'all' ? x.status !== 'archived' || q : x.status === S.projFilter)
      .filter(x => !q || [x.name, x.summary, x.resume, orgById(x.orgId)?.name, ...(x.folders || []).map(f => f.path)].join(' ').toLowerCase().includes(q))
      .sort(projSort);

    // Continue: the three active projects you touched most recently.
    // Only projects with something to pick up: a note or an open checklist item.
    const recent = all.filter(x => x.status === 'active' && (x.resume || clNext(x)))
      .sort((a, b) => (b.lastWorked || b.updated || 0) - (a.lastWorked || a.updated || 0)).slice(0, 3);
    const cont = $('#proj-continue');
    if (!q && S.projFilter === 'active' && recent.length) {
      cont.replaceChildren(h('h2', { class: 'section-h' }, 'Continue where you left off'),
        h('div', { class: 'proj-continue' }, recent.map(x => {
          const next = clNext(x);
          return h('article', { class: 'pcont', style: null },
            h('div', { class: 'pcont-top' },
              h('span', { class: 'pcont-name' }, x.name),
              h('span', { class: 'muted small' }, x.lastWorked ? ago(x.lastWorked) : '')),
            h('p', { class: 'pcont-resume' }, x.resume || 'No note yet on where you left off.'),
            clBar(x),
            next ? h('p', { class: 'pcont-next' }, h('b', null, next.status === 'in_progress' ? 'Doing: ' : 'Next: '), h('span', { class: 'mono cl-ref' }, clRef(x, next)), ' ', next.title) : null,
            h('div', { class: 'btn-row' },
              h('button', { type: 'button', class: 'btn primary sm', onclick: () => resumeProject(x.id) }, x.folders?.length ? `Resume in ${OPEN_LABEL[opener()]}` : 'Resume'),
              h('button', { type: 'button', class: 'btn ghost sm', onclick: () => openProject(x.id) }, 'Details')));
        })));
    } else cont.replaceChildren();

    const grid = $('#proj-grid');
    if (!all.length) {
      grid.replaceChildren(h('div', { class: 'empty proj-empty' },
        h('p', null, h('strong', null, 'No projects yet.'), ' A project ties together your folders, where you left off and what to do next, so you or your AI can pick it up in one click.'),
        h('div', { class: 'btn-row' },
          h('button', { type: 'button', class: 'btn primary', onclick: newProjectDialog }, 'New project'),
          h('button', { type: 'button', class: 'btn ghost', onclick: importDialog }, 'Find my repos'))));
    } else if (!list.length) {
      grid.replaceChildren(h('div', { class: 'empty' }, q ? `No projects match "${q}".` : `No ${PSTATUS[S.projFilter]?.toLowerCase() || ''} projects.`));
    } else grid.replaceChildren(...list.map(projCard));
    const act = counts.active;
    $('#proj-sub').textContent = `${plural(act, 'active project')}${counts.paused ? `  ·  ${counts.paused} paused` : ''}  ·  pick any of them up where you left off`;
  }

  function projCard(x) {
    const org = orgById(x.orgId);
    const st = S.projStatus[x.id];
    const next = clNext(x);
    const card = h('article', { class: `pcard s-${x.status}`, tabindex: '0', 'aria-label': `${x.name}, ${PSTATUS[x.status]}` },
      h('div', { class: 'pcard-head' },
        h('h3', { class: 'pcard-name' }, x.pinned ? h('span', { class: 'pin', title: 'Pinned' }, '▲ ') : null, x.name),
        h('span', { class: `chip st-${x.status}` }, PSTATUS[x.status])),
      h('div', { class: 'pcard-tags' },
        org ? h('span', { class: 'chip strong' }, h('i', { class: 'dot', dataset: { c: org.color } }), org.name) : null,
        x.folders?.length ? h('span', { class: 'chip mono', title: x.folders.map(f => f.path).join('\n') }, `📁 ${folderName(x.folders[0].path)}${x.folders.length > 1 ? ` +${x.folders.length - 1}` : ''}`) : h('span', { class: 'chip warn' }, 'No folder')),
      x.summary ? h('p', { class: 'pcard-sum' }, x.summary) : null,
      h('div', { class: 'pcard-resume' }, h('span', { class: 'lbl' }, 'Left off'), x.resume ? x.resume : h('span', { class: 'muted' }, 'Nothing noted yet')),
      clBar(x),
      next ? h('div', { class: 'pcard-next' }, h('span', { class: 'lbl' }, next.status === 'in_progress' ? 'Doing' : 'Next'), h('span', { class: 'mono cl-ref' }, clRef(x, next)), ' ', next.title) : null,
      st ? h('div', { class: 'pcard-git' }, gitLine(st)) : null,
      h('div', { class: 'pcard-foot' },
        h('span', { class: 'muted small' }, x.lastWorked ? `Worked on ${ago(x.lastWorked)}` : st?.git?.lastCommit ? `Last commit ${ago(st.git.lastCommit.at)}` : `Added ${ago(x.created)}`),
        h('div', { class: 'btn-row' },
          x.folders?.length ? h('button', { type: 'button', class: 'btn primary sm', onclick: e => { e.stopPropagation(); resumeProject(x.id); } }, 'Resume') : null,
          iconBtn('edit', `Open ${x.name}`, e => { e.stopPropagation(); openProject(x.id); }))));
    card.querySelectorAll('.dot').forEach(d => { d.style.background = d.dataset.c; });
    card.addEventListener('click', e => { if (!e.target.closest('button, a')) openProject(x.id); });
    card.addEventListener('keydown', e => { if (e.key === 'Enter' && e.target === card) openProject(x.id); });
    return card;
  }

  async function openFolderOf(id, how = opener(), folder = 0) {
    try {
      const r = await api('POST', `/api/projects/${id}/open`, { how, folder });
      if (r.opened) toast(`Opened ${folderName(r.dir)} in ${OPEN_LABEL[how]}.`);
      else toast(r.note || 'Could not open the folder.', 'bad');
      const x = projById(id); if (x) x.lastOpened = Date.now();
    } catch (err) { if (err.status) toast(err.message, 'bad'); }
  }
  async function resumeProject(id) {
    const x = projById(id);
    if (x?.folders?.length) await openFolderOf(id);
    openProject(id);
  }

  // ----- new project
  async function newProjectDialog(prefill = {}) {
    const tools = await projTools();
    $('#pn-browse').hidden = !tools.picker;
    $('#pn-name').value = prefill.name || ''; $('#pn-folder').value = prefill.folder || ''; $('#pn-summary').value = '';
    $('#pn-status').value = 'active';
    $('#pn-org').replaceChildren(h('option', { value: '' }, 'None'), ...S.vault.orgs.map(o => h('option', { value: o.id }, o.name)));
    $('#pn-err').hidden = true;
    openDialog('#dlg-proj-new');
    focusIfIdle('#dlg-proj-new', '#pn-name');
  }
  async function pickInto(input) {
    try {
      toast('Choose the folder in the window that just opened.');
      const r = await api('POST', '/api/pick-folder', { start: input.value || '' });
      if (r.path) { input.value = r.path; input.dispatchEvent(new Event('input')); }
    } catch (err) { if (err.status) toast(err.message, 'bad'); }
  }
  $('#pn-browse').addEventListener('click', async () => {
    await pickInto($('#pn-folder'));
    if (!$('#pn-name').value.trim() && $('#pn-folder').value) $('#pn-name').value = folderName($('#pn-folder').value);
  });
  $('#pn-form').addEventListener('submit', async e => {
    e.preventDefault();
    const err = $('#pn-err'); err.hidden = true;
    const name = $('#pn-name').value.trim() || folderName($('#pn-folder').value.trim());
    if (!name) { err.textContent = 'Give the project a name.'; err.hidden = false; return; }
    const folder = $('#pn-folder').value.trim();
    try {
      const { project } = await api('POST', '/api/projects', {
        name, summary: $('#pn-summary').value, status: $('#pn-status').value, orgId: $('#pn-org').value || null,
        folders: folder ? [{ path: folder }] : [],
      });
      replaceProject(project);
      $('#dlg-proj-new').close();
      if ($('#pn-status').value !== S.projFilter && S.projFilter !== 'all') { S.projFilter = project.status; }
      renderProjects(); loadProjectStatus();
      toast(`Created ${project.name}.`);
      openProject(project.id);
    } catch (e2) { if (e2.status) { err.textContent = e2.message; err.hidden = false; } }
  });
  $('#proj-new').addEventListener('click', () => newProjectDialog());
  $('#proj-search').addEventListener('input', renderProjects);

  // ----- project panel
  let saveTimer = 0;
  function savedNote(text = 'Saved') { const el = $('#pd-saved'); el.textContent = text; clearTimeout(saveTimer); saveTimer = setTimeout(() => { el.textContent = ''; }, 2200); }
  async function patch(id, body, quiet) {
    try {
      const { project } = await api('PUT', `/api/projects/${id}`, body);
      replaceProject(project);
      if (!quiet) savedNote();
      if (S.openProject === id) fillProject(project, true);
      renderProjects();
      return project;
    } catch (err) { if (err.status) toast(err.message, 'bad'); fillProject(projById(id), true); return null; }
  }

  async function openProject(id) {
    const x = projById(id); if (!x) return;
    S.openProject = id;
    await projTools();
    $('#pd-browse').hidden = !S.projTools.picker;
    fillProject(x);
    openDialog('#dlg-project');
    loadFolderStatus(id);
  }

  function fillProject(x, keepFocus) {
    if (!x) return;
    const active = document.activeElement;
    const set = (sel, v) => { const el = $(sel); if (!keepFocus || el !== active) el.value = v; };
    set('#pd-name', x.name);
    $('#pd-status').value = x.status;
    $('#pd-org').replaceChildren(h('option', { value: '' }, 'None'), ...S.vault.orgs.map(o => h('option', { value: o.id }, o.name)));
    $('#pd-org').value = x.orgId || '';
    $('#pd-pin').checked = !!x.pinned;
    set('#pd-resume', x.resume || '');
    set('#pd-summary', x.summary || '');
    $('#pd-archive').textContent = x.status === 'archived' ? 'Unarchive' : 'Archive';
    $('#pd-ai-say').textContent = `Resume ${x.name} from KeyVault`;
    // checklist
    if (!keepFocus) { S.cl = { q: '', phase: '', status: '', notes: new Set(), collapsed: new Set(), addSub: '' }; $('#pd-cl-search').value = ''; showProjTab((x.items || []).length ? 'checklist' : (lsGet('kv-pd-tab') || 'checklist')); }
    if (!keepFocus || document.activeElement !== $('#pd-key')) $('#pd-key').value = x.key || '';
    renderChecklist(x);
    // folders
    renderFolders(x);
    // links
    $('#pd-links').replaceChildren(...(x.links || []).map((l, i) => h('li', null,
      h('a', { href: l.url, target: '_blank', rel: 'noopener noreferrer' }, l.label || l.url), l.label ? h('span', { class: 'muted small mono' }, l.url) : null,
      iconBtn('trash', 'Remove link', () => patch(x.id, { links: x.links.filter((_, j) => j !== i) }), 'danger'))));
    // keys
    const keys = S.vault.keys.filter(k => k.status !== 'revoked');
    $('#pd-keys').replaceChildren(...(keys.length ? keys.map(k => {
      const cb = h('input', { type: 'checkbox' }); cb.checked = (x.keyIds || []).includes(k.id);
      cb.addEventListener('change', () => patch(x.id, { keyIds: cb.checked ? [...(x.keyIds || []), k.id] : (x.keyIds || []).filter(id => id !== k.id) }));
      return h('label', { class: 'check kchk' }, cb, h('span', null, k.name, h('span', { class: 'muted' }, k.envVar ? `  ${k.envVar}` : '')));
    }) : [h('p', { class: 'muted small' }, 'No keys in the vault yet.')]));
    // log
    $('#pd-log').replaceChildren(...(x.log || []).slice(0, 60).map(e => h('li', null,
      h('span', { class: 'when mono', title: fmtDateTime(e.at) }, ago(e.at)),
      h('span', { class: `who ${e.source === 'you' ? '' : 'ai'}` }, e.source === 'you' ? 'You' : e.source || 'AI'),
      h('span', { class: 'what' }, e.text))));
  }

  function renderFolders(x, statuses) {
    const tools = S.projTools || { openers: { folder: true } };
    statuses = statuses || S.projFolderStatus?.[x.id] || [];
    $('#pd-folders').replaceChildren(...(x.folders || []).map((f, i) => {
      const st = statuses[i];
      const openBtns = ['folder', 'vscode', 'cursor', 'terminal'].filter(k => tools.openers?.[k]).map(k =>
        h('button', { type: 'button', class: `btn ${k === opener() ? 'primary' : 'ghost'} sm`, title: `Open in ${OPEN_LABEL[k]}${k === opener() ? ' (your default for Resume)' : ''}`,
          onclick: () => { lsSet('kv-opener', k); openFolderOf(x.id, k, i); renderFolders(x); renderProjects(); } }, OPEN_LABEL[k]));
      return h('li', { class: 'pf-item' },
        h('div', { class: 'pf-path mono' }, f.path),
        h('div', { class: 'pf-git' }, st ? gitLine(st) : h('span', { class: 'muted small' }, 'Checking…'),
          st?.git?.lastCommit ? h('span', { class: 'muted small pf-commit' }, `“${st.git.lastCommit.subject}”`) : null,
          st?.git?.remote ? h('a', { class: 'small', href: st.git.remote, target: '_blank', rel: 'noopener noreferrer' }, 'repo') : null),
        h('div', { class: 'btn-row' }, openBtns,
          iconBtn('trash', `Unlink ${f.path} (the folder itself is not touched)`, () => patch(x.id, { folders: x.folders.filter((_, j) => j !== i) }), 'danger')));
    }));
    if (!(x.folders || []).length) $('#pd-folders').append(h('li', { class: 'muted small' }, 'No folder linked yet. Add the folder where this project lives.'));
  }

  async function loadFolderStatus(id) {
    try {
      const { folders } = await api('GET', `/api/projects/${id}/status`);
      S.projFolderStatus = { ...(S.projFolderStatus || {}), [id]: folders };
      if (S.openProject === id) renderFolders(projById(id), folders);
    } catch {}
  }

  const cur = () => projById(S.openProject);

  // ----- checklist (phases of items, like a build checklist; your AI tools fill it in too)
  const CL_STATUS = { todo: 'To do', in_progress: 'In progress', done: 'Done', blocked: 'Blocked', superseded: 'Superseded' };
  S.cl = { q: '', phase: '', status: '', notes: new Set(), collapsed: new Set(), addSub: '' };
  function clStats(x) {
    const s = { total: 0, todo: 0, in_progress: 0, done: 0, blocked: 0, superseded: 0 };
    for (const i of x.items || []) { s.total++; s[i.status] = (s[i.status] || 0) + 1; }
    s.counted = s.total - s.superseded;
    return s;
  }
  function clRef(x, it) { return `${x.key ? `${x.key}-` : ''}${it.ref}`; }
  // What to do next: anything in progress first, then the first item still to do.
  // Subtasks come straight after their parent; a parent with open subtasks waits for them.
  function clOrder(x) {
    const items = x.items || []; const out = [];
    for (const p of x.phases || []) for (const it of items) {
      if (it.phaseId !== p.id || it.parentId) continue;
      out.push(it);
      for (const c of items) if (c.parentId === it.id) out.push(c);
    }
    return out;
  }
  function clNext(x) {
    const items = clOrder(x);
    const busy = i => !i.parentId && (x.items || []).some(c => c.parentId === i.id && ['todo', 'in_progress', 'blocked'].includes(c.status));
    return items.find(i => i.status === 'in_progress' && !busy(i)) || items.find(i => i.status === 'todo' && !busy(i)) || null;
  }
  function clBar(x) {
    const s = clStats(x);
    if (!s.total) return null;
    const pct = s.counted ? Math.round((s.done / s.counted) * 100) : 0;
    const bar = h('i'); bar.style.width = `${pct}%`;
    return h('div', { class: 'cl-mini', title: `${s.done} of ${s.counted} done${s.blocked ? `, ${s.blocked} blocked` : ''}` },
      h('div', { class: 'cl-bar' }, bar), h('span', { class: 'mono small' }, `${s.done}/${s.counted}`));
  }

  function showProjTab(tab) {
    for (const t of ['checklist', 'overview']) {
      $(`#pd-tab-${t}`).setAttribute('aria-selected', String(t === tab));
      $(`#pd-pane-${t}`).hidden = t !== tab;
    }
    lsSet('kv-pd-tab', tab);
  }
  for (const t of ['checklist', 'overview']) $(`#pd-tab-${t}`).addEventListener('click', () => showProjTab(t));

  async function clOp(body, quiet) {
    const id = S.openProject;
    try {
      const { project } = await api('POST', `/api/projects/${id}/checklist`, body);
      replaceProject(project);
      if (!quiet) savedNote();
      if (S.openProject === id) renderChecklist(project);
      renderProjects();
      return project;
    } catch (err) { if (err.status) toast(err.message, 'bad'); const x = projById(id); if (x) renderChecklist(x); return null; }
  }
  const clUpdate = (it, change) => clOp({ op: 'update-items', updates: [{ item: it.id, ...change }] });

  function renderChecklist(x) {
    // Keep the cursor where it was: the list is rebuilt after every change.
    const act = document.activeElement;
    const keep = act?.dataset?.f ? { f: act.dataset.f, v: act.value, a: act.selectionStart, b: act.selectionEnd } : null;

    const s = clStats(x);
    const pct = s.counted ? (s.done / s.counted) * 100 : 0;
    $('#pd-cl-done').textContent = s.done;
    $('#pd-cl-total').textContent = s.counted;
    $('#pd-cl-bar').style.width = `${pct}%`;
    $('#pd-cl-tabcount').textContent = s.total ? `${s.done}/${s.counted}` : '';

    const tiles = [['', 'Total', s.total], ['done', 'Done', s.done], ['in_progress', 'In progress', s.in_progress], ['blocked', 'Blocked', s.blocked], ['todo', 'To do', s.todo], ['superseded', 'Superseded', s.superseded]];
    $('#pd-cl-stats').replaceChildren(...tiles.map(([k, label, n]) => h('button', {
      type: 'button', class: `cl-stat st-${k || 'total'}`, 'aria-pressed': String(S.cl.status === k),
      title: k ? `Show only ${label.toLowerCase()}` : 'Show every status',
      onclick: () => { S.cl.status = S.cl.status === k ? '' : k; renderChecklist(cur()); },
    }, h('span', { class: 'lbl' }, label), h('b', null, n))));

    const phases = x.phases || [];
    if (S.cl.phase && !phases.some(p => p.id === S.cl.phase)) S.cl.phase = '';
    $('#pd-cl-phases').replaceChildren(
      h('button', { type: 'button', class: 'cl-chip', 'aria-pressed': String(!S.cl.phase), onclick: () => { S.cl.phase = ''; renderChecklist(cur()); } }, 'All phases'),
      ...phases.map(p => {
        const items = x.items.filter(i => i.phaseId === p.id);
        const d = items.filter(i => i.status === 'done').length; const c = items.filter(i => i.status !== 'superseded').length;
        return h('button', { type: 'button', class: `cl-chip${c && d === c ? ' complete' : ''}`, 'aria-pressed': String(S.cl.phase === p.id), title: p.name,
          onclick: () => { S.cl.phase = S.cl.phase === p.id ? '' : p.id; renderChecklist(cur()); } },
        h('span', { class: 'mono' }, p.code), h('span', { class: 'count' }, `${d}/${c}`));
      }));

    const q = S.cl.q.toLowerCase();
    const filtering = !!(q || S.cl.status);
    const match = it => (!S.cl.status || it.status === S.cl.status)
      && (!q || [clRef(x, it), it.title, it.owner, it.notes].join(' ').toLowerCase().includes(q));
    const list = $('#pd-cl-list');
    if (!phases.length) {
      list.replaceChildren(h('div', { class: 'cl-empty' },
        h('p', null, h('strong', null, 'No checklist yet.'), ' Break the project into phases, each with concrete items. Your AI can write it for you: in Claude, Codex or Cursor say'),
        h('pre', { class: 'code' }, `Write a build checklist for ${x.name} in KeyVault`),
        h('p', { class: 'muted small' }, 'Or add a phase below, or paste a list you already have.')));
    } else {
      const groups = phases.filter(p => !S.cl.phase || p.id === S.cl.phase).map((p, pi, arr) => {
        const all = x.items.filter(i => i.phaseId === p.id);
        const kidsOf = t => all.filter(c => c.parentId === t.id);
        const tops = all.filter(i => !i.parentId);
        const shown = tops.filter(t => match(t) || kidsOf(t).some(match));
        if (filtering && !shown.length) return null;
        const d = all.filter(i => i.status === 'done').length; const c = all.filter(i => i.status !== 'superseded').length;
        const gi = phases.indexOf(p);
        const name = h('input', { type: 'text', class: 'cl-phase-name', value: p.name, maxlength: '80', 'aria-label': `Phase name (${p.code})`, spellcheck: 'false', dataset: { f: `ph:${p.id}` } });
        name.addEventListener('change', () => { const v = name.value.trim(); if (v && v !== p.name) clOp({ op: 'rename-phase', phase: p.id, name: v }); else name.value = p.name; });
        name.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); name.blur(); } });
        const bar = h('i'); bar.style.width = `${c ? (d / c) * 100 : 0}%`;
        const head = h('div', { class: 'cl-phase-head' },
          h('span', { class: 'cl-code mono' }, p.code), name,
          h('span', { class: 'count' }, `${d}/${c} done`),
          h('div', { class: 'cl-bar sm' }, bar),
          h('div', { class: 'cl-tools' },
            gi > 0 ? iconBtn('up', 'Move phase up', () => clOp({ op: 'move-phase', phase: p.id, dir: -1 })) : h('span', { class: 'cl-gap' }),
            gi < phases.length - 1 ? iconBtn('down', 'Move phase down', () => clOp({ op: 'move-phase', phase: p.id, dir: 1 })) : h('span', { class: 'cl-gap' }),
            iconBtn('trash', all.length ? 'Delete this phase (remove its items first)' : 'Delete phase', () => {
              if (all.length) { toast('Move or delete this phase\'s items first.', 'bad'); return; }
              clOp({ op: 'delete-phase', phase: p.id });
            }, 'danger')));
        const rows = [];
        shown.forEach((t, k) => {
          const kids = kidsOf(t);
          const folded = !filtering && S.cl.collapsed.has(t.id);
          rows.push(clRow(x, t, shown, k, { kids, folded, dim: filtering && !match(t) }));
          if (folded) return;
          const subs = filtering ? kids.filter(match) : kids;
          subs.forEach((c, j) => rows.push(clRow(x, c, subs, j, { sub: true })));
          if (!filtering && S.cl.addSub === t.id) rows.push(clSubAdd(x, t));
        });
        let add = null;
        if (!filtering) {
          const inp = h('input', { type: 'text', maxlength: '300', placeholder: `Add an item to ${p.code}`, 'aria-label': `Add an item to ${p.name}`, dataset: { f: `add:${p.id}` } });
          add = h('form', { class: 'cl-item-add', novalidate: '' }, h('span', { class: 'plus' }, '+'), inp);
          add.addEventListener('submit', async e => {
            e.preventDefault();
            const t = inp.value.trim(); if (!t) return;
            inp.value = '';
            await clOp({ op: 'add-items', items: [{ phase: p.id, title: t }] });
          });
        }
        void arr; void pi;
        return h('section', { class: 'cl-phase' }, head, h('ul', { class: 'cl-items' }, rows), add);
      }).filter(Boolean);
      list.replaceChildren(...(groups.length ? groups : [h('p', { class: 'muted cl-none' }, 'Nothing matches. Clear the search or the filters.')]));
    }

    if (keep) {
      const el = list.querySelector(`[data-f="${CSS.escape(keep.f)}"]`);
      if (el) {
        // A save that lands while you type must not wipe what you are typing.
        if (keep.v != null && el.value !== keep.v && el.tagName !== 'SELECT') el.value = keep.v;
        el.focus(); try { if (keep.a != null) el.setSelectionRange(keep.a, keep.b); } catch {}
      }
    }
  }

  function clSubAdd(x, t) {
    const inp = h('input', { type: 'text', maxlength: '300', placeholder: `Add a subtask to ${clRef(x, t)}`, 'aria-label': `Add a subtask to ${t.title}`, dataset: { f: `sub:${t.id}` } });
    const close = () => { S.cl.addSub = ''; renderChecklist(cur()); };
    inp.addEventListener('keydown', e => { if (e.key === 'Escape') { e.preventDefault(); close(); } });
    const form = h('form', { class: 'cl-item-add', novalidate: '' }, h('span', { class: 'plus' }, '+ sub'), inp,
      iconBtn('close', 'Stop adding subtasks', close));
    form.addEventListener('submit', async e => {
      e.preventDefault();
      const v = inp.value.trim(); if (!v) return;
      inp.value = '';
      await clOp({ op: 'add-items', items: [{ parent: t.id, title: v }] }, true);
    });
    return h('li', { class: 'cl-sub-add' }, form);
  }
  function openSubAdd(it) {
    S.cl.addSub = it.id; S.cl.collapsed.delete(it.id);
    renderChecklist(cur());
    $(`#pd-cl-list [data-f="sub:${it.id}"]`)?.focus();
  }

  function clRow(x, it, shown, k, opt = {}) {
    const kids = opt.kids || [];
    const title = h('input', { type: 'text', class: 'cl-title', value: it.title, maxlength: '300', 'aria-label': `${clRef(x, it)} title`, dataset: { f: `t:${it.id}` } });
    title.addEventListener('change', () => { const v = title.value.trim(); if (v && v !== it.title) clUpdate(it, { title: v }); else title.value = it.title; });
    title.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); title.blur(); } });
    const owner = h('input', { type: 'text', class: 'cl-owner mono', value: it.owner || '', maxlength: '40', placeholder: 'owner', list: 'cl-owners', 'aria-label': `${clRef(x, it)} owner`, dataset: { f: `o:${it.id}` } });
    owner.addEventListener('change', () => { if (owner.value.trim() !== (it.owner || '')) clUpdate(it, { owner: owner.value.trim() }); });
    owner.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); owner.blur(); } });
    const status = h('select', { class: `cl-status st-${it.status}`, 'aria-label': `${clRef(x, it)} status`, dataset: { f: `s:${it.id}` } },
      Object.entries(CL_STATUS).map(([v, l]) => h('option', { value: v }, l)));
    status.value = it.status;
    status.addEventListener('change', () => clUpdate(it, { status: status.value }));
    const open = S.cl.notes.has(it.id);
    const noteBtn = iconBtn('note', it.notes ? 'Edit notes' : 'Add notes', () => {
      if (S.cl.notes.has(it.id)) S.cl.notes.delete(it.id); else S.cl.notes.add(it.id);
      renderChecklist(cur());
      if (S.cl.notes.has(it.id)) $(`#pd-cl-list [data-f="n:${it.id}"]`)?.focus();
    }, it.notes ? 'has-note' : '');
    let notes = null;
    if (open) {
      notes = h('textarea', { class: 'cl-notes-edit', rows: '2', maxlength: '2000', placeholder: 'Notes: links, why it is blocked, what was decided', 'aria-label': `${clRef(x, it)} notes`, dataset: { f: `n:${it.id}` } });
      notes.value = it.notes || '';
      notes.addEventListener('change', () => { if (notes.value !== (it.notes || '')) clUpdate(it, { notes: notes.value }); });
    } else if (it.notes) notes = h('p', { class: 'cl-notes' }, it.notes);
    const by = it.by && it.by !== 'you' ? h('span', { class: 'cl-by', title: fmtDateTime(it.updated) }, `${it.by} · ${ago(it.updated)}`) : null;
    const live = kids.filter(c => c.status !== 'superseded');
    const kd = live.filter(c => c.status === 'done').length;
    const subInfo = kids.length ? h('button', { type: 'button', class: `cl-subcount mono${live.length && kd === live.length ? ' complete' : ''}`,
      title: opt.folded ? 'Show subtasks' : 'Hide subtasks', 'aria-expanded': String(!opt.folded),
      onclick: () => { if (S.cl.collapsed.has(it.id)) S.cl.collapsed.delete(it.id); else S.cl.collapsed.add(it.id); renderChecklist(cur()); } },
    h('span', { class: 'caret', 'aria-hidden': 'true' }, opt.folded ? '▸' : '▾'), `${kd}/${live.length} subtask${live.length === 1 ? '' : 's'}`) : null;
    const filtered = !!(S.cl.q || S.cl.status);
    return h('li', { class: `cl-item st-${it.status}${opt.sub ? ' sub' : ''}${kids.length ? ' has-kids' : ''}${opt.dim ? ' dim' : ''}` },
      h('span', { class: 'cl-ref mono', title: `${clRef(x, it)} · added ${fmtDateTime(it.created)}` }, opt.sub ? h('span', { class: 'branch', 'aria-hidden': 'true' }, '└') : null, opt.sub ? it.ref.replace(/^[A-Z0-9]+-/, '') : clRef(x, it)),
      h('div', { class: 'cl-main' }, title, subInfo, notes, by),
      owner, status,
      h('div', { class: 'cl-tools' }, noteBtn,
        !opt.sub && !filtered ? iconBtn('sub', `Add a subtask to ${clRef(x, it)}`, () => openSubAdd(it)) : h('span', { class: 'cl-gap' }),
        k > 0 && !filtered ? iconBtn('up', 'Move up', () => clOp({ op: 'move-item', item: it.id, dir: -1 }, true)) : h('span', { class: 'cl-gap' }),
        k < shown.length - 1 && !filtered ? iconBtn('down', 'Move down', () => clOp({ op: 'move-item', item: it.id, dir: 1 }, true)) : h('span', { class: 'cl-gap' }),
        iconBtn('trash', `Delete ${clRef(x, it)}`, async () => {
          const extra = kids.length ? ` Its ${kids.length === 1 ? 'subtask is' : `${kids.length} subtasks are`} deleted too.` : '';
          const go = await confirmBox({ title: `Delete ${clRef(x, it)}?`, body: `"${it.title}" is removed from the checklist.${extra} To keep it on record, set it to Superseded instead.`, ok: 'Delete item', danger: true });
          if (go) clOp({ op: 'delete-item', item: it.id });
        }, 'danger')));
  }

  let clSearchT = 0;
  $('#pd-cl-search').addEventListener('input', e => { clearTimeout(clSearchT); clSearchT = setTimeout(() => { S.cl.q = e.target.value.trim(); renderChecklist(cur()); }, 120); });
  $('#pd-key').addEventListener('change', e => {
    const v = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
    if (v && v !== cur()?.key) patch(S.openProject, { key: v }); else e.target.value = cur()?.key || '';
  });
  $('#pd-cl-phase-add').addEventListener('submit', async e => {
    e.preventDefault();
    const name = $('#pd-cl-phase-name').value.trim(); if (!name) { $('#pd-cl-phase-name').focus(); return; }
    if (await clOp({ op: 'add-phase', name, code: $('#pd-cl-phase-code').value.trim() })) {
      $('#pd-cl-phase-name').value = ''; $('#pd-cl-phase-code').value = '';
      const x = cur(); const ph = x.phases[x.phases.length - 1];
      $(`#pd-cl-list [data-f="add:${ph?.id}"]`)?.focus();
    }
  });
  const pasteToggle = show => { $('#pd-cl-paste').hidden = !show; $('#pd-cl-paste-btn').setAttribute('aria-expanded', String(show)); if (show) $('#pd-cl-paste-text').focus(); };
  $('#pd-cl-paste-btn').addEventListener('click', () => pasteToggle($('#pd-cl-paste').hidden));
  $('#pd-cl-paste-cancel').addEventListener('click', () => pasteToggle(false));
  // Turns a pasted list (markdown checklists, bullet lists, plain lines) into phases and items.
  function parseChecklistText(text) {
    const phases = []; const items = []; let phase = ''; let lastTop = null;
    for (let line of text.split(/\r?\n/)) {
      const indent = /^[ \t]*/.exec(line)[0].replace(/\t/g, '    ').length;
      line = line.trim(); if (!line) continue;
      if (/^#+\s*/.test(line) || (/:$/.test(line) && !/^[-*•]|^\[/.test(line))) {
        phase = line.replace(/^#+\s*/, '').replace(/:$/, '').trim();
        if (phase && !phases.includes(phase)) phases.push(phase);
        lastTop = null;
        continue;
      }
      line = line.replace(/^([-*•]|\d+[.)])\s+/, '');
      let status = 'todo';
      const m = /^\[([ xX~\-!/])\]\s*/.exec(line);
      if (m) { status = { x: 'done', X: 'done', '~': 'superseded', '-': 'superseded', '!': 'blocked', '/': 'in_progress' }[m[1]] || 'todo'; line = line.slice(m[0].length); }
      if (!line) continue;
      if (!phase) { phase = 'General'; phases.push(phase); }
      if (indent >= 2 && lastTop) { (lastTop.subtasks ||= []).push({ title: line.slice(0, 300), status }); continue; }
      lastTop = { phase, title: line.slice(0, 300), status };
      items.push(lastTop);
    }
    return { phases, items };
  }
  $('#pd-cl-paste').addEventListener('submit', async e => {
    e.preventDefault();
    const { phases, items } = parseChecklistText($('#pd-cl-paste-text').value);
    if (!items.length) { toast('Nothing to add. Put one item per line.', 'bad'); return; }
    if (await clOp({ op: 'add-items', phases, items })) {
      $('#pd-cl-paste-text').value = ''; pasteToggle(false);
      const subs = items.reduce((n, i) => n + (i.subtasks?.length || 0), 0);
      toast(`Added ${plural(items.length, 'item')}${subs ? ` and ${plural(subs, 'subtask')}` : ''}${phases.length ? ` in ${plural(phases.length, 'phase')}` : ''}.`);
    }
  });
  $('#pd-name').addEventListener('change', e => { const v = e.target.value.trim(); if (v && v !== cur()?.name) patch(S.openProject, { name: v }); else e.target.value = cur()?.name || ''; });
  $('#pd-name').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); } });
  $('#pd-status').addEventListener('change', e => patch(S.openProject, { status: e.target.value }));
  $('#pd-org').addEventListener('change', e => patch(S.openProject, { orgId: e.target.value || null }));
  $('#pd-pin').addEventListener('change', e => patch(S.openProject, { pinned: e.target.checked }));
  for (const [sel, field] of [['#pd-resume', 'resume'], ['#pd-summary', 'summary']]) {
    let t = 0;
    $(sel).addEventListener('input', () => { $('#pd-saved').textContent = 'Typing…'; clearTimeout(t); t = setTimeout(() => patch(S.openProject, { [field]: $(sel).value }), 900); });
    $(sel).addEventListener('change', () => { clearTimeout(t); if ($(sel).value !== (cur()?.[field] || '')) patch(S.openProject, { [field]: $(sel).value }); });
  }
  $('#pd-log-add').addEventListener('submit', async e => {
    e.preventDefault();
    const t = $('#pd-log-new').value.trim(); if (!t) return;
    try {
      const { project } = await api('POST', `/api/projects/${S.openProject}/log`, { text: t });
      replaceProject(project); fillProject(project, true); renderProjects();
      $('#pd-log-new').value = ''; savedNote('Logged');
    } catch (err) { if (err.status) toast(err.message, 'bad'); }
  });
  $('#pd-browse').addEventListener('click', () => pickInto($('#pd-folder-new')));
  $('#pd-folder-add').addEventListener('submit', async e => {
    e.preventDefault();
    const p = $('#pd-folder-new').value.trim(); if (!p) return;
    const chk = await api('POST', '/api/check-folder', { path: p }).catch(() => null);
    if (chk && !chk.exists) { toast(chk.error || 'That folder was not found.', 'bad'); return; }
    if (await patch(S.openProject, { folders: [...(cur().folders || []), { path: chk?.path || p }] })) { $('#pd-folder-new').value = ''; loadFolderStatus(S.openProject); loadProjectStatus(); }
  });
  $('#pd-link-add').addEventListener('submit', async e => {
    e.preventDefault();
    let url = $('#pd-link-url').value.trim(); if (!url) return;
    if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
    if (await patch(S.openProject, { links: [...(cur().links || []), { url, label: $('#pd-link-label').value.trim() }] })) { $('#pd-link-url').value = ''; $('#pd-link-label').value = ''; }
  });
  $('#pd-brief').addEventListener('click', async () => {
    try {
      const { brief } = await api('GET', `/api/projects/${S.openProject}/brief`);
      if (await writeClipboard(brief)) toast('Brief copied. Paste it into any AI chat to pick the project up.');
      else toast('Could not copy. Your browser blocked the clipboard.', 'bad');
    } catch (err) { if (err.status) toast(err.message, 'bad'); }
  });
  $('#pd-archive').addEventListener('click', () => { const x = cur(); patch(x.id, { status: x.status === 'archived' ? 'active' : 'archived' }); });
  $('#pd-duplicate').addEventListener('click', async () => {
    try {
      const { project } = await api('POST', `/api/projects/${S.openProject}/duplicate`, {});
      replaceProject(project); renderProjects(); toast(`Created ${project.name}.`); openProject(project.id);
    } catch (err) { if (err.status) toast(err.message, 'bad'); }
  });
  $('#pd-delete').addEventListener('click', async () => {
    const x = cur();
    const go = await confirmBox({
      title: `Delete ${x.name}?`,
      body: 'This removes the project, its notes, checklist and activity log from KeyVault. Your folders and files are not touched. If you might come back to it, archive it instead.',
      ok: 'Delete project', danger: true, requireText: 'DELETE',
    });
    if (!go) { openDialog('#dlg-project'); return; }
    try {
      await api('DELETE', `/api/projects/${x.id}`);
      S.vault.projects = S.vault.projects.filter(q => q.id !== x.id);
      S.openProject = null; renderProjects(); toast(`Deleted ${x.name}. Its folders are untouched.`);
    } catch (err) { if (err.status) toast(err.message, 'bad'); }
  });
  $('#dlg-project').addEventListener('close', () => { S.openProject = null; loadProjectStatus(); });

  // ----- find my repos
  async function importDialog(extraRoot) {
    const tools = await projTools();
    $('#pi-browse').hidden = !tools.picker;
    $('#pi-list').replaceChildren(h('li', { class: 'muted' }, 'Looking for git repos…'));
    $('#pi-all').checked = false;
    if (!$('#dlg-proj-import').open) openDialog('#dlg-proj-import');
    try {
      const roots = [...(tools.roots || []), ...(extraRoot ? [extraRoot] : [])];
      const r = await api('POST', '/api/projects-scan', { roots });
      $('#pi-roots').textContent = r.roots.length ? `Looked in: ${r.roots.join('  ·  ')}` : 'No usual code folders found. Add a folder to look in below.';
      const fresh = r.repos.filter(x => !x.tracked);
      $('#pi-count').textContent = `${plural(r.repos.length, 'repo')} found${r.repos.length - fresh.length ? `, ${r.repos.length - fresh.length} already projects` : ''}`;
      $('#pi-list').replaceChildren(...(r.repos.length ? r.repos.map(x => {
        const cb = h('input', { type: 'checkbox', value: x.path, disabled: x.tracked });
        return h('li', { class: x.tracked ? 'tracked' : '' }, h('label', { class: 'check' }, cb,
          h('span', null, h('b', null, x.name), h('span', { class: 'muted small mono' }, `  ${x.path}`)),
          x.tracked ? h('span', { class: 'chip ok' }, 'Already a project') : h('span', { class: 'muted small' }, x.touched ? ago(x.touched) : '')));
      }) : [h('li', { class: 'muted' }, 'No git repos found there.')]));
    } catch (err) { if (err.status) $('#pi-list').replaceChildren(h('li', { class: 'err' }, err.message)); }
  }
  $('#proj-import').addEventListener('click', () => importDialog());
  $('#pi-all').addEventListener('change', e => $('#pi-list').querySelectorAll('input[type=checkbox]:not(:disabled)').forEach(c => { c.checked = e.target.checked; }));
  $('#pi-browse').addEventListener('click', () => pickInto($('#pi-root')));
  $('#pi-root-form').addEventListener('submit', e => { e.preventDefault(); const v = $('#pi-root').value.trim(); if (v) importDialog(v); });
  $('#pi-add').addEventListener('click', async () => {
    const paths = [...$('#pi-list').querySelectorAll('input[type=checkbox]:checked')].map(c => c.value);
    if (!paths.length) { toast('Tick the repos you want as projects.'); return; }
    let ok = 0;
    for (const p of paths) {
      let name = folderName(p); let i = 2;
      while (projects().some(q => q.name.toLowerCase() === name.toLowerCase())) name = `${folderName(p)} (${i++})`;
      try { const { project } = await api('POST', '/api/projects', { name, folders: [{ path: p }], status: 'active' }); replaceProject(project); ok++; } catch (err) { if (err.status) toast(err.message, 'bad'); }
    }
    $('#dlg-proj-import').close();
    S.projFilter = 'active'; renderProjects(); loadProjectStatus();
    toast(`Added ${plural(ok, 'project')}. Open one to note where you left off.`);
  });


  // ----- GitHub search: find a repo, see if it is on this computer, link or clone it.
  // mode "new" (from Find my repos) makes projects; mode "attach" adds to the open project.
  S.gh = { scope: lsGet('kv-gh-scope') || 'mine', mode: 'new', project: null, info: null };
  async function githubDialog(mode = 'new') {
    S.gh.mode = mode; S.gh.project = mode === 'attach' ? S.openProject : null;
    try { S.gh.info = await api('GET', '/api/github'); } catch (err) { if (err.status) toast(err.message, 'bad'); return; }
    const tools = await projTools();
    $('#gh-browse').hidden = !tools.picker;
    if (!$('#gh-parent').value) $('#gh-parent').value = lsGet('kv-gh-parent') || S.gh.info.roots[0] || '';
    if (!S.gh.info.token && S.gh.scope === 'mine') S.gh.scope = 'all';
    $('#gh-mode').textContent = mode === 'attach' ? `Adding to ${projById(S.gh.project)?.name || 'this project'}` : 'Each repo you add becomes a project';
    ghScope(S.gh.scope);
    openDialog('#dlg-github');
    focusIfIdle('#dlg-github', '#gh-q');
    if (S.gh.scope === 'mine') ghSearch();
    else $('#gh-list').replaceChildren();
  }
  function ghScope(scope) {
    S.gh.scope = scope; lsSet('kv-gh-scope', scope);
    for (const b of document.querySelectorAll('#gh-form [data-scope]')) b.setAttribute('aria-selected', String(b.dataset.scope === scope));
    const t = S.gh.info?.token;
    $('#gh-note').textContent = scope === 'mine'
      ? (t ? `Your repos and your organisations' repos, private ones included, using the "${S.gh.info.tokenName}" token in your vault.` : 'To see your own repos, private ones included, add a GitHub token to the vault with the variable name GITHUB_TOKEN.')
      : `Public repos across GitHub${t ? ', plus private ones your token can see' : ''}.`;
    $('#gh-q').placeholder = scope === 'mine' ? 'Filter your repos (leave empty to list them all)' : 'Search all of GitHub, e.g. supabase auth';
  }
  for (const b of document.querySelectorAll('#gh-form [data-scope]')) b.addEventListener('click', () => { ghScope(b.dataset.scope); if (b.dataset.scope === 'mine' || $('#gh-q').value.trim()) ghSearch(); });
  $('#gh-form').addEventListener('submit', e => { e.preventDefault(); ghSearch(); });
  $('#gh-browse').addEventListener('click', () => pickInto($('#gh-parent')));
  $('#gh-parent').addEventListener('change', e => lsSet('kv-gh-parent', e.target.value.trim()));

  let ghSeq = 0;
  async function ghSearch() {
    const seq = ++ghSeq;
    const q = $('#gh-q').value.trim();
    if (S.gh.scope === 'all' && !q) { $('#gh-count').textContent = 'Type something to search for.'; return; }
    if (S.gh.scope === 'mine' && !S.gh.info?.token) {
      $('#gh-count').textContent = '';
      $('#gh-list').replaceChildren(h('li', { class: 'gh-item' },
        h('p', null, h('strong', null, 'Add a GitHub token to see your repos.'), ' In Keys, add a key with the variable name GITHUB_TOKEN (a fine-grained token with read access to your repos is enough). Private repos and your organisations\' repos then show up here, and clones of them just work.'),
        h('div', { class: 'btn-row' }, h('button', { type: 'button', class: 'btn ghost sm', onclick: () => { ghScope('all'); $('#gh-list').replaceChildren(); $('#gh-q').focus(); } }, 'Search all of GitHub instead'))));
      return;
    }
    $('#gh-count').textContent = 'Searching GitHub…';
    $('#gh-list').replaceChildren();
    try {
      const r = await api('POST', '/api/github/search', { q, scope: S.gh.scope });
      if (seq !== ghSeq) return;
      $('#gh-count').textContent = r.repos.length ? `${plural(r.repos.length, 'repo')}${r.repos.length >= 200 ? ' (first 200)' : ''}` : 'No repos match.';
      $('#gh-list').replaceChildren(...r.repos.map(ghRow));
    } catch (err) { if (seq === ghSeq && err.status) { $('#gh-count').textContent = ''; $('#gh-list').replaceChildren(h('li', { class: 'err' }, err.message)); } }
  }

  function ghRow(r) {
    const attachTo = S.gh.mode === 'attach' ? projById(S.gh.project) : null;
    const linked = attachTo && ((attachTo.links || []).some(l => l.url.toLowerCase() === r.url.toLowerCase()) || (r.localPath && (attachTo.folders || []).some(f => f.path.toLowerCase() === r.localPath.toLowerCase())));
    const status = h('div', { class: 'gh-where small' },
      r.localPath ? h('span', null, h('span', { class: 'chip ok' }, 'On this computer'), ' ', h('span', { class: 'mono' }, r.localPath)) : h('span', { class: 'muted' }, 'Not on this computer yet'),
      r.project ? h('span', { class: 'chip info' }, `Project: ${r.project.name}`) : null);
    const go = h('button', { type: 'button', class: 'btn sm primary' });
    if (linked) { go.textContent = 'Linked'; go.disabled = true; go.className = 'btn sm ghost'; }
    else if (attachTo) go.textContent = r.localPath ? 'Link folder' : 'Clone and link';
    else if (r.project) { go.textContent = 'Open project'; go.className = 'btn sm ghost'; }
    else go.textContent = r.localPath ? 'Add as project' : 'Clone and add';
    go.addEventListener('click', () => ghAct(r, go));
    return h('li', { class: 'gh-item' },
      h('div', { class: 'gh-top' },
        h('a', { class: 'gh-name', href: r.url, target: '_blank', rel: 'noopener noreferrer' }, r.fullName),
        r.private ? h('span', { class: 'chip warn' }, 'Private') : null,
        r.fork ? h('span', { class: 'chip' }, 'Fork') : null,
        r.archived ? h('span', { class: 'chip' }, 'Archived') : null,
        h('span', { class: 'muted small gh-meta' }, [r.language, r.stars ? `★ ${r.stars.toLocaleString('en-GB')}` : '', r.pushedAt ? `pushed ${ago(r.pushedAt)}` : ''].filter(Boolean).join('  ·  '))),
      r.description ? h('p', { class: 'gh-desc' }, r.description) : null,
      h('div', { class: 'gh-bottom' }, status, go));
  }

  async function ghAct(r, btn) {
    if (r.project && S.gh.mode === 'new') { $('#dlg-github').close(); if ($('#dlg-proj-import').open) $('#dlg-proj-import').close(); openProject(r.project.id); return; }
    const label = btn.textContent;
    btn.disabled = true;
    try {
      let dir = r.localPath;
      if (!dir) {
        const parent = $('#gh-parent').value.trim();
        if (!parent) { toast('Choose the folder to clone into first.', 'bad'); $('#gh-parent').focus(); return; }
        btn.textContent = 'Cloning…'; btn.classList.add('busy');
        dir = (await api('POST', '/api/github/clone', { fullName: r.fullName, parent })).path;
        lsSet('kv-gh-parent', parent);
        toast(`Cloned ${r.fullName} into ${dir}.`);
      }
      const link = { label: 'GitHub', url: r.url };
      if (S.gh.mode === 'attach') {
        const x = projById(S.gh.project);
        const folders = (x.folders || []).some(f => f.path.toLowerCase() === dir.toLowerCase()) ? x.folders : [...(x.folders || []), { path: dir }];
        const links = (x.links || []).some(l => l.url.toLowerCase() === r.url.toLowerCase()) ? x.links : [...(x.links || []), link];
        await patch(x.id, { folders, links });
        loadFolderStatus(x.id); loadProjectStatus();
        btn.textContent = 'Linked'; btn.className = 'btn sm ghost';
        r.localPath = dir;
        return;
      }
      let name = r.name; let i = 2;
      while (projects().some(q => q.name.toLowerCase() === name.toLowerCase())) name = `${r.name} (${i++})`;
      const { project } = await api('POST', '/api/projects', { name, summary: r.description || '', status: 'active', folders: [{ path: dir }], links: [link] });
      replaceProject(project);
      S.projFilter = 'active'; renderProjects(); loadProjectStatus();
      r.localPath = dir; r.project = { id: project.id, name: project.name };
      btn.textContent = 'Open project'; btn.className = 'btn sm ghost'; btn.disabled = false; btn.classList.remove('busy');
      toast(`Added ${project.name} as a project.`);
      return;
    } catch (err) {
      if (err.status) toast(err.message, 'bad');
      btn.textContent = label;
    } finally {
      btn.classList.remove('busy');
      if (btn.textContent !== 'Linked') btn.disabled = false;
    }
  }
  $('#pi-github').addEventListener('click', () => githubDialog('new'));
  $('#pd-github').addEventListener('click', () => githubDialog('attach'));

  // ---------------------------------------------------------------- apps
  // A Netflix-style view of the same snapshot: a spotlight for your main app,
  // then rows of cards you can scroll sideways. Hover a card for its actions.
  const hash = str => { let x = 2166136261; for (const ch of String(str)) { x ^= ch.codePointAt(0); x = Math.imul(x, 16777619); } return x >>> 0; };
  const POSTER_HUES = [[0, 116, 217], [61, 220, 151], [255, 176, 32], [155, 123, 255], [34, 184, 207], [255, 107, 107], [92, 179, 255], [232, 121, 249]];
  const initials = name => {
    const words = String(name).replace(/[^A-Za-z0-9 ]+/g, ' ').trim().split(/\s+/).filter(Boolean);
    return ((words[0]?.[0] || '?') + (words[1]?.[0] || words[0]?.[1] || '')).toUpperCase();
  };
  const cleanTitle = t => String(t || '').replace(/\s*[|·–-]\s*(localhost|127\.0\.0\.1)(:\d+)?\s*$/i, '').trim();

  function buildApps() {
    const { containers, listeners } = S.services;
    const byPort = new Map(listeners.map(l => [l.port, l]));
    const apps = [];
    for (const c of containers) {
      const ports = c.ports.filter(p => p.proto === 'tcp');
      if (!ports.length && !c.project) continue;
      const main = ports.map(p => byPort.get(p.hostPort)).find(l => l?.probe?.http) || byPort.get(ports[0]?.hostPort);
      const probe = main?.probe;
      apps.push({
        id: `c:${c.name}`, kind: 'docker', name: cleanTitle(probe?.title) || c.service || c.name, sub: c.project ? `${c.project} · ${c.service || c.name}` : c.image,
        port: main?.port ?? ports[0]?.hostPort ?? null, web: !!probe?.http, icon: probe?.icon || null,
        running: c.state === 'running', status: c.status, project: c.project, container: c, exposure: main?.exposure,
      });
    }
    for (const l of listeners) {
      if (l.container || l.system || l.dockerProcess || l.pid == null) continue;
      apps.push({
        id: `p:${l.port}`, kind: 'process', name: cleanTitle(l.probe?.title) || (l.process ? l.process.replace(/\.exe$/i, '') : `Port ${l.port}`),
        sub: `${l.process || 'Program'} · pid ${l.pid}`, port: l.port, web: !!l.probe?.http, icon: l.probe?.icon || null,
        running: true, status: l.probe?.http ? `HTTP ${l.probe.status}` : 'Listening', listener: l, exposure: l.exposure,
      });
    }
    return apps;
  }

  function poster(app, big = false) {
    const [r, g, b] = POSTER_HUES[hash(app.name) % POSTER_HUES.length];
    const el = h('div', { class: `poster${app.running ? '' : ' off'}` });
    el.style.setProperty('--tint', `${r}, ${g}, ${b}`);
    el.style.setProperty('--angle', `${hash(app.id) % 360}deg`);
    if (app.icon) {
      const img = h('img', { class: 'poster-icon', alt: '', src: app.icon, draggable: 'false' });
      img.addEventListener('error', () => img.replaceWith(h('div', { class: 'poster-mono' }, initials(app.name))));
      el.append(img);
    } else el.append(h('div', { class: 'poster-mono' }, initials(app.name)));
    el.append(h('div', { class: 'poster-fade' }));
    const badges = h('div', { class: 'poster-badges' },
      app.running ? h('span', { class: 'live' }, h('i'), 'Live') : h('span', { class: 'stopped' }, 'Stopped'),
      app.port ? h('span', { class: 'port' }, `:${app.port}`) : null);
    el.append(badges);
    if (!big) el.append(h('div', { class: 'poster-title' }, app.name));
    return el;
  }

  function appActions(app, { hero = false } = {}) {
    const url = app.port ? `http://localhost:${app.port}` : null;
    const acts = [];
    if (app.running && app.web && url) {
      const a = h('a', { class: hero ? 'btn primary' : 'round-btn primary', href: url, target: '_blank', rel: 'noopener noreferrer', title: `Open ${url}`, 'aria-label': `Open ${app.name}` });
      if (hero) a.append('Open'); else a.innerHTML = ICONS.play;
      acts.push(a);
    }
    const round = (icon, label, fn, extra = '') => {
      const b = h('button', { type: 'button', class: hero ? `btn ghost ${extra}` : `round-btn ${extra}`, title: label, 'aria-label': label, onclick: e => { e.stopPropagation(); fn(e.currentTarget); } });
      if (hero) b.append(label.split(' ')[0]); else b.innerHTML = ICONS[icon];
      return b;
    };
    if (app.kind === 'docker') {
      const enc = encodeURIComponent(app.container.name);
      if (app.running) {
        acts.push(round('restart', `Restart ${app.container.name}`, btn => svcAction(`Restarted ${app.name}.`, () => api('POST', `/api/services/containers/${enc}/restart`), btn)));
        acts.push(round('stop', `Stop ${app.container.name}`, btn => svcAction(`Stopped ${app.name}.`, () => api('POST', `/api/services/containers/${enc}/stop`), btn), 'glow-stop'));
      } else {
        acts.push(round('play', `Start ${app.container.name}`, btn => svcAction(`Started ${app.name}.`, () => api('POST', `/api/services/containers/${enc}/start`), btn), 'glow-start'));
      }
      acts.push(round('logs', `Logs for ${app.container.name}`, () => openLogs(app.container.name)));
    } else if (app.listener) {
      acts.push(round('stop', `Stop ${app.listener.process || 'program'} on port ${app.port}`, () => stopPort(app.listener), 'glow-stop'));
    }
    return acts;
  }

  function appCard(app) {
    const url = app.running && app.web && app.port ? `http://localhost:${app.port}` : null;
    const card = h('article', { class: 'card', tabindex: '0', 'aria-label': `${app.name}${app.port ? `, port ${app.port}` : ''}, ${app.running ? 'running' : 'stopped'}` },
      poster(app),
      h('div', { class: 'card-info' },
        h('div', { class: 'card-actions' }, appActions(app)),
        h('div', { class: 'card-name' }, app.name),
        h('div', { class: 'card-meta' },
          app.running ? h('span', { class: 'match' }, app.web ? 'Web app' : 'Service') : h('span', { class: 'muted' }, 'Stopped'),
          app.exposure === 'network' ? h('span', { class: 'chip warn' }, 'Network') : null,
          h('span', { class: 'muted' }, app.status || '')),
        h('div', { class: 'card-sub' }, app.sub)));
    // Click or Enter on the card itself opens the app, like pressing play.
    const open = () => { if (url) window.open(url, '_blank', 'noopener,noreferrer'); };
    card.addEventListener('click', e => { if (!e.target.closest('a, button')) open(); });
    card.addEventListener('keydown', e => { if (e.key === 'Enter' && e.target === card) open(); });
    return card;
  }

  function appRow(title, apps) {
    const track = h('div', { class: 'track' }, apps.map(appCard));
    const scroll = dir => track.scrollBy({ left: dir * track.clientWidth * 0.85, behavior: reduceMotion ? 'auto' : 'smooth' });
    const prev = h('button', { type: 'button', class: 'row-arrow prev', 'aria-label': `Scroll ${title} left`, onclick: () => scroll(-1) }, '‹');
    const next = h('button', { type: 'button', class: 'row-arrow next', 'aria-label': `Scroll ${title} right`, onclick: () => scroll(1) }, '›');
    const sync = () => { prev.hidden = track.scrollLeft < 8; next.hidden = track.scrollLeft + track.clientWidth > track.scrollWidth - 8; };
    track.addEventListener('scroll', sync, { passive: true });
    requestAnimationFrame(sync);
    return h('section', { class: 'app-row' }, h('h2', { class: 'row-h' }, title, h('span', { class: 'row-count' }, apps.length)), h('div', { class: 'row-wrap' }, prev, track, next));
  }

  function renderApps() {
    const heroBox = $('#apps-hero'); const rowsBox = $('#apps-rows');
    // Keep the scroll position of each row across the 5-second refresh.
    const kept = new Map([...rowsBox.querySelectorAll('.app-row')].map(r => [r.querySelector('.row-h')?.firstChild?.textContent, r.querySelector('.track').scrollLeft]));
    const apps = buildApps();
    const live = apps.filter(a => a.running);
    const web = live.filter(a => a.web);
    const rows = [];
    if (web.length) rows.push(['Running now', web]);
    const projects = new Map();
    for (const a of apps.filter(a => a.kind === 'docker' && a.project)) {
      if (!projects.has(a.project)) projects.set(a.project, []);
      projects.get(a.project).push(a);
    }
    for (const [p, list] of [...projects].sort(([x], [y]) => x.localeCompare(y))) rows.push([`Docker · ${p}`, list.sort((a, b) => b.running - a.running)]);
    const loose = apps.filter(a => a.kind === 'docker' && !a.project);
    if (loose.length) rows.push(['Standalone containers', loose]);
    const other = live.filter(a => !a.web);
    if (other.length) rows.push(['Other services', other]);

    const star = web.sort((a, b) => (a.kind === 'process') - (b.kind === 'process') || (a.port - b.port))[0];
    if (star) {
      heroBox.replaceChildren(h('div', { class: 'hero' },
        poster(star, true),
        h('div', { class: 'hero-body' },
          h('div', { class: 'hero-kicker' }, h('span', { class: 'live' }, h('i'), 'Live now'), star.kind === 'docker' ? ` Docker${star.project ? ` · ${star.project}` : ''}` : ' On this computer'),
          h('h2', { class: 'hero-title' }, star.name),
          h('p', { class: 'hero-meta mono' }, `localhost:${star.port}  ·  ${star.sub}`),
          h('div', { class: 'btn-row' }, appActions(star, { hero: true })))));
    } else heroBox.replaceChildren();

    if (!rows.length) {
      rowsBox.replaceChildren(h('div', { class: 'callout' }, S.services.docker.available
        ? 'Nothing you can open is running yet. Start a dev server or a Docker container and it will appear here.'
        : 'Nothing you can open is running yet, and Docker is not running. Start a dev server, or start Docker Desktop, and your apps will appear here.'));
    } else {
      rowsBox.replaceChildren(...rows.map(([t, list]) => appRow(t, list)));
      for (const r of rowsBox.querySelectorAll('.app-row')) {
        const left = kept.get(r.querySelector('.row-h').firstChild.textContent);
        if (left) r.querySelector('.track').scrollLeft = left;
      }
    }
    $('#apps-sub').textContent = `${plural(live.length, 'app')} running  ·  ${plural(web.length, 'web app')} you can open  ·  refreshed ${new Date(S.services.at).toLocaleTimeString('en-GB')}`;
  }

  async function stopPort(l) {
    const go = await confirmBox({
      title: `Stop ${l.process || 'this program'}?`,
      body: `This ends ${l.process || 'the program'} (process ${l.pid}) that is listening on port ${l.port}${/node|python|ruby|java|php|deno|bun/i.test(l.process || '') ? '. Any unsaved work in it will be lost' : ''}.`,
      ok: 'Stop it', danger: true,
    });
    if (!go) return;
    await svcAction(`Stopped ${l.process || 'process'} on port ${l.port}.`, () => api('POST', `/api/services/processes/${l.pid}/stop`));
  }

  async function openLogs(name) {
    S.logsRef = name;
    $('#logs-title').textContent = `Logs: ${name}`;
    $('#logs-out').textContent = 'Loading…';
    openDialog('#dlg-logs');
    await loadLogs();
  }
  async function loadLogs() {
    try {
      const { logs } = await api('GET', `/api/services/containers/${encodeURIComponent(S.logsRef)}/logs?tail=${$('#logs-tail').value}`);
      const out = $('#logs-out');
      out.textContent = logs || '(no output)';
      out.scrollTop = out.scrollHeight;
    } catch (err) { if (err.status) $('#logs-out').textContent = err.message; }
  }
  $('#logs-refresh').addEventListener('click', loadLogs);
  $('#logs-tail').addEventListener('change', loadLogs);

  // ----- link keys to a compose project
  function linkRow(envName = '', keyId = '') {
    const name = h('input', { type: 'text', value: envName, placeholder: 'ENV_VAR_NAME', 'aria-label': 'Environment variable name', spellcheck: 'false' });
    const sel = h('select', { 'aria-label': 'Key' }, h('option', { value: '' }, 'Choose a key…'),
      ...S.vault.keys.filter(k => k.status !== 'revoked').map(k => h('option', { value: k.id }, `${k.name} (${orgById(k.orgId)?.name || ''})`)));
    sel.value = keyId;
    sel.addEventListener('change', () => {
      const k = S.vault.keys.find(x => x.id === sel.value);
      if (k?.envVar && !name.value.trim()) name.value = k.envVar;
    });
    const row = h('div', { class: 'link-row' }, name, sel, iconBtn('trash', 'Remove', () => row.remove(), 'danger'));
    return row;
  }
  function openLinks(project) {
    S.linksProject = project;
    $('#links-title').textContent = `Keys for ${project}`;
    const vars = S.services.composeLinks?.[project]?.vars || {};
    const rows = Object.entries(vars).map(([n, id]) => linkRow(n, id));
    $('#links-rows').replaceChildren(...(rows.length ? rows : [linkRow()]));
    $('#links-err').hidden = true;
    openDialog('#dlg-links');
  }
  $('#links-add').addEventListener('click', () => $('#links-rows').append(linkRow()));
  $('#links-form').addEventListener('submit', async e => {
    e.preventDefault();
    const err = $('#links-err'); err.hidden = true;
    const vars = {};
    for (const row of $('#links-rows').children) {
      const [nameEl, selEl] = row.querySelectorAll('input, select');
      const n = nameEl.value.trim(); const id = selEl.value;
      if (!n && !id) continue;
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(n)) { err.textContent = `"${n || '(blank)'}" is not a valid environment variable name.`; err.hidden = false; return; }
      if (!id) { err.textContent = `Choose a key for ${n}.`; err.hidden = false; return; }
      vars[n] = id;
    }
    try {
      await api('PUT', `/api/services/projects/${encodeURIComponent(S.linksProject)}/links`, { vars });
      $('#dlg-links').close();
      toast(`Saved keys for ${S.linksProject}.`);
      loadServices();
    } catch (e2) { if (e2.status) { err.textContent = e2.message; err.hidden = false; } }
  });

  async function composeUp(project) {
    $('#output-title').textContent = `docker compose up: ${project}`;
    $('#output-status').textContent = 'Running…';
    $('#output-text').textContent = '';
    openDialog('#dlg-output');
    try {
      const r = await api('POST', `/api/services/projects/${encodeURIComponent(project)}/up`);
      $('#output-status').textContent = r.timedOut ? 'Stopped after 5 minutes.' : r.exitCode === 0 ? 'Done.' : `Finished with exit code ${r.exitCode}.`;
      $('#output-text').textContent = [r.stdout, r.stderr].filter(Boolean).join('\n') || '(no output)';
    } catch (err) {
      $('#output-status').textContent = err.status ? err.message : 'Failed.';
    }
    loadServices();
  }

  // ---------------------------------------------------------------- lifecycle
  let pollTimer = 0;
  function stopTimers() { clearInterval(pollTimer); stopServicesTimer(); }

  // Tell KeyVault the user is active (throttled), so auto-lock only counts real inactivity.
  for (const ev of ['pointerdown', 'keydown', 'wheel']) {
    document.addEventListener(ev, () => {
      if (S.state !== 'unlocked' || Date.now() - S.lastTouch < 30000) return;
      S.lastTouch = Date.now();
      api('POST', '/api/touch').catch(() => {});
    }, { passive: true });
  }

  async function poll() {
    if (document.hidden) return;
    try {
      const st = await api('GET', '/api/status');
      if (S.state === 'unlocked' && st.state !== 'unlocked') {
        lockUi(st.state === 'locked' ? `Locked after ${S.vault?.settings.autoLockMin ?? ''} minutes without activity.` : undefined);
      }
      S.state = st.state;
      if (st.state === 'unlocked') setPass(st.pass);
      else if (S.state === 'locked') gatePass(st.pass);
    } catch {}
  }

  async function boot() {
    try {
      const st = await api('GET', '/api/status');
      S.state = st.state;
      S.version = st.version;
      if (st.state === 'unlocked') { await enterApp(); setPass(st.pass); }
      else { showGate(st.state === 'none' ? 'create' : 'unlock'); gatePass(st.pass); }
      pollTimer = setInterval(poll, 8000);
      document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); });
    } catch {}
  }

  boot();
})();
