(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const product = document.body.dataset.product;
  const slug = document.body.dataset.slug;
  const kind = document.body.dataset.kind;
  const editor = window.XEditor;
  const title = $('doc-title');
  let currentId = null;
  let starred = false;
  let dirty = false;
  let saveTimer = null;
  let saving = null;
  let toastTimer = null;

  function status(message) { $('status').textContent = message; }
  function toast(message, error = false) {
    const el = $('toast');
    el.textContent = message;
    el.classList.toggle('error', error);
    el.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.add('hidden'), 3800);
  }
  async function api(path, options = {}) {
    const response = await fetch('/api' + path, {
      ...options,
      headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(options.headers || {}) },
    });
    if (!response.ok) {
      let message = `${response.status} ${response.statusText}`;
      try { message = (await response.json()).error || message; } catch (_) {}
      throw new Error(message);
    }
    return response.status === 204 ? null : response.json();
  }
  function currentTitle() {
    return title.textContent.trim().slice(0, 120) || `Untitled ${kind}`;
  }
  function setTitle(text) {
    title.textContent = text || `Untitled ${kind}`;
    document.title = `${currentTitle()} — ${product}`;
  }
  function markDirty() {
    dirty = true;
    status('Unsaved changes');
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { save().catch(() => {}); }, 900);
  }
  async function save() {
    clearTimeout(saveTimer);
    if (saving) {
      await saving;
      if (dirty) return save();
      return;
    }
    if (!dirty && currentId) return;
    const payload = { title: currentTitle(), starred, content: editor.snapshot() };
    dirty = false;
    status('Saving…');
    saving = (async () => {
      try {
        const doc = await api(currentId ? `/documents/${encodeURIComponent(currentId)}` : '/documents', {
          method: currentId ? 'PUT' : 'POST', body: JSON.stringify(payload),
        });
        currentId = doc.id;
        status(dirty ? 'Unsaved changes' : 'Saved locally');
        refreshLibrary().catch(() => {});
      } catch (error) {
        dirty = true;
        status('Save failed');
        toast(`Could not save: ${error.message}`, true);
        throw error;
      } finally { saving = null; }
    })();
    return saving;
  }
  async function flush() {
    clearTimeout(saveTimer);
    if (dirty) await save();
    else if (saving) await saving;
  }
  function applyDocument(doc) {
    currentId = doc.id;
    starred = !!doc.starred;
    $('star-btn').setAttribute('aria-pressed', String(starred));
    setTitle(doc.title);
    editor.load(doc.content || {});
    dirty = false;
    status('Saved locally');
  }
  function newDocument() {
    currentId = null;
    starred = false;
    $('star-btn').setAttribute('aria-pressed', 'false');
    setTitle(`Untitled ${kind}`);
    editor.blank();
    dirty = false;
    status('Ready');
  }
  async function openFile(name, content) {
    const result = editor.importFile(name, content);
    currentId = null;
    starred = false;
    $('star-btn').setAttribute('aria-pressed', 'false');
    setTitle(result?.title || name.replace(/\.[^.]+$/, ''));
    markDirty();
  }
  function entry(label, meta, icon, active, onClick, onDelete) {
    const row = document.createElement('div');
    row.tabIndex = 0;
    row.className = 'doc-item' + (active ? ' active' : '');
    row.setAttribute('role', 'listitem');
    const symbol = document.createElement('span');
    symbol.className = 'material-symbols-outlined file-icon';
    symbol.setAttribute('aria-hidden', 'true');
    symbol.textContent = icon;
    const info = document.createElement('span'); info.className = 'doc-info';
    const nameEl = document.createElement('span'); nameEl.className = 'doc-name'; nameEl.textContent = label;
    const metaEl = document.createElement('span'); metaEl.className = 'doc-meta'; metaEl.textContent = meta;
    info.append(nameEl, metaEl); row.append(symbol, info);
    row.addEventListener('click', onClick);
    row.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onClick(); } });
    if (onDelete) {
      const del = document.createElement('button');
      del.type = 'button'; del.className = 'delete-doc'; del.title = 'Delete'; del.setAttribute('aria-label', `Delete ${label}`); del.textContent = '×';
      del.addEventListener('click', (event) => { event.stopPropagation(); onDelete(); });
      row.append(del);
    }
    return row;
  }
  async function refreshLibrary() {
    const list = $('doc-list');
    const [docs, files] = await Promise.all([api('/documents'), api('/files')]);
    list.replaceChildren();
    const group = (name) => { const el = document.createElement('div'); el.className = 'library-group'; el.textContent = name; list.append(el); };
    group('Saved in ' + product);
    if (!docs.length) { const empty = document.createElement('div'); empty.className = 'empty-state'; empty.textContent = 'No saved documents yet'; list.append(empty); }
    for (const doc of docs) {
      list.append(entry(doc.title, new Date(doc.updatedAt).toLocaleString(), 'description', doc.id === currentId,
        async () => { try { await flush(); applyDocument(await api(`/documents/${encodeURIComponent(doc.id)}`)); await refreshLibrary(); } catch (e) { toast(e.message, true); } },
        async () => { if (!confirm(`Delete “${doc.title}”?`)) return; try { await api(`/documents/${encodeURIComponent(doc.id)}`, { method: 'DELETE' }); if (currentId === doc.id) newDocument(); await refreshLibrary(); } catch (e) { toast(e.message, true); } }));
    }
    group('Files in Documents');
    if (!files.length) { const empty = document.createElement('div'); empty.className = 'empty-state'; empty.textContent = 'Use Open File or place a supported file in Documents'; list.append(empty); }
    for (const file of files) {
      list.append(entry(file.name, `${Math.max(1, Math.round(file.size / 1024))} KB`, 'draft', false,
        async () => { try { await flush(); const opened = await api('/files/open', { method: 'POST', body: JSON.stringify({ path: file.name }) }); await openFile(opened.name, opened.content); } catch (e) { toast(`Could not open file: ${e.message}`, true); } }));
    }
  }
  function download(data, mime, filename) {
    const blob = data instanceof Blob ? data : new Blob([data], { type: mime });
    const href = URL.createObjectURL(blob);
    const link = document.createElement('a'); link.href = href; link.download = filename;
    document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(href), 10000);
  }
  async function exportCurrent() {
    try {
      const format = $('export-format').value;
      const file = await editor.export(format, currentTitle());
      download(file.data, file.mime, file.filename || `${currentTitle()}.${format}`);
      toast(`Exported ${format.toUpperCase()}`);
    } catch (error) { toast(`Export failed: ${error.message}`, true); }
  }
  editor.init(markDirty);
  newDocument();
  refreshLibrary().catch(() => { status('Editor ready · local API offline'); });
  const launchToken = new URLSearchParams(window.location.search).get('launch');
  if (launchToken) {
    (async () => {
      try {
        const response = await fetch('/api/files/launch?token=' + encodeURIComponent(launchToken));
        const opened = await response.json();
        if (!response.ok) throw new Error(opened.error || 'Could not open launch file');
        await openFile(opened.name, opened.content);
      } catch (error) {
        toast(`Could not open file: ${error.message}`, true);
      }
    })();
  }
  $('new-btn').addEventListener('click', async () => { try { await flush(); newDocument(); await refreshLibrary(); } catch (_) {} });
  $('open-btn').addEventListener('click', () => $('file-input').click());
  $('file-input').addEventListener('change', async (event) => {
    const file = event.target.files[0]; event.target.value = '';
    if (!file) return;
    try {
      await flush();
      if (/\.odg$/i.test(file.name)) {
        const response = await fetch('/api/files/decode?name=' + encodeURIComponent(file.name), { method: 'POST', body: await file.arrayBuffer() });
        const opened = await response.json();
        if (!response.ok) throw new Error(opened.error || 'Could not read ODG drawing');
        await openFile(opened.name, opened.content);
      } else await openFile(file.name, await file.text());
    }
    catch (error) { toast(`Could not open file: ${error.message}`, true); }
  });
  $('save-btn').addEventListener('click', () => save().catch(() => {}));
  $('export-btn').addEventListener('click', exportCurrent);
  $('print-btn').addEventListener('click', () => window.print());
  $('refresh-btn').addEventListener('click', () => refreshLibrary().catch((e) => toast(e.message, true)));
  $('theme-btn').addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem(`${slug}-theme`, next); } catch (_) {}
  });
  $('star-btn').addEventListener('click', () => { starred = !starred; $('star-btn').setAttribute('aria-pressed', String(starred)); markDirty(); });
  title.addEventListener('input', () => { document.title = `${currentTitle()} — ${product}`; markDirty(); });
  title.addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); title.blur(); } });
  window.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); save().catch(() => {}); }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'o') { event.preventDefault(); $('file-input').click(); }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'n') { event.preventDefault(); $('new-btn').click(); }
  });
  window.addEventListener('beforeunload', (event) => { if (dirty || saving) { event.preventDefault(); event.returnValue = ''; } });
})();
