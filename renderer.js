// ── Icons ────────────────────────────────────────────────────────────────────

const ICON_PIN_OFF = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>`;
const ICON_PIN_ON  = `<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>`;
const ICON_COPY    = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`;
const ICON_CHECK   = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;

// ── DOM refs ─────────────────────────────────────────────────────────────────

const noteInput       = document.getElementById('note-input');
const searchToggleBtn = document.getElementById('search-toggle-btn');
const searchBar       = document.getElementById('search-bar');
const searchInput     = document.getElementById('search-input');
const notesList       = document.getElementById('notes-list');
const collapseBtn     = document.getElementById('collapse-btn');
const hideBtn         = document.getElementById('hide-btn');
const undoToast       = document.getElementById('undo-toast');
const undoBtn         = document.getElementById('undo-btn');
const voiceDot        = document.getElementById('voice-dot');

// ── App state ────────────────────────────────────────────────────────────────

let notes         = [];
let searchTerm    = '';
let searchVisible = false;
let pendingDelete = null;

// ── Window state ─────────────────────────────────────────────────────────────

window.floatnote.receive('window:state', state => {
  document.body.className = state;
  if (state === 'expanded') setTimeout(() => noteInput.focus(), 60);
});

// ── Notes load & clipboard ───────────────────────────────────────────────────

window.floatnote.receive('notes:loaded', saved => {
  notes = (Array.isArray(saved) ? saved : []).map(n => ({ pinned: false, ...n }));
  renderNotes();
});

window.floatnote.receive('clipboard:new', text => {
  createNote(text, 'copied');
  renderNotes();
  saveNotes();
});

// ── Title bar buttons ────────────────────────────────────────────────────────

collapseBtn.addEventListener('click', () => window.floatnote.send('window:collapse'));
hideBtn.addEventListener('click',     () => window.floatnote.send('window:hide'));

// ── Note input ───────────────────────────────────────────────────────────────

noteInput.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submitNote(); }
});

noteInput.addEventListener('input', () => {
  noteInput.style.height = 'auto';
  noteInput.style.height = Math.min(noteInput.scrollHeight, 96) + 'px';
});

function submitNote() {
  const text = noteInput.value.trim();
  if (!text) return;
  createNote(text, 'typed');
  noteInput.value = '';
  noteInput.style.height = 'auto';
  renderNotes();
  saveNotes();
}

// ── Search ───────────────────────────────────────────────────────────────────

searchToggleBtn.addEventListener('click', () => {
  searchVisible = !searchVisible;
  searchBar.classList.toggle('visible', searchVisible);
  searchToggleBtn.classList.toggle('active', searchVisible);
  if (searchVisible) { searchInput.focus(); }
  else { searchInput.value = ''; searchTerm = ''; renderNotes(); }
});

searchInput.addEventListener('input', () => {
  searchTerm = searchInput.value.trim().toLowerCase();
  renderNotes();
});

searchInput.addEventListener('keydown', e => {
  if (e.key === 'Escape') { searchToggleBtn.click(); noteInput.focus(); }
});

// ── Note CRUD ────────────────────────────────────────────────────────────────

function createNote(text, source) {
  const note = { id: Date.now() + '-' + Math.random(), text, timestamp: new Date().toISOString(), source, pinned: false };
  notes.unshift(note);
  return note;
}

function saveNotes() { window.floatnote.send('notes:save', notes); }

// ── Render ───────────────────────────────────────────────────────────────────

function renderNotes() {
  notesList.innerHTML = '';

  const visible = notes
    .filter(n => !searchTerm || n.text.toLowerCase().includes(searchTerm))
    .sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0));

  if (!visible.length) {
    const el = document.createElement('div');
    el.className   = 'empty-state';
    el.textContent = searchTerm ? 'No matches found' : 'Nothing here yet';
    notesList.appendChild(el);
    return;
  }

  visible.forEach(n => notesList.appendChild(buildCard(n)));
}

function buildCard(note) {
  const card = document.createElement('div');
  card.className = 'note-card' + (note.pinned ? ' pinned' : '');

  const deleteBtn = document.createElement('button');
  deleteBtn.className   = 'delete-btn';
  deleteBtn.textContent = '×';
  deleteBtn.addEventListener('click', e => { e.stopPropagation(); deleteNote(note.id); });

  const textEl = document.createElement('div');
  textEl.className = 'note-text';
  renderLinks(textEl, note.text);
  textEl.addEventListener('click', e => { if (!e.target.classList.contains('note-link')) makeEditable(textEl, note); });

  const meta   = document.createElement('div');
  meta.className = 'note-meta';

  const timeEl = document.createElement('span');
  timeEl.className   = 'note-time';
  timeEl.textContent = formatTime(note.timestamp);

  const badge = document.createElement('span');
  badge.className   = `note-badge badge-${note.source}`;
  badge.textContent = note.source;

  const pinBtn = document.createElement('button');
  pinBtn.className = 'icon-btn pin-btn' + (note.pinned ? ' is-pinned' : '');
  pinBtn.innerHTML  = note.pinned ? ICON_PIN_ON : ICON_PIN_OFF;
  pinBtn.title      = note.pinned ? 'Unpin' : 'Pin to top';
  pinBtn.addEventListener('click', e => {
    e.stopPropagation();
    note.pinned = !note.pinned;
    saveNotes(); renderNotes();
  });

  const copyBtn = document.createElement('button');
  copyBtn.className = 'icon-btn copy-btn';
  copyBtn.innerHTML = ICON_COPY;
  copyBtn.title     = 'Copy';
  copyBtn.addEventListener('click', e => {
    e.stopPropagation();
    window.floatnote.send('clipboard:skip', note.text);
    navigator.clipboard.writeText(note.text).then(() => {
      copyBtn.innerHTML = ICON_CHECK;
      copyBtn.classList.add('did-copy');
      setTimeout(() => { copyBtn.innerHTML = ICON_COPY; copyBtn.classList.remove('did-copy'); }, 800);
    });
  });

  meta.append(timeEl, badge, pinBtn, copyBtn);
  card.append(deleteBtn, textEl, meta);
  return card;
}

// ── Inline editing ───────────────────────────────────────────────────────────

function makeEditable(textEl, note) {
  if (textEl.contentEditable === 'true') return;

  const original  = note.text;
  let   committed = false;

  textEl.textContent    = original;
  textEl.contentEditable = 'true';
  textEl.classList.add('editing');
  textEl.focus();

  const range = document.createRange();
  range.selectNodeContents(textEl);
  range.collapse(false);
  window.getSelection().removeAllRanges();
  window.getSelection().addRange(range);

  function commit(cancel = false) {
    if (committed) return;
    committed = true;
    textEl.contentEditable = 'false';
    textEl.classList.remove('editing');
    if (!cancel) {
      const newText = textEl.innerText.replace(/\n+$/, '').trim();
      if (newText && newText !== original) { note.text = newText; saveNotes(); }
    }
    renderNotes();
  }

  textEl.addEventListener('blur',    () => commit(false));
  textEl.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); commit(false); }
    else if (e.key === 'Enter' && e.shiftKey) { e.preventDefault(); document.execCommand('insertText', false, '\n'); }
    else if (e.key === 'Escape') { e.preventDefault(); commit(true); }
  });
}

// ── URL rendering ────────────────────────────────────────────────────────────

function renderLinks(container, text) {
  container.innerHTML = '';
  text.split(/(https?:\/\/[^\s]+)/gi).forEach((part, i) => {
    if (i % 2 === 1) {
      const span = document.createElement('span');
      span.className   = 'note-link';
      span.textContent = part;
      span.addEventListener('click', e => { e.stopPropagation(); window.floatnote.send('shell:open', part); });
      container.appendChild(span);
    } else if (part) {
      container.appendChild(document.createTextNode(part));
    }
  });
}

// ── Delete with undo ─────────────────────────────────────────────────────────

function deleteNote(id) {
  if (pendingDelete) { clearTimeout(pendingDelete.timer); saveNotes(); }

  const index = notes.findIndex(n => n.id === id);
  if (index === -1) return;

  const [note] = notes.splice(index, 1);
  renderNotes();

  const timer = setTimeout(() => { pendingDelete = null; saveNotes(); hideUndo(); }, 3000);
  pendingDelete = { note, index, timer };
  showUndo();
}

undoBtn.addEventListener('click', () => {
  if (!pendingDelete) return;
  clearTimeout(pendingDelete.timer);
  notes.splice(pendingDelete.index, 0, pendingDelete.note);
  pendingDelete = null;
  hideUndo();
  renderNotes();
});

function showUndo() { undoToast.classList.add('visible'); }
function hideUndo() { undoToast.classList.remove('visible'); }

// ── Timestamp ────────────────────────────────────────────────────────────────

function formatTime(iso) {
  const d   = new Date(iso);
  const now = new Date();
  const hh  = String(d.getHours()).padStart(2, '0');
  const mm  = String(d.getMinutes()).padStart(2, '0');
  const sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  return sameDay ? `Today ${hh}:${mm}` : `${'Sun Mon Tue Wed Thu Fri Sat'.split(' ')[d.getDay()]} ${hh}:${mm}`;
}

// ── Voice (Python owns mic + VAD + Whisper, we just handle transcripts) ───────

let voiceState   = 'idle';
let commandTimer = null;

function setDot(state) { if (voiceDot) voiceDot.className = state; }
setDot('loading');

window.floatnote.receive('whisper:ready', () => setDot('idle'));

window.floatnote.receive('whisper:transcript', transcript => {
  handleVoiceInput(transcript.toLowerCase().trim());
});

function handleVoiceInput(heard) {
  if (voiceState === 'idle') {
    if (!heard.includes('bunny')) return;

    voiceState = 'awake';
    setDot('awake');
    window.floatnote.send('window:expand');

    // Command in same breath: "bunny add buy milk"
    const rest = heard.slice(heard.indexOf('bunny') + 5).replace(/^[\s,]+/, '');
    if (rest.length > 1) { runCommand(rest); return; }

    clearTimeout(commandTimer);
    commandTimer = setTimeout(() => { voiceState = 'idle'; setDot('idle'); }, 5000);

  } else if (voiceState === 'awake') {
    clearTimeout(commandTimer);
    runCommand(heard);
  }
}

function runCommand(text) {
  voiceState = 'idle';

  const m = text.match(/^(?:note|add|write|save|capture|remember|jot(?:\s+down)?)\s+(.+)$/i);
  if (m) {
    createNote(m[1].trim(), 'voice');
    renderNotes(); saveNotes();
    setDot('success');
    setTimeout(() => { setDot('idle'); window.floatnote.send('window:collapse'); }, 2000);
    return;
  }

  if (/\b(hide|close|collapse|minimize)\b/.test(text)) {
    window.floatnote.send('window:collapse'); setDot('idle'); return;
  }

  setDot('error');
  setTimeout(() => setDot('idle'), 1500);
}
