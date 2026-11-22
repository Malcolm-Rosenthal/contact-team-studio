import './style.css';
import { createStudioEditor } from './editor';
import { markdownToTiptapJSON, type BibleEntry, type OutlineType } from './markdown';
import {
  loadConfig,
  saveConfig,
  getLocalFile,
  saveLocalFile,
  syncAll,
  resolveConflict,
} from './sync';
import {
  parseSections,
  serializeSections,
  getSubtreeEnd,
  extractResearch,
  calculateWavefront,
  type StatSnapshot,
} from './stats';

type DrawerTab = 'outline' | 'research' | 'bible' | 'stats' | null;

// --- APP STATE ---
let currentMd = '';
let bibleEntries: BibleEntry[] = [];
let statHistory: StatSnapshot[] = [];
let activeDrawer: DrawerTab = null;
let isRawMode = false;
let bibleCategoryFilter = 'All';
let saveTimer: number | undefined;
let dragSourceIdx: number | null = null;

// --- THEME ---
const savedTheme = localStorage.getItem('contact-team-theme') || 'warm';
document.documentElement.dataset.theme = savedTheme;

// --- SHELL MARKUP ---
document.querySelector<HTMLDivElement>('#app')!.innerHTML = `
  <header class="topbar">
    <div class="topbar-left">
      <button class="icon-btn" id="btn-outline" title="Outline">Outline</button>
      <button class="icon-btn" id="btn-research" title="Research">Research <span class="badge" id="badge-research">0</span></button>
      <button class="icon-btn" id="btn-bible" title="Story Bible">Bible</button>
      <button class="icon-btn" id="btn-stats" title="Wavefront Stats">Stats</button>
    </div>
    <div class="topbar-right">
      <button class="icon-btn" id="btn-raw" title="Toggle Raw Markdown">MD</button>
      <button class="icon-btn" id="btn-theme" title="Switch Theme">${savedTheme === 'nocturne' ? '☀' : '☾'}</button>
      <button class="sync-btn" id="btn-sync" title="Sync with GitHub">Idle</button>
      <button class="icon-btn" id="btn-config" title="GitHub Settings">⚙</button>
    </div>
  </header>

  <div class="workspace">
    <main class="canvas-wrap">
      <div id="editor" class="editor-surface"></div>
      <textarea id="raw-editor" class="raw-surface hidden" spellcheck="true"></textarea>
    </main>

    <aside id="drawer" class="drawer hidden">
      <div class="drawer-header">
        <span id="drawer-title"></span>
        <button class="icon-btn" id="btn-close-drawer">✕</button>
      </div>
      <div id="drawer-body" class="drawer-body"></div>
    </aside>
  </div>
`;

const syncBtn = document.querySelector<HTMLButtonElement>('#btn-sync')!;
const rawEl = document.querySelector<HTMLTextAreaElement>('#raw-editor')!;
const editorEl = document.querySelector<HTMLDivElement>('#editor')!;
const drawerEl = document.querySelector<HTMLElement>('#drawer')!;
const drawerTitle = document.querySelector<HTMLSpanElement>('#drawer-title')!;
const drawerBody = document.querySelector<HTMLDivElement>('#drawer-body')!;
const researchBadge = document.querySelector<HTMLSpanElement>('#badge-research')!;

// --- TIPTAP EDITOR ---
const editor = createStudioEditor({
  element: editorEl,
  initialMarkdown: '',
  getBibleEntries: () => bibleEntries,
  onChange: (md) => {
    currentMd = md;
    scheduleSave();
  },
});

function refreshBibleHighlights() {
  editor.view.dispatch(editor.state.tr.setMeta('refreshBible', true));
}

function setManuscriptContent(md: string, markDirty = true) {
  currentMd = md;
  editor.commands.setContent(markdownToTiptapJSON(md), { emitUpdate: false });
  rawEl.value = md;
  updateBadges();
  if (activeDrawer) renderDrawer();
  if (markDirty) scheduleSave();
}

function scheduleSave() {
  syncBtn.textContent = 'Unsynced';
  syncBtn.classList.add('dirty');
  updateBadges();
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(async () => {
    await saveLocalFile('manuscript.md', currentMd);
  }, 400);
}

function updateBadges() {
  const count = extractResearch(currentMd).length;
  researchBadge.textContent = String(count);
  researchBadge.style.display = count > 0 ? 'inline-block' : 'none';
}

// --- RAW MARKDOWN TOGGLE ---
rawEl.addEventListener('input', () => {
  currentMd = rawEl.value;
  scheduleSave();
});

document.querySelector('#btn-raw')!.addEventListener('click', (e) => {
  isRawMode = !isRawMode;
  (e.currentTarget as HTMLButtonElement).classList.toggle('active', isRawMode);

  if (isRawMode) {
    const maxScroll = Math.max(1, document.documentElement.scrollHeight - window.innerHeight);
    const ratio = window.scrollY / maxScroll;

    rawEl.value = currentMd;
    editorEl.classList.add('hidden');
    rawEl.classList.remove('hidden');

    requestAnimationFrame(() => {
      const targetScroll = Math.round(ratio * Math.max(0, rawEl.scrollHeight - rawEl.clientHeight));
      rawEl.scrollTop = targetScroll;
      window.scrollTo(0, 0);
    });
  } else {
    const maxRawScroll = Math.max(1, rawEl.scrollHeight - rawEl.clientHeight);
    const ratio = rawEl.scrollTop / maxRawScroll;

    editor.commands.setContent(markdownToTiptapJSON(currentMd), { emitUpdate: false });
    rawEl.classList.add('hidden');
    editorEl.classList.remove('hidden');

    requestAnimationFrame(() => {
      const maxDocScroll = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
      window.scrollTo(0, Math.round(ratio * maxDocScroll));
    });
  }
});

// --- THEME TOGGLE ---
document.querySelector('#btn-theme')!.addEventListener('click', (e) => {
  const next = document.documentElement.dataset.theme === 'nocturne' ? 'warm' : 'nocturne';
  document.documentElement.dataset.theme = next;
  localStorage.setItem('contact-team-theme', next);
  (e.currentTarget as HTMLButtonElement).textContent = next === 'nocturne' ? '☀' : '☾';
});

// --- DRAWER ROUTING ---
function toggleDrawer(tab: DrawerTab) {
  activeDrawer = activeDrawer === tab ? null : tab;
  drawerEl.classList.toggle('hidden', !activeDrawer);
  ['outline', 'research', 'bible', 'stats'].forEach((t) => {
    document.querySelector(`#btn-${t}`)!.classList.toggle('active', activeDrawer === t);
  });
  if (activeDrawer) renderDrawer();
}

document.querySelector('#btn-outline')!.addEventListener('click', () => toggleDrawer('outline'));
document.querySelector('#btn-research')!.addEventListener('click', () => toggleDrawer('research'));
document.querySelector('#btn-bible')!.addEventListener('click', () => toggleDrawer('bible'));
document.querySelector('#btn-stats')!.addEventListener('click', () => toggleDrawer('stats'));
document.querySelector('#btn-close-drawer')!.addEventListener('click', () => toggleDrawer(null));

function renderDrawer() {
  if (activeDrawer === 'outline') renderOutlineDrawer();
  else if (activeDrawer === 'research') renderResearchDrawer();
  else if (activeDrawer === 'bible') renderBibleDrawer();
  else if (activeDrawer === 'stats') renderStatsDrawer();
}

// --- 1. OUTLINE DRAWER ---
function renderOutlineDrawer() {
  drawerTitle.textContent = 'Outline';
  const { preamble, sections } = parseSections(currentMd);

  drawerBody.innerHTML = `
    <div class="drawer-controls">
      <select id="add-sec-type">
        <option value="part">Part</option>
        <option value="chapter" selected>Chapter</option>
        <option value="scene">Scene</option>
        <option value="beat">Beat</option>
        <option value="sub-beat">Sub-Beat</option>
      </select>
      <input id="add-sec-name" type="text" placeholder="New section title..." />
      <button class="btn-primary" id="btn-add-sec">+</button>
    </div>
    <div class="outline-list" id="outline-list"></div>
  `;

  document.querySelector('#btn-add-sec')!.addEventListener('click', () => {
    const type = (document.querySelector('#add-sec-type') as HTMLSelectElement).value as OutlineType;
    const nameInput = document.querySelector('#add-sec-name') as HTMLInputElement;
    const name = nameInput.value.trim();
    if (!name) return;
    const nextMd = `${currentMd.trim()}\n\n[[${type}/${name}]]\n`;
    setManuscriptContent(nextMd);
  });

  const list = document.querySelector('#outline-list')!;
  sections.forEach((sec, idx) => {
    const card = document.createElement('div');
    card.className = `outline-card level-${sec.level}`;
    card.draggable = true;
    card.dataset.idx = String(idx);

    const label =
      sec.type === 'part'
        ? `P${sec.displayNumber}`
        : sec.type === 'chapter'
        ? `Ch ${sec.displayNumber}`
        : sec.type;

    card.innerHTML = `
      <span class="drag-handle" title="Drag to reorder">⋮⋮</span>
      <span class="type-pill type-${sec.type}">${label}</span>
      <span class="sec-name" title="Click to jump">${escapeHtml(sec.name)}</span>
      <span class="sec-words">${sec.cumulativeWords.toLocaleString()}w</span>
      <button class="mini-btn btn-rename" title="Rename">✎</button>
      <button class="mini-btn btn-del" title="Remove heading (keeps prose)">✕</button>
    `;

    // Jump to heading in editor
    card.querySelector('.sec-name')!.addEventListener('click', () => jumpToHeading(idx));

    // Rename
    card.querySelector('.btn-rename')!.addEventListener('click', () => {
      const nextName = prompt(`Rename ${sec.type}:`, sec.name);
      if (!nextName || nextName.trim() === sec.name) return;
      sections[idx].name = nextName.trim();
      setManuscriptContent(serializeSections(preamble, sections));
    });

    // Non-destructive delete (folds prose into previous section)
    card.querySelector('.btn-del')!.addEventListener('click', () => {
      if (!confirm(`Remove "${sec.name}" heading? Your prose will be kept.`)) return;
      if (idx === 0) {
        preamble.push(...sec.bodyBlocks);
      } else {
        sections[idx - 1].bodyBlocks.push(...sec.bodyBlocks);
      }
      sections.splice(idx, 1);
      setManuscriptContent(serializeSections(preamble, sections));
    });

    // Drag & Drop (moves section + all nested children)
    card.addEventListener('dragstart', () => {
      dragSourceIdx = idx;
      card.classList.add('dragging');
    });
    card.addEventListener('dragend', () => {
      dragSourceIdx = null;
      card.classList.remove('dragging');
    });
    card.addEventListener('dragover', (e) => {
      e.preventDefault();
      card.classList.add('drag-over');
    });
    card.addEventListener('dragleave', () => card.classList.remove('drag-over'));
    card.addEventListener('drop', (e) => {
      e.preventDefault();
      card.classList.remove('drag-over');
      if (dragSourceIdx === null || dragSourceIdx === idx) return;

      const subEnd = getSubtreeEnd(sections, dragSourceIdx);
      // Prevent dropping a parent inside its own children
      if (idx >= dragSourceIdx && idx < subEnd) return;

      const moved = sections.splice(dragSourceIdx, subEnd - dragSourceIdx);
      const insertAt = idx > dragSourceIdx ? idx - moved.length : idx;
      sections.splice(insertAt, 0, ...moved);
      setManuscriptContent(serializeSections(preamble, sections));
    });

    list.appendChild(card);
  });
}

function jumpToHeading(headingIndex: number) {
  if (isRawMode) return;
  let seen = 0;
  let targetPos: number | null = null;
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name === 'outlineHeading') {
      if (seen === headingIndex) targetPos = pos + 1;
      seen++;
    }
  });
  if (targetPos !== null) {
    editor.chain().focus().setTextSelection(targetPos).scrollIntoView().run();
  }
}

// --- 2. RESEARCH DRAWER ---
function renderResearchDrawer() {
  drawerTitle.textContent = 'Research Queue';
  const items = extractResearch(currentMd);

  if (items.length === 0) {
    drawerBody.innerHTML = `<p class="empty-state">No [bracketed] research items right now.</p>`;
    return;
  }

  drawerBody.innerHTML = '';
  items.forEach((item) => {
    const card = document.createElement('div');
    card.className = 'research-card';
    card.innerHTML = `
      <div class="res-meta">${escapeHtml(item.breadcrumb)}</div>
      <div class="res-term">[${escapeHtml(item.term)}]</div>
      <div class="res-context">${escapeHtml(item.context)}</div>
      <div class="res-resolve">
        <input type="text" class="res-input" placeholder="Replacement text..." value="${escapeHtml(item.term)}" />
        <label class="res-bible-check">
          <input type="checkbox" class="res-add-bible" /> Add to Story Bible
        </label>
        <div class="res-bible-extra hidden">
          <select class="res-bible-cat">
            <option>Character</option>
            <option>Place</option>
            <option>Slang</option>
            <option>Vessel / Tech</option>
            <option>Other</option>
          </select>
          <input type="text" class="res-bible-note" placeholder="1-sentence note..." />
        </div>
        <div class="res-actions">
          <button class="btn-secondary btn-jump">Jump</button>
          <button class="btn-primary btn-apply">Resolve</button>
        </div>
      </div>
    `;

    const check = card.querySelector<HTMLInputElement>('.res-add-bible')!;
    const extra = card.querySelector<HTMLDivElement>('.res-bible-extra')!;
    check.addEventListener('change', () => extra.classList.toggle('hidden', !check.checked));

    card.querySelector('.btn-jump')!.addEventListener('click', () => {
      jumpToText(item.term);
    });

    card.querySelector('.btn-apply')!.addEventListener('click', async () => {
      const replacement = card.querySelector<HTMLInputElement>('.res-input')!.value.trim();
      if (!replacement) return;

      // Replace the exact nth occurrence of [item.term] in currentMd
      const escaped = item.term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp(`(?<!\\[)\\[${escaped}\\](?!\\]|\\()`, 'g');
      let seen = 0;
      const updated = currentMd.replace(re, (m) => {
        if (seen++ === item.occurrenceIndex) return replacement;
        return m;
      });

      if (check.checked) {
        const cat = card.querySelector<HTMLSelectElement>('.res-bible-cat')!.value;
        const note = card.querySelector<HTMLInputElement>('.res-bible-note')!.value.trim();
        await addBibleEntry(replacement, '', cat, note);
      }

      setManuscriptContent(updated);
    });

    drawerBody.appendChild(card);
  });
}

function jumpToText(needle: string) {
  if (isRawMode) return;
  let targetPos: number | null = null;
  editor.state.doc.descendants((node, pos) => {
    if (targetPos !== null) return;
    if (node.isText && node.text) {
      const idx = node.text.indexOf(needle);
      if (idx !== -1) targetPos = pos + idx;
    }
  });
  if (targetPos !== null) {
    editor.chain().focus().setTextSelection(targetPos).scrollIntoView().run();
  }
}

// --- 3. STORY BIBLE DRAWER ---
async function addBibleEntry(term: string, aliasesStr: string, category: string, notes: string) {
  const aliases = aliasesStr
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  bibleEntries.push({
    id: crypto.randomUUID(),
    term: term.trim(),
    aliases,
    category,
    notes: notes.trim(),
  });
  await saveLocalFile('bible.json', JSON.stringify(bibleEntries, null, 2));
  syncBtn.textContent = 'Unsynced';
  syncBtn.classList.add('dirty');
  refreshBibleHighlights();
}

function renderBibleDrawer() {
  drawerTitle.textContent = 'Story Bible';
  const categories = ['All', ...Array.from(new Set(bibleEntries.map((e) => e.category)))];
  const filtered =
    bibleCategoryFilter === 'All'
      ? bibleEntries
      : bibleEntries.filter((e) => e.category === bibleCategoryFilter);

  drawerBody.innerHTML = `
    <div class="bible-form">
      <input id="bible-term" type="text" placeholder="Canonical term (e.g. Yark)" />
      <input id="bible-aliases" type="text" placeholder="Aliases, comma-separated (optional)" />
      <div class="bible-form-row">
        <select id="bible-cat">
          <option>Character</option>
          <option>Place</option>
          <option>Slang</option>
          <option>Vessel / Tech</option>
          <option>Other</option>
        </select>
        <button class="btn-primary" id="btn-add-bible">Add</button>
      </div>
      <input id="bible-notes" type="text" placeholder="Short note..." />
    </div>
    <div class="filter-pills" id="bible-filters"></div>
    <div class="bible-list" id="bible-list"></div>
  `;

  document.querySelector('#btn-add-bible')!.addEventListener('click', async () => {
    const term = (document.querySelector('#bible-term') as HTMLInputElement).value.trim();
    if (!term) return;
    const aliases = (document.querySelector('#bible-aliases') as HTMLInputElement).value;
    const cat = (document.querySelector('#bible-cat') as HTMLSelectElement).value;
    const notes = (document.querySelector('#bible-notes') as HTMLInputElement).value;
    await addBibleEntry(term, aliases, cat, notes);
    renderBibleDrawer();
  });

  const filterBar = document.querySelector('#bible-filters')!;
  categories.forEach((cat) => {
    const pill = document.createElement('button');
    pill.className = `pill ${bibleCategoryFilter === cat ? 'active' : ''}`;
    pill.textContent = cat;
    pill.addEventListener('click', () => {
      bibleCategoryFilter = cat;
      renderBibleDrawer();
    });
    filterBar.appendChild(pill);
  });

  const list = document.querySelector('#bible-list')!;
  filtered.forEach((entry) => {
    const terms = [entry.term, ...entry.aliases].map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    const count = (currentMd.match(new RegExp(`\\b(${terms.join('|')})\\b`, 'gi')) || []).length;

    const card = document.createElement('div');
    card.className = 'bible-card';
    card.innerHTML = `
      <div class="bible-card-top">
        <strong>${escapeHtml(entry.term)}</strong>
        <span class="bible-cat">${escapeHtml(entry.category)} · ${count}×</span>
        <button class="mini-btn btn-del-bible" title="Delete">✕</button>
      </div>
      ${entry.aliases.length ? `<div class="bible-aliases">aka ${escapeHtml(entry.aliases.join(', '))}</div>` : ''}
      <div class="bible-notes">${escapeHtml(entry.notes)}</div>
    `;

    card.querySelector('.btn-del-bible')!.addEventListener('click', async () => {
      bibleEntries = bibleEntries.filter((e) => e.id !== entry.id);
      await saveLocalFile('bible.json', JSON.stringify(bibleEntries, null, 2));
      syncBtn.textContent = 'Unsynced';
      syncBtn.classList.add('dirty');
      refreshBibleHighlights();
      renderBibleDrawer();
    });

    list.appendChild(card);
  });
}

// --- 4. WAVEFRONT STATS DRAWER ---
function renderStatsDrawer() {
  drawerTitle.textContent = 'Wavefront Stats';
  const s = calculateWavefront(currentMd);

  drawerBody.innerHTML = `
    <div class="stat-card">
      <div class="stat-label">Projected Final Count</div>
      <div class="stat-big">${s.projectedFinalCount.toLocaleString()}</div>
      <div class="stat-sub">${s.totalChapters} chapters × ${s.avgChapterWords.toLocaleString()} avg words</div>
    </div>
    <div class="stat-grid">
      <div class="stat-card">
        <div class="stat-label">Total Words</div>
        <div class="stat-val">${s.totalWords.toLocaleString()}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Finish Date</div>
        <div class="stat-val">${s.projectedFinishDate}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Chapters Done</div>
        <div class="stat-val">${s.completedChapters} / ${s.totalChapters}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Pace</div>
        <div class="stat-val">${s.pacePerDay.toLocaleString()} w/day</div>
      </div>
    </div>
    <div class="stat-sub" style="margin-top:12px;">
      Backbone locked to <strong>Chapter</strong> · ${statHistory.length} snapshots logged in <code>stats.json</code>
    </div>
  `;
}

// --- SYNC & BOOT ---
async function loadFromLocal() {
  const ms = await getLocalFile('manuscript.md');
  const bible = await getLocalFile('bible.json');
  const stats = await getLocalFile('stats.json');

  if (bible?.content) {
    try { bibleEntries = JSON.parse(bible.content); } catch { bibleEntries = []; }
  }
  if (stats?.content) {
    try { statHistory = JSON.parse(stats.content); } catch { statHistory = []; }
  }
  if (ms?.content !== undefined) {
    setManuscriptContent(ms.content, false);
    refreshBibleHighlights();
  }
}

async function runSync() {
  if (!loadConfig()) {
    syncBtn.textContent = 'Setup ⚙';
    return;
  }

  // Record a stats snapshot if word count changed since last snapshot
  const wf = calculateWavefront(currentMd);
  const lastSnap = statHistory[statHistory.length - 1];
  if (wf.totalWords > 0 && (!lastSnap || lastSnap.totalWords !== wf.totalWords)) {
    statHistory.push({
      timestamp: new Date().toISOString(),
      totalWords: wf.totalWords,
      totalChapters: wf.totalChapters,
      avgChapterWords: wf.avgChapterWords,
      projectedFinalCount: wf.projectedFinalCount,
      projectedFinishDate: wf.projectedFinishDate,
    });
    await saveLocalFile('stats.json', JSON.stringify(statHistory, null, 2));
  }

  syncBtn.textContent = 'Syncing…';
  const res = await syncAll();

  if (res.status === 'synced') {
    await loadFromLocal();
    syncBtn.textContent = 'Synced ✓';
    syncBtn.classList.remove('dirty');
  } else if (res.status === 'offline') {
    syncBtn.textContent = 'Offline';
  } else if (res.status === 'conflict') {
    syncBtn.textContent = 'Conflict!';
    for (const c of res.conflicts) {
      const choice = prompt(
        `Conflict in ${c.path}. Type: pull, force-push, or save-copy`,
        'save-copy'
      );
      if (choice === 'pull' || choice === 'force-push' || choice === 'save-copy') {
        await resolveConflict(c, choice);
      }
    }
    await loadFromLocal();
    syncBtn.textContent = 'Synced ✓';
    syncBtn.classList.remove('dirty');
  } else if (res.status === 'error') {
    syncBtn.textContent = 'Sync Error';
    alert(res.message);
  }
}

document.querySelector('#btn-sync')!.addEventListener('click', runSync);
document.querySelector('#btn-config')!.addEventListener('click', () => {
  const existing = loadConfig();
  const owner = prompt('GitHub username:', existing?.owner || '');
  const repo = prompt('Data repo name:', existing?.repo || 'contact-team-data');
  const token = prompt('Fine-grained PAT:', existing?.token || '');
  if (owner && repo && token) {
    saveConfig({ owner: owner.trim(), repo: repo.trim(), branch: 'main', token: token.trim() });
    runSync();
  }
});

// Auto-sync when returning to the app (essential for iOS subway workflow)
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && loadConfig()) {
    runSync();
  }
});

function escapeHtml(str: string): string {
  return str.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

loadFromLocal().then(() => {
  if (loadConfig()) runSync();
});