/* =========================================================================
   BlueHorizon Log — minimal documentation app
   Backend: a GitHub repo. Layout inside the repo:
     data/projects.json          -> [{id, name}]
     data/index.json             -> [entry meta, newest first]
     data/entries/<id>.md        -> full markdown entry (durable archive)
     data/photos/<id>/<n>.jpg    -> compressed photos
   Reads are public (raw.githubusercontent.com) or token-authed.
   Writes use the GitHub Contents API and need a token with Contents R/W.
   ========================================================================= */

'use strict';

/* ---------- config / state ---------- */

const DEFAULT_PROJECTS = [
  { id: 'engine',          name: 'Engine' },
  { id: 'flight-computer', name: 'Flight Computer' },
  { id: 'gse',             name: 'GSE' },
  { id: 'sim-controls',    name: 'Simulation & Controls' },
  { id: 'solids',          name: 'Solids' },
  { id: 'structures',      name: 'Structures' },
  { id: 'team',            name: 'Team / General' },
];

const cfg = {
  get name()   { return localStorage.getItem('bh_name')   || ''; },
  get repo()   { return localStorage.getItem('bh_repo')   || ''; },
  get branch() { return localStorage.getItem('bh_branch') || 'main'; },
  get token()  { return localStorage.getItem('bh_token')  || ''; },
  set(k, v)    { localStorage.setItem('bh_' + k, v.trim()); },
};

const state = {
  entries: [],          // from data/index.json, newest first
  projects: [],         // from data/projects.json
  filter: 'all',        // feed project filter
  photoFilter: 'all',
  composePhotos: [],    // [{blob, dataUrl}]
  composeType: 'log',
  view: 'feed',
  openProject: null,
  blobCache: new Map(), // repo path -> object URL (for private repos)
};

const $ = (id) => document.getElementById(id);

/* ---------- GitHub API ---------- */

const api = {
  base() { return `https://api.github.com/repos/${cfg.repo}`; },

  headers(extra = {}) {
    const h = { Accept: 'application/vnd.github+json', ...extra };
    if (cfg.token) h.Authorization = `Bearer ${cfg.token}`;
    return h;
  },

  // Read a file. Returns {text, sha} or null if missing.
  async read(path) {
    const r = await fetch(`${this.base()}/contents/${path}?ref=${cfg.branch}&t=${Date.now()}`,
      { headers: this.headers({ Accept: 'application/vnd.github.raw' }) });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`GitHub read failed (${r.status})`);
    // sha comes from a separate metadata call only when we need to update
    return { text: await r.text() };
  },

  async sha(path) {
    const r = await fetch(`${this.base()}/contents/${path}?ref=${cfg.branch}&t=${Date.now()}`,
      { headers: this.headers() });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`GitHub stat failed (${r.status})`);
    return (await r.json()).sha;
  },

  // Create or update a file. content = string | Uint8Array | Blob
  async write(path, content, message, sha = null) {
    const b64 = await toBase64(content);
    const body = { message, content: b64, branch: cfg.branch };
    if (sha) body.sha = sha;
    const r = await fetch(`${this.base()}/contents/${path}`, {
      method: 'PUT', headers: this.headers(), body: JSON.stringify(body),
    });
    if (!r.ok) {
      const detail = (await r.json().catch(() => ({}))).message || r.status;
      throw new Error(`GitHub write failed: ${detail}`);
    }
    return r.json();
  },

  // Read JSON file with fallback
  async readJson(path, fallback) {
    const f = await this.read(path);
    if (!f) return fallback;
    try { return JSON.parse(f.text); } catch { return fallback; }
  },

  // Update a JSON file with optimistic-concurrency retry.
  async updateJson(path, mutate, message) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const sha = await this.sha(path);
      const current = sha ? await this.readJson(path, null) : null;
      const next = mutate(current);
      try {
        return await this.write(path, JSON.stringify(next, null, 2), message, sha);
      } catch (e) {
        if (attempt === 2 || !/409|does not match/.test(String(e))) throw e;
      }
    }
  },
};

async function toBase64(content) {
  let blob;
  if (content instanceof Blob) blob = content;
  else if (content instanceof Uint8Array) blob = new Blob([content]);
  else blob = new Blob([String(content)]);
  const buf = await blob.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

/* Photo URL: public repos use raw.githubusercontent (fast, cacheable);
   with a token we fetch via API and cache a blob URL (works for private). */
function photoUrl(path, imgEl) {
  if (!cfg.token) {
    return `https://raw.githubusercontent.com/${cfg.repo}/${cfg.branch}/${path}`;
  }
  if (state.blobCache.has(path)) return state.blobCache.get(path);
  // async fill-in
  fetch(`${api.base()}/contents/${path}?ref=${cfg.branch}`,
    { headers: api.headers({ Accept: 'application/vnd.github.raw' }) })
    .then((r) => (r.ok ? r.blob() : null))
    .then((b) => {
      if (!b) return;
      const url = URL.createObjectURL(b);
      state.blobCache.set(path, url);
      document.querySelectorAll(`img[data-path="${CSS.escape(path)}"]`)
        .forEach((el) => { el.src = url; });
    })
    .catch(() => {});
  return ''; // placeholder until blob resolves
}

/* ---------- data load ---------- */

async function loadAll(showSpinner = true) {
  if (!cfg.repo) { openSettings(true); return; }
  const btn = $('btnSync');
  if (showSpinner) btn.classList.add('spin');
  try {
    const [projects, entries] = await Promise.all([
      api.readJson('data/projects.json', DEFAULT_PROJECTS),
      api.readJson('data/index.json', []),
    ]);
    state.projects = projects;
    state.entries = entries;
    render();
  } catch (e) {
    toast(`Couldn’t load: ${e.message}`, true);
  } finally {
    btn.classList.remove('spin');
  }
}

/* ---------- rendering ---------- */

function render() {
  renderFilters($('feedFilters'), state.filter, (id) => { state.filter = id; render(); });
  renderFilters($('photoFilters'), state.photoFilter, (id) => { state.photoFilter = id; render(); });
  renderFeed();
  renderPhotos();
  renderProjects();
  if (state.openProject) renderProjectDetail();
}

function projName(id) {
  return (state.projects.find((p) => p.id === id) || {}).name || id;
}

function renderFilters(el, active, onPick) {
  el.innerHTML = '';
  const mk = (id, label) => {
    const b = document.createElement('button');
    b.className = 'chip' + (active === id ? ' active' : '');
    b.textContent = label;
    b.onclick = () => onPick(id);
    el.appendChild(b);
  };
  mk('all', 'All');
  mk('journal', 'Journals');
  state.projects.forEach((p) => mk(p.id, p.name));
}

function matchesFilter(e, f) {
  if (f === 'all') return true;
  if (f === 'journal') return e.type === 'journal';
  return e.project === f;
}

function entryCard(e, clamp = true) {
  const card = document.createElement('div');
  card.className = 'card';
  card.onclick = () => openEntry(e);

  const when = new Date(e.date).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  const badge = e.type === 'journal'
    ? '<span class="badge journal">Journal</span>'
    : `<span class="badge">${esc(projName(e.project))}</span>`;

  card.innerHTML = `
    <div class="card-meta">${badge}<span>${esc(e.author || 'Unknown')}</span><span>·</span><span>${when}</span></div>
    ${e.title ? `<div class="card-title">${esc(e.title)}</div>` : ''}
    ${e.body ? `<div class="card-body${clamp ? ' clamp' : ''}">${esc(e.body)}</div>` : ''}
  `;

  if (e.photos && e.photos.length) {
    const row = document.createElement('div');
    row.className = 'card-photos';
    e.photos.slice(0, 6).forEach((p) => {
      const img = document.createElement('img');
      img.loading = 'lazy';
      img.dataset.path = p;
      img.src = photoUrl(p, img);
      img.alt = e.title || 'photo';
      row.appendChild(img);
    });
    card.appendChild(row);
  }
  return card;
}

function renderFeed() {
  const list = $('feedList');
  list.innerHTML = '';
  const items = state.entries.filter((e) => matchesFilter(e, state.filter));
  $('feedEmpty').classList.toggle('hidden', items.length > 0);
  items.forEach((e) => list.appendChild(entryCard(e)));
}

function renderPhotos() {
  const grid = $('photoGrid');
  grid.innerHTML = '';
  const photos = [];
  state.entries
    .filter((e) => matchesFilter(e, state.photoFilter))
    .forEach((e) => (e.photos || []).forEach((p) => photos.push({ path: p, entry: e })));
  $('photosEmpty').classList.toggle('hidden', photos.length > 0);
  photos.forEach(({ path, entry }) => {
    const img = document.createElement('img');
    img.loading = 'lazy';
    img.dataset.path = path;
    img.src = photoUrl(path, img);
    img.alt = entry.title || projName(entry.project);
    img.onclick = () => openLightbox(path, entry);
    grid.appendChild(img);
  });
}

function renderProjects() {
  const list = $('projectList');
  list.innerHTML = '';
  state.projects.forEach((p) => {
    const n = state.entries.filter((e) => e.project === p.id).length;
    const card = document.createElement('div');
    card.className = 'project-card';
    card.innerHTML = `<span class="project-name">${esc(p.name)}</span>
                      <span class="project-count">${n} entr${n === 1 ? 'y' : 'ies'} ›</span>`;
    card.onclick = () => { state.openProject = p.id; switchView('project'); renderProjectDetail(); };
    list.appendChild(card);
  });
}

function renderProjectDetail() {
  $('projectTitle').textContent = projName(state.openProject);
  const list = $('projectEntries');
  list.innerHTML = '';
  const items = state.entries.filter((e) => e.project === state.openProject);
  if (!items.length) {
    list.innerHTML = '<div class="empty"><p>No entries for this project yet.</p></div>';
    return;
  }
  items.forEach((e) => list.appendChild(entryCard(e)));
}

/* ---------- entry detail ---------- */

function openEntry(e) {
  $('entrySheetTitle').textContent = projName(e.project);
  const el = $('entryDetail');
  const when = new Date(e.date).toLocaleDateString(undefined, { weekday: 'short', month: 'long', day: 'numeric', year: 'numeric' });
  el.innerHTML = `
    ${e.title ? `<h2 style="font-size:20px">${esc(e.title)}</h2>` : ''}
    <div class="detail-meta">${esc(e.author || 'Unknown')} · ${when}${e.type === 'journal' ? ' · Weekly journal' : ''}</div>
    ${e.body ? `<div class="detail-body">${esc(e.body)}</div>` : ''}
  `;
  if (e.photos && e.photos.length) {
    const grid = document.createElement('div');
    grid.className = 'detail-photos';
    e.photos.forEach((p) => {
      const img = document.createElement('img');
      img.dataset.path = p;
      img.src = photoUrl(p, img);
      img.onclick = () => openLightbox(p, e);
      grid.appendChild(img);
    });
    el.appendChild(grid);
  }
  $('entrySheet').classList.remove('hidden');
}

function openLightbox(path, entry) {
  const img = $('lightboxImg');
  img.dataset.path = path;
  img.src = photoUrl(path, img);
  $('lightboxCaption').textContent =
    `${entry.title || projName(entry.project)} — ${entry.author || ''}, ${new Date(entry.date).toLocaleDateString()}`;
  $('lightbox').classList.remove('hidden');
}

/* ---------- compose ---------- */

function openCompose() {
  if (!cfg.repo) { openSettings(true); return; }
  if (!cfg.token) { toast('Add a GitHub token in Settings to post', true); openSettings(); return; }
  const sel = $('composeProject');
  sel.innerHTML = state.projects.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('');
  const last = localStorage.getItem('bh_last_project');
  if (last && state.projects.some((p) => p.id === last)) sel.value = last;
  $('composeAuthor').textContent = cfg.name ? `Posting as ${cfg.name}` : 'Set your name in Settings';
  $('composeStatus').textContent = '';
  $('compose').classList.remove('hidden');
  setComposeType(state.composeType);
}

function setComposeType(type) {
  state.composeType = type;
  document.querySelectorAll('#entryTypeSeg .seg-btn')
    .forEach((b) => b.classList.toggle('active', b.dataset.type === type));
  $('composeBody').placeholder = type === 'journal'
    ? 'What did you work on this week? Wins, blockers, what the next person should know…'
    : 'What did you do? What worked, what didn’t, what’s next?\n\nTwo sentences beats zero.';
}

function resetCompose() {
  $('composeTitle').value = '';
  $('composeBody').value = '';
  $('photoInput').value = '';
  state.composePhotos = [];
  renderComposePhotos();
}

function renderComposePhotos() {
  const row = $('composePhotos');
  row.querySelectorAll('.photo-thumb').forEach((n) => n.remove());
  state.composePhotos.forEach((p, i) => {
    const wrap = document.createElement('div');
    wrap.className = 'photo-thumb';
    wrap.innerHTML = `<img src="${p.dataUrl}" alt=""><button aria-label="Remove">&times;</button>`;
    wrap.querySelector('button').onclick = () => { state.composePhotos.splice(i, 1); renderComposePhotos(); };
    row.appendChild(wrap);
  });
}

/* Compress a photo to <=1600px JPEG ~0.8 quality. */
async function compressImage(file) {
  const dataUrl = await new Promise((res, rej) => {
    const fr = new FileReader();
    fr.onload = () => res(fr.result);
    fr.onerror = rej;
    fr.readAsDataURL(file);
  });
  const img = await new Promise((res, rej) => {
    const i = new Image();
    i.onload = () => res(i);
    i.onerror = rej;
    i.src = dataUrl;
  });
  const MAX = 1600;
  const scale = Math.min(1, MAX / Math.max(img.width, img.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(img.width * scale);
  canvas.height = Math.round(img.height * scale);
  canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise((res) => canvas.toBlob(res, 'image/jpeg', 0.8));
  return { blob, dataUrl: canvas.toDataURL('image/jpeg', 0.5) };
}

async function post() {
  const body = $('composeBody').value.trim();
  const title = $('composeTitle').value.trim();
  if (!body && !state.composePhotos.length) { toast('Add a note or a photo first', true); return; }

  const btn = $('composePost');
  btn.disabled = true;
  const status = $('composeStatus');

  const project = $('composeProject').value;
  localStorage.setItem('bh_last_project', project);

  const now = new Date();
  const id = `${now.toISOString().slice(0, 10)}-${now.getTime().toString(36)}`;
  const entry = {
    id,
    type: state.composeType,
    project,
    title,
    body,
    author: cfg.name || 'Unknown',
    date: now.toISOString(),
    photos: [],
  };

  try {
    // 1. photos
    for (let i = 0; i < state.composePhotos.length; i++) {
      status.textContent = `Uploading photo ${i + 1}/${state.composePhotos.length}…`;
      const path = `data/photos/${id}/${i + 1}.jpg`;
      await api.write(path, state.composePhotos[i].blob, `photo: ${title || id}`);
      entry.photos.push(path);
    }

    // 2. markdown archive (durable, human-readable)
    status.textContent = 'Saving entry…';
    const md = [
      '---',
      `title: ${JSON.stringify(title || id)}`,
      `project: ${project}`,
      `author: ${JSON.stringify(entry.author)}`,
      `date: ${entry.date}`,
      `type: ${entry.type}`,
      '---',
      '',
      body,
      '',
      ...entry.photos.map((p) => `![photo](/${p})`),
    ].join('\n');
    await api.write(`data/entries/${id}.md`, md, `entry: ${title || id} (${entry.author})`);

    // 3. index
    status.textContent = 'Updating index…';
    await api.updateJson('data/index.json',
      (cur) => [entry, ...(Array.isArray(cur) ? cur : [])],
      `index: ${title || id}`);

    state.entries.unshift(entry);
    $('compose').classList.add('hidden');
    resetCompose();
    render();
    toast('Posted ✓');
  } catch (e) {
    toast(e.message, true);
  } finally {
    btn.disabled = false;
    status.textContent = '';
  }
}

/* ---------- projects admin ---------- */

async function addProject() {
  const name = prompt('Project name (e.g. "Avionics Bay"):');
  if (!name || !name.trim()) return;
  if (!cfg.token) { toast('Add a GitHub token in Settings first', true); return; }
  const id = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  try {
    await api.updateJson('data/projects.json',
      (cur) => {
        const list = Array.isArray(cur) && cur.length ? cur : state.projects;
        if (list.some((p) => p.id === id)) return list;
        return [...list, { id, name: name.trim() }];
      },
      `project: add ${name.trim()}`);
    await loadAll(false);
    toast('Project added ✓');
  } catch (e) {
    toast(e.message, true);
  }
}

/* ---------- settings ---------- */

function openSettings(firstRun = false) {
  $('setName').value = cfg.name;
  $('setRepo').value = cfg.repo;
  $('setBranch').value = cfg.branch;
  $('setToken').value = cfg.token;
  $('connTest').textContent = firstRun ? 'Welcome! Point the app at your club’s GitHub repo to get started.' : '';
  $('settings').classList.remove('hidden');
}

async function saveSettings() {
  cfg.set('name', $('setName').value);
  cfg.set('repo', $('setRepo').value.replace(/^https?:\/\/github\.com\//, '').replace(/\/$/, ''));
  cfg.set('branch', $('setBranch').value || 'main');
  cfg.set('token', $('setToken').value);
  $('settings').classList.add('hidden');
  state.blobCache.clear();
  loadAll();
}

async function testConnection() {
  const el = $('connTest');
  el.textContent = 'Testing…';
  const repo = $('setRepo').value.trim().replace(/^https?:\/\/github\.com\//, '').replace(/\/$/, '');
  const token = $('setToken').value.trim();
  try {
    const h = { Accept: 'application/vnd.github+json' };
    if (token) h.Authorization = `Bearer ${token}`;
    const r = await fetch(`https://api.github.com/repos/${repo}`, { headers: h });
    if (!r.ok) throw new Error(r.status === 404 ? 'Repo not found (check name / token scope)' : `HTTP ${r.status}`);
    const info = await r.json();
    el.textContent = `✓ Connected to ${info.full_name}${info.permissions && info.permissions.push ? ' (can post)' : token ? ' (token can’t write!)' : ' (read-only, add token to post)'}`;
  } catch (e) {
    el.textContent = `✗ ${e.message}`;
  }
}

/* ---------- navigation & wiring ---------- */

function switchView(v) {
  state.view = v;
  ['feed', 'photos', 'projects', 'project'].forEach((name) => {
    $('view-' + name).classList.toggle('hidden', name !== v);
  });
  document.querySelectorAll('.tabbar .tab[data-view]').forEach((t) => {
    t.classList.toggle('active', t.dataset.view === v || (v === 'project' && t.dataset.view === 'projects'));
  });
  $('tabJournal').classList.remove('active');
  window.scrollTo(0, 0);
}

function toast(msg, isErr = false) {
  const t = $('toast');
  t.textContent = msg;
  t.className = 'toast' + (isErr ? ' err' : '');
  clearTimeout(t._h);
  t._h = setTimeout(() => t.classList.add('hidden'), 3200);
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function wire() {
  document.querySelectorAll('.tabbar .tab[data-view]').forEach((t) => {
    t.onclick = () => switchView(t.dataset.view);
  });
  $('tabJournal').onclick = () => {
    state.composeType = 'journal';
    openCompose();
  };
  $('brandHome').onclick = () => switchView('feed');
  $('btnNew').onclick = () => { state.composeType = 'log'; openCompose(); };
  $('btnSync').onclick = () => loadAll();
  $('btnSettings').onclick = () => openSettings();
  $('btnAddProject').onclick = addProject;

  document.querySelectorAll('.back-btn').forEach((b) => {
    b.onclick = () => switchView(b.dataset.back);
  });

  // compose
  $('composeCancel').onclick = () => $('compose').classList.add('hidden');
  $('composePost').onclick = post;
  document.querySelectorAll('#entryTypeSeg .seg-btn').forEach((b) => {
    b.onclick = () => setComposeType(b.dataset.type);
  });
  $('photoInput').onchange = async (ev) => {
    const files = [...ev.target.files];
    for (const f of files) {
      try {
        state.composePhotos.push(await compressImage(f));
      } catch { toast('Couldn’t read a photo', true); }
    }
    renderComposePhotos();
    ev.target.value = '';
  };

  // sheets
  $('entryClose').onclick = () => $('entrySheet').classList.add('hidden');
  $('settingsCancel').onclick = () => $('settings').classList.add('hidden');
  $('settingsSave').onclick = saveSettings;
  $('btnTestConn').onclick = testConnection;
  $('lightboxClose').onclick = () => $('lightbox').classList.add('hidden');
  $('lightbox').onclick = (e) => { if (e.target === $('lightbox')) $('lightbox').classList.add('hidden'); };

  // close sheets on backdrop tap
  ['compose', 'entrySheet', 'settings'].forEach((id) => {
    $(id).addEventListener('click', (e) => { if (e.target === $(id)) $(id).classList.add('hidden'); });
  });
}

/* ---------- boot ---------- */

window.addEventListener('load', () => {
  wire();
  state.projects = DEFAULT_PROJECTS;
  render();
  loadAll();
  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
});
