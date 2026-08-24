const EMPTY_DIAGRAM = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
  xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI"
  xmlns:dc="http://www.omg.org/spec/DD/20100524/DC"
  xmlns:camunda="http://camunda.org/schema/1.0/bpmn"
  id="Definitions_1" targetNamespace="http://bpmn.io/schema/bpmn">
  <bpmn:process id="Process_1" isExecutable="false" />
  <bpmndi:BPMNDiagram id="BPMNDiagram_1">
    <bpmndi:BPMNPlane id="BPMNPlane_1" bpmnElement="Process_1" />
  </bpmndi:BPMNDiagram>
</bpmn:definitions>`;

let modeler;
let xmlPanelVisible = false;

// Navigation stack: [{rootEl, label, viewport}]
let navStack = [];
// Name of the current file (without extension)
let currentFilename = '';

// Which subprocess nodes in the "Process structure" tree are collapsed
// (their children hidden), keyed by businessObject id. Plain in-memory
// state — not persisted to localStorage or the file — so it resets on
// import/new file the same way the rest of the navigation state does; a
// long-lived diagram someone keeps reopening could get this later if it
// turns out to matter in practice.
let collapsedTreeIds = new Set();

/* ─── AUTO-ZAPIS ─── */
// Handle (FileSystemFileHandle) to the file on disk, if the file was opened/saved
// through the native picker (File System Access API). Without it we can't save
// "silently" — the browser always has to ask for a location.
let currentFileHandle = null;
let hasUnsavedChanges = false;
let autosaveEnabled = true;
let autosaveTimer = null;
const AUTOSAVE_DELAY_MS = 2000; // save 2s after the last change (debounce)

/* ─── REMEMBERING THE LAST OPENED FILE (auto-load after F5) ───
   A FileSystemFileHandle can't be serialized to JSON/localStorage, but
   IndexedDB can remember it (structured clone). After a page reload we
   silently try to regain access (queryPermission) and reload the same
   file; if the browser requires explicit confirmation (needs a user
   gesture), we show a small prompt instead of guessing. */
const LAST_FILE_HANDLE_DB = 'bpmnEditorDB';
const LAST_FILE_HANDLE_STORE = 'handles';
const LAST_FILE_HANDLE_KEY = 'lastFileHandle';

function openHandleDb() {
  return new Promise((resolve, reject) => {
    if (!window.indexedDB) { reject(new Error('IndexedDB unavailable')); return; }
    const req = indexedDB.open(LAST_FILE_HANDLE_DB, 1);
    req.onupgradeneeded = () => { req.result.createObjectStore(LAST_FILE_HANDLE_STORE); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function rememberLastFileHandle(handle) {
  try {
    const db = await openHandleDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(LAST_FILE_HANDLE_STORE, 'readwrite');
      tx.objectStore(LAST_FILE_HANDLE_STORE).put(handle, LAST_FILE_HANDLE_KEY);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch (e) {}
}

async function forgetLastFileHandle() {
  try {
    const db = await openHandleDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(LAST_FILE_HANDLE_STORE, 'readwrite');
      tx.objectStore(LAST_FILE_HANDLE_STORE).delete(LAST_FILE_HANDLE_KEY);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch (e) {}
}

async function getLastFileHandle() {
  try {
    const db = await openHandleDb();
    const handle = await new Promise((resolve, reject) => {
      const tx = db.transaction(LAST_FILE_HANDLE_STORE, 'readonly');
      const req = tx.objectStore(LAST_FILE_HANDLE_STORE).get(LAST_FILE_HANDLE_KEY);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
    db.close();
    return handle;
  } catch (e) {
    return null;
  }
}

// Handle waiting for explicit user confirmation (see showRestoreFileBanner).
let pendingRestoreHandle = null;

async function restoreLastFileOrNew() {
  let handle = null;
  try { handle = await getLastFileHandle(); } catch (e) { handle = null; }
  if (!handle) { await newDiagram(); return; }

  try {
    const perm = await handle.queryPermission({ mode: 'readwrite' });
    if (perm === 'granted') {
      const file = await handle.getFile();
      const text = await file.text();
      currentFileHandle = handle;
      await importXml(text, file.name);
      updateAutosaveIndicator();
      return;
    }
    // The browser requires an explicit user gesture to re-grant
    // access — we don't block startup, just show a one-time prompt.
    pendingRestoreHandle = handle;
    showRestoreFileBanner(handle.name);
    await newDiagram();
  } catch (e) {
    // Handle is stale (file moved/deleted, etc.) — forget it.
    await forgetLastFileHandle();
    await newDiagram();
  }
}

function showRestoreFileBanner(name) {
  const banner = document.getElementById('restore-file-banner');
  const label = document.getElementById('restore-file-label');
  if (!banner || !label) return;
  label.textContent = 'Restore last file "' + name + '"?';
  banner.style.display = 'inline-flex';
}

function dismissRestoreLastFile() {
  pendingRestoreHandle = null;
  const banner = document.getElementById('restore-file-banner');
  if (banner) banner.style.display = 'none';
}

async function confirmRestoreLastFile() {
  const handle = pendingRestoreHandle;
  if (!handle) return;
  try {
    const perm = await handle.requestPermission({ mode: 'readwrite' });
    if (perm !== 'granted') {
      setStatus('No access to the file', 'err');
      dismissRestoreLastFile();
      return;
    }
    const file = await handle.getFile();
    const text = await file.text();
    currentFileHandle = handle;
    await importXml(text, file.name);
    updateAutosaveIndicator();
    dismissRestoreLastFile();
  } catch (e) {
    setStatus('Could not restore the file: ' + e.message, 'err');
    dismissRestoreLastFile();
  }
}

async function closeFile() {
  await newDiagram();
  currentFileHandle = null;
  currentFilename = '';
  document.getElementById('filename-input').value = 'diagram';
  await forgetLastFileHandle();
  updateAutosaveIndicator();
  // newDiagram() already refreshed the breadcrumb/tree, but it did so before
  // we reset currentFilename above — refresh again so the tree label doesn't
  // keep showing the just-closed file's name.
  updateBreadcrumb();
  updateTree();
  setStatus('Closed', '');
}

function setStatus(msg, type) {
  const el = document.getElementById('status');
  el.textContent = msg;
  el.className = type || '';
}

/* ─── NAWIGACJA ─── */

function getCurrentRoot() {
  return modeler.get('canvas').getRootElement();
}

// elementRegistry.getAll() returns EVERY element across the WHOLE diagram —
// including ones that live on other planes entirely (e.g. shapes inside an
// expanded sub-process you're not currently looking at). Badge/overlay code
// that needs "what's actually on screen right now" should walk from the
// current root instead, since that's the only thing scoped to the active
// plane. bpmn-js keeps each plane's shapes in a normal parent/children tree
// under that plane's root, so this recursion naturally stays within it.
//
// The root itself is deliberately excluded: after drilling into a
// sub-process, canvas.getRootElement() returns a plane root whose
// businessObject IS that sub-process (e.g. "FULFILLMENT") — it's the
// container you're now standing inside, not a shape rendered on this plane.
// Including it re-added that sub-process's own System/Location badge onto
// its own (otherwise empty) inner canvas.
function getElementsInCurrentPlane() {
  const root = getCurrentRoot();
  if (!root) return [];
  const result = [];
  (function walk(el) {
    (el.children || []).forEach(child => {
      result.push(child);
      walk(child);
    });
  })(root);
  return result;
}

function navigateTo(rootEl, label) {
  if (getCurrentRoot() === rootEl) return;
  const vp = modeler.get('canvas').viewbox();
  navStack.push({ rootEl: getCurrentRoot(), label: getBreadcrumbLabel(getCurrentRoot()), viewport: vp });
  modeler.get('canvas').setRootElement(rootEl);
  fitViewport();
  updateBreadcrumb();
  updateTree();
}

// navStack normally gets built up by treeNavigateTo()/navigateTo() as you
// deliberately drill in via OUR OWN navigation UI (the Process structure
// tree, the "Enter subprocess" button). But bpmn-js ships its own built-in
// drilldown affordance too — the small arrow overlay on a collapsed
// sub-process shape — which calls canvas.setRootElement() directly, with no
// way for us to intercept it and push onto navStack first. Left alone, that
// left our custom breadcrumb bar rendering with an empty navStack (no "Back
// to" button, no parent trail — just the current level's name floating
// alone), while bpmn-js's OWN separate native breadcrumbs element rendered
// its own (differently-styled, unhidden) trail on top of the canvas —
// hence the two different-looking bars the same navigation could produce.
//
// Fix: whenever the plane actually changes, for ANY reason, rebuild
// navStack from the model itself (same ancestor-walk findPathToSubprocess()
// already does for tree navigation) rather than trusting whatever
// push/pop bookkeeping the triggering code did or didn't do. Called from
// the 'root.set' handler below, so it runs after every navigation — including
// clicks on bpmn-js's own drilldown arrow.
function rebuildNavStack() {
  const currentRoot = getCurrentRoot();
  if (!currentRoot) { navStack = []; return; }
  const bo = currentRoot.businessObject;
  if (!bo || bo.$type === 'bpmn:Process' || bo.$type === 'bpmn:Collaboration') {
    navStack = [];
    return;
  }

  const planes = modeler.get('canvas')._planes || [];
  const path = findPathToSubprocess(bo);
  const oldStack = navStack;

  navStack = path.map(ancestorBo => {
    // The top-of-path entry is always a bpmn:Process — see
    // findPathToSubprocess() — and whichever participant/pool it belongs
    // to, its flow nodes are drawn directly on the shared collaboration
    // plane (there's no dedicated plane per pool), so resolve it via
    // findProcessRoot() instead of a plane lookup either way.
    const rootEl = (ancestorBo.$type === 'bpmn:Process')
      ? findProcessRoot()
      : (function() {
          const plane = planes.find(p => p.rootElement && p.rootElement.businessObject === ancestorBo);
          return plane ? plane.rootElement : null;
        })();
    // Reuse a remembered viewport for this level if we have one (e.g. from
    // treeNavigateTo() having just captured it), so drilling in via the
    // canvas arrow doesn't discard scroll/zoom state tracked elsewhere.
    const existingEntry = oldStack.find(x => x.rootEl === rootEl);
    return {
      rootEl,
      label: ancestorBo.name || ancestorBo.id || '?',
      viewport: existingEntry ? existingEntry.viewport : null
    };
  }).filter(x => x.rootEl !== null);
}

function navigateToIndex(stackIndex) {
  let target;
  if (stackIndex < 0) {
    target = navStack[0];
    navStack = [];
  } else {
    target = navStack[stackIndex];
    navStack = navStack.slice(0, stackIndex);
  }
  modeler.get('canvas').setRootElement(target.rootEl);
  if (target.viewport) {
    modeler.get('canvas').viewbox(target.viewport);
  } else {
    fitViewport();
  }
  updateBreadcrumb();
  updateTree();
}

function getProcessDisplayName() {
  // Use the filename if available, otherwise fall back to the ID
  return currentFilename || 'Main process';
}

function getBreadcrumbLabel(rootEl) {
  if (!rootEl) return '?';
  const bo = rootEl.businessObject;
  if (!bo) return rootEl.id || '?';
  // bpmn:Collaboration is the top-level root for pool/lane-wrapped files —
  // see findProcessRoot() — and represents the same "Main process" level.
  if (bo.$type === 'bpmn:Process' || bo.$type === 'bpmn:Collaboration') return getProcessDisplayName();
  return bo.name || bo.id || 'Subprocess';
}

function updateBreadcrumb() {
  const bc = document.getElementById('breadcrumb');
  const currentRoot = getCurrentRoot();
  const isSubProcess = currentRoot && currentRoot.businessObject &&
    currentRoot.businessObject.$type === 'bpmn:SubProcess';

  if (!isSubProcess && navStack.length === 0) {
    bc.classList.remove('visible');
    bc.innerHTML = '';
    return;
  }

  bc.classList.add('visible');
  // Static label, matching the Process structure panel's own header (just
  // not upper-cased — this is a plain trail, not a section title). No
  // "Back to: X" button: every ancestor name below is already clickable
  // (navigateToIndex), so a dedicated back button was just a second,
  // redundant way to do exactly what clicking the last ancestor already does.
  let html = `<span class="bc-static-label">Process structure:</span>`;

  // Clickable path: every previous level
  navStack.forEach((item, i) => {
    // For the main (root) process, always show the current filename
    const itemType = item.rootEl && item.rootEl.businessObject && item.rootEl.businessObject.$type;
    const label = (itemType === 'bpmn:Process' || itemType === 'bpmn:Collaboration')
      ? getProcessDisplayName()
      : item.label;
    html += `<span class="bc-item" onclick="navigateToIndex(${i})">${escHtml(label)}</span>`;
    html += `<span class="bc-sep">›</span>`;
  });

  // Current level (not clickable)
  html += `<span class="bc-item current">${escHtml(getBreadcrumbLabel(currentRoot))}</span>`;

  bc.innerHTML = html;
}

/* ─── DRZEWO STRUKTURY ─── */

function buildSubprocessTree(boElement, depth) {
  const items = [];
  const children = boElement.flowElements || [];
  children.forEach(child => {
    if (child.$type === 'bpmn:SubProcess') {
      items.push({ bo: child, depth, type: 'subprocess' });
      const nested = buildSubprocessTree(child, depth + 1);
      nested.forEach(n => items.push(n));
    } else if (child.$type === 'bpmn:CallActivity') {
      items.push({ bo: child, depth, type: 'callactivity', targetRef: child.calledElement || '' });
    }
  });
  return items;
}

function findRootElementForBo(bo) {
  // Look in elementRegistry for the element whose businessObject is bo
  // and which is a root (plane) — bpmn-js creates a plane for every expanded subprocess
  const er = modeler.get('elementRegistry');
  const all = er.getAll();
  // Plane elements have type === businessObject.$type + 'Plane', or are in _planes
  // Simpler: look for the root in the canvas's _planes
  const canvasAny = modeler.get('canvas');
  const planes = canvasAny._planes || [];
  const found = planes.find(p =>
    p.rootElement && p.rootElement.businessObject &&
    p.rootElement.businessObject === bo
  );
  return found ? found.rootElement : null;
}

// The top-level "root" for navigation/breadcrumb purposes. For a bare
// bpmn:process file this is that process's own plane. For a file wrapped in
// a bpmn:collaboration (a pool, with or without lanes), bpmn-js never
// creates a separate plane for the process itself — its flow nodes are
// drawn directly on the collaboration's own plane — so we fall back to
// that. Either way, this is the element the canvas actually navigates to;
// use getMainProcessBo() below whenever the real bpmn:Process business
// object (with its .flowElements) is what's needed instead.
function findProcessRoot() {
  const canvasAny = modeler.get('canvas');
  const planes = canvasAny._planes || [];
  const directProcess = planes.find(p =>
    p.rootElement && p.rootElement.businessObject &&
    p.rootElement.businessObject.$type === 'bpmn:Process'
  );
  if (directProcess) return directProcess.rootElement;
  const collabPlane = planes.find(p =>
    p.rootElement && p.rootElement.businessObject &&
    p.rootElement.businessObject.$type === 'bpmn:Collaboration'
  );
  return collabPlane ? collabPlane.rootElement : null;
}

// Process Structure is deliberately independent of pools/lanes: BPMN 2.0
// lanes are a purely visual/organizational subdivision of a SINGLE process,
// not a structural boundary, and a bpmn:collaboration wrapping one
// participant is just that process wearing a pool border. This returns the
// actual bpmn:Process business object (the one with real .flowElements) no
// matter which of those two shapes the file is in, so the subprocess/call
// activity tree and the "jump to nested subprocess" navigation both work
// the same either way.
function getMainProcessBo() {
  if (!modeler) return null;
  try {
    const definitions = modeler.getDefinitions();
    const rootElements = definitions.rootElements || [];
    const directProcess = rootElements.find(r => r.$type === 'bpmn:Process');
    if (directProcess) return directProcess;
    const collaboration = rootElements.find(r => r.$type === 'bpmn:Collaboration');
    if (collaboration) {
      const participants = collaboration.participants || [];
      const withProcess = participants.find(p => p.processRef);
      if (withProcess) return withProcess.processRef;
    }
    return null;
  } catch (e) {
    return null;
  }
}

// The general case getMainProcessBo() above deliberately doesn't handle:
// a collaboration can wrap MULTIPLE participants that each have their own
// real process content (not just message-passing stubs), and a subprocess
// worth showing in Process Structure — or worth linking a Call Activity to,
// or worth building a breadcrumb through — can live in ANY of them, not
// just the first one in the file. Returns one entry per participant that
// has a processRef (in collaboration/pool order, which normally matches
// their top-to-bottom order on canvas), each tagged with that participant's
// id/name for grouping — or, for a bare poolless file, the single process
// itself with id/name left null (so callers can tell "no real pool here"
// apart from "an unnamed pool"). Used by updateTree() (one tree section per
// entry) and findPathToSubprocess() (search every entry until one contains
// the target), so a subprocess in the 2nd, 5th, or 6th pool is exactly as
// reachable as one in the 1st.
function getAllProcessRoots() {
  if (!modeler) return [];
  try {
    const definitions = modeler.getDefinitions();
    const rootElements = definitions.rootElements || [];
    const collaboration = rootElements.find(r => r.$type === 'bpmn:Collaboration');
    if (collaboration) {
      return (collaboration.participants || [])
        .filter(p => p.processRef)
        .map(p => ({ id: p.id, name: p.name || null, bo: p.processRef }));
    }
    const directProcess = rootElements.find(r => r.$type === 'bpmn:Process');
    return directProcess ? [{ id: null, name: null, bo: directProcess }] : [];
  } catch (e) {
    return [];
  }
}

function updateTree() {
  const treeEl = document.getElementById('structure-tree');
  const currentRoot = getCurrentRoot();

  try {
    // Find the main process — independent of whether it's a bare
    // bpmn:process or wrapped in a bpmn:collaboration (pool, with or
    // without lanes). "No diagram" now only happens for genuinely
    // unsupported shapes (e.g. a participant with no processRef at all) —
    // there's no in-between case left that needs a manual conversion step.
    const processRoot = findProcessRoot();
    const processRoots = getAllProcessRoots();
    if (!processRoot || processRoots.length === 0) {
      treeEl.innerHTML = '<div style="padding:12px;font-size:12px;color:#aaa;">No diagram</div>';
      return;
    }

    const currentBo = currentRoot ? currentRoot.businessObject : null;

    // One "section" per participant process — a subprocess can live in ANY
    // pool, not just the first, so every participant with a processRef gets
    // its own buildSubprocessTree() walk (a bare, poolless file is just a
    // single section with no participant). Sections with nothing to show
    // (pure message-passing pools, or ones with no subprocess/Call Activity
    // at all) are dropped from the render — UNLESS this is the only
    // content-bearing section, in which case it's rendered flat with no
    // pool header at all, so an ordinary single-pool file looks completely
    // unchanged from before this existed. Pool headers only appear once
    // there's actually more than one pool worth distinguishing.
    const allSections = processRoots.map(pr => ({
      id: pr.id,
      name: pr.name,
      items: buildSubprocessTree(pr.bo, 1)
    }));
    const contentSections = allSections.filter(s => s.items.length > 0);
    const showPoolHeaders = contentSections.length > 1;
    const sectionsToRender = showPoolHeaders ? contentSections : contentSections.slice(0, 1);
    // Call Activity target labels should resolve across ALL pools, not just
    // whichever one is currently being rendered — a Call Activity in one
    // pool can legitimately target a subprocess living in another.
    const allItemsById = new Map();
    allSections.forEach(s => s.items.forEach(it => allItemsById.set(it.bo.id, it)));

    let html = '';

    // Main process — show the filename. Active whether the canvas root is
    // the bare process (no pool) or the collaboration itself (pool/lanes
    // wrapping that same process) — both represent being "at the top".
    const isProcessActive = currentBo && (currentBo.$type === 'bpmn:Process' || currentBo.$type === 'bpmn:Collaboration');
    const processDisplayName = getProcessDisplayName();
    html += `<div class="tree-item ${isProcessActive ? 'active' : ''}" onclick="treeNavigateTo(null)" title="${escHtml(processDisplayName)}">
      <span class="tree-icon process">◈</span>
      <span class="tree-label">${escHtml(processDisplayName)}</span>
    </div>`;

    sectionsToRender.forEach(section => {
      const depthOffset = showPoolHeaders ? 1 : 0;

      if (showPoolHeaders) {
        // A pool header is just a collapse toggle — there's no separate
        // canvas plane per participant to "navigate to" (every pool's flow
        // nodes are drawn together on the one shared collaboration plane),
        // so the whole row (not just the ▲/▼ button) toggles visibility of
        // that pool's subprocess list. Reused as the ancestor-reveal target
        // for its own contents: if the active item lives in this pool, the
        // header can't stay collapsed regardless of stored state.
        // Unlike a subprocess (which falls back to its technical id — still
        // somewhat legible, e.g. "Activity_19ypnn7"), a participant without
        // a name falls back to a plain label instead of its raw internal id
        // (e.g. "Participant_1aqzv6l"), which would read as noise to anyone
        // not reading the XML directly. Each pool still collapses
        // independently regardless of what its header says.
        const poolLabel = section.name || 'Unnamed pool';
        const activeInSection = currentBo && section.items.some(it => it.bo === currentBo);
        const isPoolCollapsed = collapsedTreeIds.has(section.id) && !activeInSection;
        html += `<div class="tree-item tree-pool-header" onclick="toggleTreeCollapse('${escHtml(section.id)}')" title="${escHtml(poolLabel)}">
          <span class="tree-icon pool">▤</span>
          <span class="tree-label">${escHtml(poolLabel)}</span>
          <button class="tree-toggle-btn" onclick="event.stopPropagation(); toggleTreeCollapse('${escHtml(section.id)}')"
            title="${isPoolCollapsed ? 'Expand' : 'Collapse'}">${isPoolCollapsed ? '▼' : '▲'}</button>
        </div>`;
        if (isPoolCollapsed) return;
      }

      html += renderTreeItems(section.items, depthOffset, currentBo, allItemsById);
    });

    treeEl.innerHTML = html;
  } catch(e) {
    treeEl.innerHTML = `<div style="padding:12px;font-size:12px;color:#c00;">Error: ${e.message}</div>`;
  }
}

// Renders one pool's flat, depth-first subprocess/Call Activity list —
// shared between the single-pool (no header, depthOffset 0) and multi-pool
// (nested under a collapsible pool header, depthOffset 1) rendering paths
// in updateTree(). allItemsById resolves Call Activity target labels across
// every pool, since a target can live outside the section being rendered.
function renderTreeItems(items, depthOffset, currentBo, allItemsById) {
  // If the active element sits inside a collapsed ancestor (e.g. the user
  // drilled in via a canvas double-click rather than the tree itself),
  // reveal that ancestor chain for this render so the active row is
  // actually visible — without touching collapsedTreeIds itself, so the
  // user's own collapse choices are still exactly as they left them once
  // they navigate elsewhere.
  const revealIds = new Set();
  const activeIdx = currentBo ? items.findIndex(it => it.bo === currentBo) : -1;
  if (activeIdx !== -1) {
    let depth = items[activeIdx].depth;
    for (let i = activeIdx - 1; i >= 0 && depth > 1; i--) {
      if (items[i].depth === depth - 1) {
        revealIds.add(items[i].bo.id);
        depth = items[i].depth;
      }
    }
  }

  let html = '';

  // Subprocesses and Call Activities — a subprocess with children can be
  // collapsed to hide them, which matters once a process grows deep
  // enough that this list stops fitting comfortably. buildSubprocessTree()
  // does a depth-first walk, so a node's descendants are always the run of
  // items immediately following it with a greater depth — skipDepth below
  // tracks "hide everything deeper than this until depth drops back down",
  // i.e. skip the entire collapsed subtree in one pass without needing a
  // second (tree-shaped) data structure.
  let skipDepth = null;
  items.forEach((item, idx) => {
    if (skipDepth !== null) {
      if (item.depth > skipDepth) return;
      skipDepth = null;
    }

      const isActive = currentBo && currentBo === item.bo;
      const indent = (item.depth + depthOffset) * 16;
      const label = item.bo.name || item.bo.id || 'Subprocess';
      const hasChildren = item.type === 'subprocess' &&
        idx + 1 < items.length && items[idx + 1].depth > item.depth;
      const isCollapsed = collapsedTreeIds.has(item.bo.id) && !revealIds.has(item.bo.id);
      // ▲ = currently expanded (click collapses); ▼ = currently collapsed
      // (click expands) — the reverse pairing from the Properties panel's
      // own ▲/▼ toggle, chosen to match what was actually requested here.
      const toggleHtml = hasChildren
        ? `<button class="tree-toggle-btn" onclick="event.stopPropagation(); toggleTreeCollapse('${escHtml(item.bo.id)}')"
            title="${isCollapsed ? 'Expand' : 'Collapse'}">${isCollapsed ? '▼' : '▲'}</button>`
        : '';

      if (item.type === 'callactivity') {
        const targetId = item.targetRef;
        const targetItem = targetId ? allItemsById.get(targetId) : null;
        const targetLabel = targetId ? (targetItem ? (targetItem.bo.name || targetId) : targetId) : '— not set';
        html += `<div class="tree-item tree-callactivity"
          style="padding-left: ${12 + indent}px; flex-direction: column; align-items: flex-start; gap: 1px;"
          onclick="treeNavigateToCallActivity('${escHtml(item.bo.id)}')"
          title="Call Activity → ${escHtml(targetLabel)}">
          <div style="display:flex;align-items:center;gap:6px;width:100%;">
            <span class="tree-icon" style="margin-left:0;color:#1a6bb5;font-size:11px;flex-shrink:0;">⇒</span>
            <span class="tree-label">${escHtml(label)}</span>
          </div>
          <div class="tree-call-target" style="padding-left:17px;width:100%;overflow:hidden;text-overflow:ellipsis;">→ ${escHtml(targetLabel)}</div>
        </div>`;
      } else {
        html += `<div class="tree-item ${isActive ? 'active' : ''}"
          style="padding-left: ${12 + indent}px"
          onclick="treeNavigateTo('${escHtml(item.bo.id)}')"
          title="${escHtml(label)}">
          <span class="tree-icon sub" style="margin-left:0">⊕</span>
          <span class="tree-label">${escHtml(label)}</span>
          ${toggleHtml}
        </div>`;
      }

      if (hasChildren && isCollapsed) skipDepth = item.depth;
  });

  return html;
}

// Toggles whether a subprocess's children (or a whole pool's contents) are
// hidden in the Process structure tree. Purely a rendering concern —
// collapsing a node has no effect on the diagram itself, only on how much
// of the tree list is drawn.
function toggleTreeCollapse(id) {
  if (collapsedTreeIds.has(id)) collapsedTreeIds.delete(id);
  else collapsedTreeIds.add(id);
  updateTree();
}

function treeNavigateTo(subprocessId) {
  const canvasAny = modeler.get('canvas');
  const planes = canvasAny._planes || [];
  const currentRoot = getCurrentRoot();

  if (!subprocessId) {
    const processRoot = findProcessRoot();
    if (processRoot && processRoot !== currentRoot) {
      // If the root is on the stack, restore its viewport
      const rootOnStack = navStack.find(x => x.rootEl === processRoot);
      navStack = [];
      modeler.get('canvas').setRootElement(processRoot);
      if (rootOnStack && rootOnStack.viewport) {
        modeler.get('canvas').viewbox(rootOnStack.viewport);
      } else {
        fitViewport();
      }
      updateBreadcrumb();
      updateTree();
    }
    return;
  }

  // Find the plane for the given subprocess
  const targetPlane = planes.find(p =>
    p.rootElement && p.rootElement.businessObject &&
    p.rootElement.businessObject.id === subprocessId
  );

  if (!targetPlane) {
    setStatus('No plane for this subprocess (might be collapsed?)', 'err');
    return;
  }

  const targetRoot = targetPlane.rootElement;
  if (targetRoot === currentRoot) return;

  const targetBo = targetRoot.businessObject;
  const path = findPathToSubprocess(targetBo);

  // Save the current viewport for the current level
  const currentVp = modeler.get('canvas').viewbox();

  // Build a new stack: for every ancestor of targetRoot, take the viewport from the old stack if present,
  // and for the current level save the current viewport
  const newStack = path.map(bo => {
    // The top-of-path entry is always a bpmn:Process (see
    // findPathToSubprocess()) — for a pool/lane-wrapped file there's no
    // plane whose businessObject is that raw bpmn:Process, since its flow
    // nodes are drawn directly on the collaboration's own plane, same for
    // every participant/pool. Resolve any of them via findProcessRoot()
    // instead of a plane lookup.
    const rootEl = (bo.$type === 'bpmn:Process')
      ? findProcessRoot()
      : (function() {
          const plane = planes.find(p => p.rootElement && p.rootElement.businessObject === bo);
          return plane ? plane.rootElement : null;
        })();
    // Look for a saved viewport on the old stack
    const existingEntry = navStack.find(x => x.rootEl === rootEl);
    // If this is the current level — use the fresh viewport
    const isCurrent = rootEl === currentRoot;
    return {
      rootEl,
      label: bo.name || bo.id || '?',
      viewport: isCurrent ? currentVp : (existingEntry ? existingEntry.viewport : null)
    };
  }).filter(x => x.rootEl !== null);

  navStack = newStack;
  modeler.get('canvas').setRootElement(targetRoot);
  fitViewport();
  updateBreadcrumb();
  updateTree();
}

function treeNavigateToCallActivity(callActivityId) {
  // Find the target subprocess via calledElement
  const er = modeler.get('elementRegistry');
  const callEl = er.get(callActivityId);
  if (!callEl) { setStatus('Call Activity not found', 'err'); return; }
  const targetId = callEl.businessObject && callEl.businessObject.calledElement;
  if (!targetId) { setStatus('Call Activity has no target set', 'err'); return; }
  treeNavigateTo(targetId);
}

function openCallActivitySelector(elementId) {
  // Open the subprocess-selection dialog for the given element
  const planes = modeler.get('canvas')._planes || [];
  const subList = planes
    .filter(p => p.rootElement && p.rootElement.businessObject &&
      p.rootElement.businessObject.$type === 'bpmn:SubProcess')
    .map(p => ({ id: p.rootElement.businessObject.id, name: p.rootElement.businessObject.name || p.rootElement.businessObject.id }));

  if (subList.length === 0) {
    setStatus('No subprocesses in this file', 'err');
    return;
  }

  // Remove the old dialog if it exists
  const old = document.getElementById('call-activity-dialog');
  if (old) old.remove();

  const er = modeler.get('elementRegistry');
  const el = er.get(elementId);
  const currentTarget = el && el.businessObject && el.businessObject.calledElement || '';

  const dialog = document.createElement('div');
  dialog.id = 'call-activity-dialog';
  dialog.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.4);z-index:1000;display:flex;align-items:center;justify-content:center;';

  let optionsHtml = subList.map(s =>
    `<label style="display:flex;align-items:center;gap:8px;padding:7px 10px;border-radius:6px;cursor:pointer;font-size:13px;border:1px solid #e0e0dc;margin-bottom:6px;background:${s.id===currentTarget?'#e8f0fa':'#fff'}">
      <input type="radio" name="ca-target" value="${escHtml(s.id)}" ${s.id===currentTarget?'checked':''} style="accent-color:#1a6bb5;">
      <span>${escHtml(s.name)}</span>
      <span style="margin-left:auto;font-size:11px;color:#aaa;">${escHtml(s.id)}</span>
    </label>`
  ).join('');

  dialog.innerHTML = `<div style="background:#fff;border-radius:10px;padding:20px;min-width:360px;max-width:480px;box-shadow:0 8px 32px rgba(0,0,0,0.18);">
    <div style="font-size:14px;font-weight:500;margin-bottom:4px;">Select target subprocess</div>
    <div style="font-size:12px;color:#888;margin-bottom:14px;">Call Activity: <b>${escHtml(el && el.businessObject && el.businessObject.name || elementId)}</b></div>
    <div style="max-height:260px;overflow-y:auto;margin-bottom:14px;">${optionsHtml}</div>
    <div style="display:flex;gap:8px;justify-content:flex-end;">
      <button onclick="document.getElementById('call-activity-dialog').remove()" style="font-size:13px;padding:5px 14px;">Cancel</button>
      <button onclick="applyCallActivityTarget('${escHtml(elementId)}')" style="font-size:13px;padding:5px 14px;background:#1a6bb5;color:#fff;border-color:#1558a0;">Apply</button>
    </div>
  </div>`;

  document.body.appendChild(dialog);
  dialog.addEventListener('click', e => { if (e.target === dialog) dialog.remove(); });
}

function applyCallActivityTarget(elementId) {
  const selected = document.querySelector('input[name="ca-target"]:checked');
  if (!selected) return;
  const targetId = selected.value;

  const modeling = modeler.get('modeling');
  const er = modeler.get('elementRegistry');
  const el = er.get(elementId);
  if (!el) return;

  modeling.updateProperties(el, { calledElement: targetId });
  document.getElementById('call-activity-dialog').remove();
  setStatus('Call Activity → ' + targetId, 'ok');
  updateTree();
  refreshDetailOverlays();
  updatePropsPanel(modeler.get('selection').get());
}

// Generic confirm/prompt modals — this app never uses native confirm()/
// prompt() (they block synchronously and can't be styled), so every
// destructive or name-entry action gets one of these instead, matching the
// visual pattern already used by openCallActivitySelector().
function openConfirmModal(title, message, onConfirm) {
  const old = document.getElementById('confirm-modal');
  if (old) old.remove();

  const dialog = document.createElement('div');
  dialog.id = 'confirm-modal';
  dialog.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.4);z-index:1100;display:flex;align-items:center;justify-content:center;';
  dialog.innerHTML = `<div style="background:#fff;border-radius:10px;padding:20px;min-width:320px;max-width:440px;box-shadow:0 8px 32px rgba(0,0,0,0.18);">
    <div style="font-size:14px;font-weight:500;margin-bottom:8px;">${escHtml(title)}</div>
    <div style="font-size:13px;color:#555;margin-bottom:16px;">${escHtml(message)}</div>
    <div style="display:flex;gap:8px;justify-content:flex-end;">
      <button onclick="document.getElementById('confirm-modal').remove()" style="font-size:13px;padding:5px 14px;">Cancel</button>
      <button onclick="_confirmModalOk()" style="font-size:13px;padding:5px 14px;background:#c0392b;color:#fff;border-color:#a02f22;">Delete</button>
    </div>
  </div>`;
  document.body.appendChild(dialog);
  dialog.addEventListener('click', e => { if (e.target === dialog) dialog.remove(); });
  window._confirmModalOk = function() {
    const el = document.getElementById('confirm-modal');
    if (el) el.remove();
    onConfirm();
  };
}

function openPromptModal(title, placeholder, defaultValue, onSubmit) {
  const old = document.getElementById('prompt-modal');
  if (old) old.remove();

  const dialog = document.createElement('div');
  dialog.id = 'prompt-modal';
  dialog.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.4);z-index:1100;display:flex;align-items:center;justify-content:center;';
  dialog.innerHTML = `<div style="background:#fff;border-radius:10px;padding:20px;min-width:320px;max-width:440px;box-shadow:0 8px 32px rgba(0,0,0,0.18);">
    <div style="font-size:14px;font-weight:500;margin-bottom:10px;">${escHtml(title)}</div>
    <input type="text" id="prompt-modal-input" value="${escHtml(defaultValue || '')}" placeholder="${escHtml(placeholder || '')}"
      style="width:100%;box-sizing:border-box;font-size:13px;padding:6px 8px;border:1px solid #d0d0cc;border-radius:5px;margin-bottom:14px;">
    <div style="display:flex;gap:8px;justify-content:flex-end;">
      <button onclick="document.getElementById('prompt-modal').remove()" style="font-size:13px;padding:5px 14px;">Cancel</button>
      <button onclick="_promptModalOk()" style="font-size:13px;padding:5px 14px;background:#1a6bb5;color:#fff;border-color:#1558a0;">OK</button>
    </div>
  </div>`;
  document.body.appendChild(dialog);
  dialog.addEventListener('click', e => { if (e.target === dialog) dialog.remove(); });
  const input = dialog.querySelector('#prompt-modal-input');
  window._promptModalOk = function() {
    const val = input.value;
    const el = document.getElementById('prompt-modal');
    if (el) el.remove();
    onSubmit(val);
  };
  input.addEventListener('keydown', e => { if (e.key === 'Enter') window._promptModalOk(); });
  setTimeout(() => input.focus(), 0);
}

function findPathToSubprocess(targetBo) {
  // Returns an array of businessObjects from targetBo's own process root
  // down to its parent (excluding targetBo itself). targetBo can live in
  // ANY participant's process, not just the first one in the file — see
  // getAllProcessRoots() — so every process root is searched in turn until
  // one of them actually contains it.
  function search(bo, current) {
    if (bo === targetBo) return true;
    const children = bo.flowElements || [];
    for (const child of children) {
      if (child.$type === 'bpmn:SubProcess') {
        current.push(bo);
        if (search(child, current)) return true;
        current.pop();
      }
    }
    return false;
  }

  const roots = getAllProcessRoots();
  for (const r of roots) {
    const path = [];
    if (search(r.bo, path)) return path;
  }
  return [];
}

/* ─── MODELER INIT ─── */

// Task-shaped elements that get resize handles — bpmn-js disallows resizing
// these by default (only containers like expanded sub-processes, pools,
// lanes, text annotations etc. are resizable out of the box).
const RESIZABLE_TASK_TYPES = ['bpmn:Task', 'bpmn:UserTask', 'bpmn:ServiceTask', 'bpmn:ManualTask',
  'bpmn:ScriptTask', 'bpmn:BusinessRuleTask', 'bpmn:SendTask', 'bpmn:ReceiveTask', 'bpmn:CallActivity'];

// Elements that get a manual "Time (s)" field when Time analysis is enabled
// in Settings — task-like shapes plus sub-processes/Call Activities (which
// get a single, non-decomposed value, mirroring how PNG export treats each
// plane independently — see TIME_ANALYSIS notes near refreshDetailOverlays).
const TIME_FIELD_TYPES = RESIZABLE_TASK_TYPES.concat(['bpmn:SubProcess', 'bpmn:AdHocSubProcess']);

// Floor for manual width/height entry in the properties panel — calling
// modeling.resizeShape() directly (as opposed to dragging a resize handle)
// bypasses bpmn-js's own interactive min-size clamping, so without this a
// typed "1" could produce a degenerate, effectively invisible shape.
const MIN_SHAPE_SIZE = 10;

// bpmn-js's stock palette ships the Text Annotation feature in full
// (rendering, properties, the icon glyph) but doesn't expose a button to
// create one from scratch — this small provider registers that missing
// palette entry, right next to the built-in "Create group" tool, using the
// same palette.registerProvider() extension point bpmn-js's own built-in
// PaletteProvider is registered through (constructor + $inject, the
// standard bpmn-js custom-module pattern). No custom rules needed: a Text
// Annotation is a free-floating BPMN Artifact, valid with zero attachments,
// and can optionally be linked to any element afterwards via a plain
// Association (drawn with the palette's connect tool).
function MpTextAnnotationPalette(palette, create, elementFactory) {
  function startCreateTextAnnotation(event) {
    const shape = elementFactory.createShape({ type: 'bpmn:TextAnnotation' });
    create.start(event, shape);
  }

  // Priority BELOW bpmn-js's own default PaletteProvider (which registers
  // at the implicit default of 1000) so it runs *after* — landing this
  // entry at the end of the palette's "artifact" group (right after the
  // built-in "Create group"), matching where a custom addition belongs,
  // rather than jumping the whole artifact group to the front.
  palette.registerProvider(500, {
    getPaletteEntries: function() {
      return {
        'create.text-annotation': {
          group: 'artifact',
          className: 'bpmn-icon-text-annotation',
          title: 'Create text annotation',
          action: {
            dragstart: startCreateTextAnnotation,
            click: startCreateTextAnnotation
          }
        }
      };
    }
  });
}
MpTextAnnotationPalette.$inject = ['palette', 'create', 'elementFactory'];

function initModeler() {
  modeler = new BpmnJS({
    container: '#canvas',
    additionalModules: [
      {
        __init__: ['mpTextAnnotationPalette'],
        mpTextAnnotationPalette: ['type', MpTextAnnotationPalette]
      }
    ]
  });

  // bpmn-js renders the tool palette as a free-floating overlay (absolutely
  // positioned) inside the canvas container. Relocate its actual DOM node
  // into our fixed left sidebar instead — the matching CSS override
  // (#palette-panel .djs-palette) strips the floating positioning/border so
  // it looks like a normal side panel, same as Process structure on the
  // right. This only needs to happen once: the palette element is created
  // exactly once per modeler instance, and re-importing diagrams later
  // reuses the same modeler/palette rather than recreating it.
  const paletteEl = document.querySelector('#canvas .djs-palette');
  const palettePanel = document.getElementById('palette-scroll');
  if (paletteEl && palettePanel) {
    palettePanel.appendChild(paletteEl);
  }

  // Make actual move/resize snapping follow the "Small grid size" Settings
  // value, instead of bpmn-js's own built-in GridSnapping service, which
  // this bundle hardcodes to a fixed 10px (its snapValue()/getGridSpacing()
  // literally have "10" baked in — there's no constructor/config option for
  // it in this version, unlike the visual grid overlay above which is all
  // our own code). We patch the live service's methods in place so snapping
  // always matches whatever `smallGridSize` currently is, live — since the
  // patched functions read the module-level `smallGridSize` variable at
  // call time (not at patch time), changing it in Settings takes effect on
  // the very next drag with no need to re-patch.
  patchGridSnappingSpacing();

  // Allow resizing Tasks — override the built-in rule. The "rules" service
  // itself has no addRule() in this bundle (that lives on BpmnRules, which
  // isn't exposed under its own DI key here), so we hook the eventBus
  // directly at the same event RuleProvider.addRule() would use internally:
  // "commandStack.<action>.canExecute". Priority higher than bpmn-js's
  // default means ours is checked first; returning `undefined` for anything
  // else leaves bpmn-js's own rule to decide, so existing resizable elements
  // (pools, lanes, expanded sub-processes, ...) are unaffected.
  modeler.get('eventBus').on('commandStack.shape.resize.canExecute', 2000, function(event) {
    const shape = event.context && event.context.shape;
    if (shape && RESIZABLE_TASK_TYPES.includes(shape.type)) {
      return true;
    }
    // A COLLAPSED sub-process renders as a small fixed box, visually and
    // behaviorally like a Task — but bpmn-js's built-in rule only allows
    // resizing sub-processes when *expanded* (acting as a container), so
    // collapsed ones were stuck at their default size. An EXPANDED
    // sub-process is left to fall through to the built-in rule (`undefined`)
    // since that rule also guards against shrinking below the bounding box
    // of its visible children — a check we'd otherwise have to reimplement.
    if (shape && shape.type === 'bpmn:SubProcess' && shape.collapsed) {
      return true;
    }
    return undefined;
  });

  // Keep dictionary badge overlays (position + wrap width, which depends on
  // the element's current width) in sync after a task is resized. Also
  // refresh the properties panel so its Size fields reflect a drag-resize
  // immediately (it otherwise only updates on selection change).
  modeler.on('resize.end', () => {
    refreshDetailOverlays();
    updatePropsPanel(modeler.get('selection').get());
  });

  // Pools and lanes are drawn by bpmn-js with a translucent white fill baked
  // directly into the SVG rect's inline style (Participant ~95% opaque,
  // Lane ~25%) — inline style beats any CSS rule we could add, so we can't
  // fix this from app.css. Force it fully transparent instead, so the canvas
  // grid (and anything else on the page background) shows through cleanly.
  // 'render.shape' fires BEFORE bpmn-js actually draws the rect into the
  // group (empty gfx at that point) — a 0ms deferral lets the synchronous
  // render finish first, and re-fires on every redraw (move/resize/rename),
  // so the transparency sticks no matter what you do to the pool/lane.
  const TRANSPARENT_BACKGROUND_TYPES = ['bpmn:Participant', 'bpmn:Lane'];
  modeler.get('eventBus').on('render.shape', 2000, function(event) {
    const el = event.element;
    if (!el || !TRANSPARENT_BACKGROUND_TYPES.includes(el.type)) return;
    const gfx = event.gfx;
    setTimeout(() => {
      const rect = gfx.querySelector('rect');
      if (rect) rect.style.fillOpacity = '0';
    }, 0);
  });

  // Text Annotations ("notes") don't get a background from bpmn-js at all —
  // the default renderer only draws the bracket outline + text, both using
  // the "stroke" color; the "fill" color you pick in the color picker is
  // completely unused for this type. We draw our own background rect (the
  // chosen fill color, lightened toward white) behind the bracket/text, and
  // as a safety net, force the text/bracket to pure black or white if the
  // auto-picked (darkened) text color wouldn't contrast enough against it —
  // e.g. if you pick an already very dark custom color as the note's color.
  const NOTE_BACKGROUND_TINT = 0.82;
  const NOTE_MIN_CONTRAST = 3.5;
  modeler.get('eventBus').on('render.shape', 2000, function(event) {
    const el = event.element;
    if (!el || el.type !== 'bpmn:TextAnnotation') return;
    const gfx = event.gfx;
    setTimeout(() => {
      const oldBg = gfx.querySelector('.app-note-bg');
      if (oldBg) oldBg.remove();

      const fill = el.di && el.di.fill;
      if (!fill) return; // no color chosen -> leave the default look untouched

      const bg = lighten(fill, NOTE_BACKGROUND_TINT);
      const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      rect.setAttribute('class', 'app-note-bg');
      rect.setAttribute('x', 0);
      rect.setAttribute('y', 0);
      rect.setAttribute('width', el.width);
      rect.setAttribute('height', el.height);
      rect.setAttribute('fill', bg);
      rect.setAttribute('pointer-events', 'none');
      gfx.insertBefore(rect, gfx.firstChild);

      const textColor = (el.di && el.di.stroke) || darken(fill);
      if (contrastRatio(textColor, bg) < NOTE_MIN_CONTRAST) {
        const safeColor = contrastTextColor(bg);
        const textEl = gfx.querySelector('.djs-label');
        if (textEl) textEl.style.fill = safeColor;
        const pathEl = gfx.querySelector('path');
        if (pathEl) pathEl.style.stroke = safeColor;
      }
    }, 0);
  });

  // Groups have the same "fill is ignored" issue as Text Annotations — the
  // default renderer always draws the dashed-border rect with fill:none, so
  // the color picker's fill swatch currently only ever colors the dashed
  // border (stroke). Unlike notes, here we want the raw chosen color at low
  // opacity rather than lightened toward white, so the canvas grid still
  // shows through — a Group is meant to visually cluster elements, not hide
  // what's under it. No text-contrast handling needed: bpmn-js renders a
  // Group's label as a separate external-label element, not inside this gfx.
  const GROUP_BACKGROUND_OPACITY = 0.2;
  modeler.get('eventBus').on('render.shape', 2000, function(event) {
    const el = event.element;
    if (!el || el.type !== 'bpmn:Group') return;
    const gfx = event.gfx;
    setTimeout(() => {
      const oldBg = gfx.querySelector('.app-group-bg');
      if (oldBg) oldBg.remove();

      const fill = el.di && el.di.fill;
      if (!fill) return; // no color chosen -> leave the default look untouched

      const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      rect.setAttribute('class', 'app-group-bg');
      rect.setAttribute('x', 0);
      rect.setAttribute('y', 0);
      rect.setAttribute('width', el.width);
      rect.setAttribute('height', el.height);
      rect.setAttribute('rx', 10);
      rect.setAttribute('ry', 10);
      rect.setAttribute('fill', fill);
      rect.setAttribute('fill-opacity', GROUP_BACKGROUND_OPACITY);
      rect.setAttribute('pointer-events', 'none');
      gfx.insertBefore(rect, gfx.firstChild);
    }, 0);
  });

  // "Change element" (context-pad wrench -> replace with another task type)
  // creates a brand-new shape of the target type and bpmn-js sizes it at
  // that type's default (100x80) — discarding whatever custom size the old
  // shape had, and in some cases (e.g. Task -> Sub-Process, where bpmn-js
  // does NOT simply keep the old top-left corner) shifting the position
  // too. Restore BOTH the old position and size, by forcing the exact old
  // bounding box back, rather than relying on any assumption about how
  // bpmn-js repositioned the new shape.
  //
  // This also covers a freshly-replaced COLLAPSED Sub-Process (regular OR
  // Ad-hoc — bpmn:AdHocSubProcess is modeled as its own concrete type, not
  // just a flag on bpmn:SubProcess, so it needs listing explicitly here too;
  // it has exactly the same "shrinks to the default box" behavior), which is
  // still task-sized visually — but deliberately NOT an expanded one, since
  // that's a container that's meant to grow and forcing it back to
  // task-size would make it useless.
  const SUBPROCESS_LIKE_TYPES = ['bpmn:SubProcess', 'bpmn:AdHocSubProcess'];
  const TYPE_CHANGE_SIZE_PRESERVE_TYPES = RESIZABLE_TASK_TYPES.concat(SUBPROCESS_LIKE_TYPES);
  modeler.get('eventBus').on('commandStack.shape.replace.postExecuted', function(event) {
    const context = event.context || {};
    const oldShape = context.oldShape;
    const newShape = context.newShape;
    if (!oldShape || !newShape) return;
    const sizePreserveEligible =
      TYPE_CHANGE_SIZE_PRESERVE_TYPES.includes(oldShape.type) &&
      TYPE_CHANGE_SIZE_PRESERVE_TYPES.includes(newShape.type) &&
      !(SUBPROCESS_LIKE_TYPES.includes(newShape.type) && newShape.collapsed === false) &&
      (oldShape.width !== newShape.width || oldShape.height !== newShape.height ||
        oldShape.x !== newShape.x || oldShape.y !== newShape.y);
    if (sizePreserveEligible) {
      modeler.get('modeling').resizeShape(newShape, {
        x: oldShape.x,
        y: oldShape.y,
        width: oldShape.width,
        height: oldShape.height
      });
    }
    // Any type change via the context-pad's "Change element" replaces the
    // shape outright: the old shape (and its overlays — dictionary badges,
    // the details-link icon) is removed, and a brand-new shape is created.
    // diagram-js cleans up the old shape's overlays automatically since the
    // element itself is gone, but nothing re-adds them for the replacement
    // — so without this, badges silently vanish until the user happens to
    // resize the shape (resizing routes through applyElementSize(), the
    // only other place that triggers a refresh). Refresh unconditionally,
    // not just when the size-preservation branch above ran.
    refreshDetailOverlays();
    // bpmn-js re-selects newShape as part of the replace, so the props
    // panel already re-rendered once (at the type's default size) before
    // we (maybe) restored the old bounds here — refresh it so it reflects
    // the new type/size rather than a stale render.
    updatePropsPanel(modeler.get('selection').get());
  });

  // Collapsing/expanding an EXISTING sub-process (the small "+/-" affordance,
  // separate from the "Change element" type-replace above) goes through a
  // different bpmn-js command entirely — "shape.toggleCollapse" — which the
  // hook above never sees. bpmn-js's own behavior for that command always
  // resizes to its built-in default collapsed box (100x80-ish) when
  // collapsing, discarding whatever size the sub-process actually had — and
  // this applies to bpmn:AdHocSubProcess too (bpmn-js's own toggle-collapse
  // behavior matches it via BPMN's type hierarchy, where AdHocSubProcess
  // extends SubProcess, even though our own checks here compare concrete
  // type strings and so need it listed explicitly alongside SubProcess).
  // Capture the pre-toggle bounds in preExecute (before bpmn-js's own resize
  // runs) and restore them in postExecuted at a LOWER priority than bpmn-js's
  // own toggle-collapse behavior (500) so ours runs after it and gets the
  // final word — mirroring the shape.replace fix above, just for this other
  // command. Only restores on COLLAPSE: expanding is deliberately left to
  // bpmn-js's own "grow to fit children" sizing.
  modeler.get('eventBus').on('commandStack.shape.toggleCollapse.preExecute', function(event) {
    const shape = event.context && event.context.shape;
    if (!shape) return;
    event.context.mpOldBounds = { x: shape.x, y: shape.y, width: shape.width, height: shape.height };
  });
  modeler.get('eventBus').on('commandStack.shape.toggleCollapse.postExecuted', 100, function(event) {
    const context = event.context || {};
    const shape = context.shape;
    const oldBounds = context.mpOldBounds;
    if (!shape || !oldBounds || !SUBPROCESS_LIKE_TYPES.includes(shape.type) || !shape.collapsed) return;
    if (shape.width === oldBounds.width && shape.height === oldBounds.height &&
        shape.x === oldBounds.x && shape.y === oldBounds.y) return;
    modeler.get('modeling').resizeShape(shape, oldBounds);
    updatePropsPanel(modeler.get('selection').get());
  });

  // Double-clicking truly blank canvas while inside a sub-process (or
  // ad-hoc sub-process) plane made every element name on that plane vanish,
  // permanently, until reload. Root cause: a click that doesn't land on any
  // child shape's own graphics falls through to whatever gfx IS registered
  // at that point — which turns out to be the CURRENT ROOT element's own
  // layer (the sub-process you're currently standing inside), not "nothing".
  // bpmn-js's diagram-js delegate layer then fires "element.dblclick" with
  // that root as the target element, and its own LabelEditingProvider
  // activates direct-editing on it UNCONDITIONALLY — it only skips elements
  // that fail a type check on click, but for dblclick it always passes
  // `force=true`, bypassing that check entirely (see LabelEditingProvider in
  // the vendor bundle). For a Task/CallActivity/SubProcess/Participant/Lane,
  // activating direct-editing adds a "djs-label-hidden" CSS marker onto the
  // target's own gfx group to hide its native label while the edit box is
  // shown — and since the CSS rule for that marker
  // (".djs-label-hidden .djs-label { display:none }") is a DESCENDANT
  // selector, marking the CURRENT ROOT's own group (which visually contains
  // every child element on this plane) hides every label on the whole
  // plane at once. The edit box itself gets positioned using the root
  // element's bounds from its PARENT plane's coordinate system — which is
  // meaningless on the child plane we're actually viewing — so it ends up
  // invisible/unreachable, meaning the user has no textbox to Escape out of
  // and the hide-everything marker never gets cleaned up. (This doesn't
  // happen on the very top-level Process, because a bare bpmn:Process
  // doesn't match any of the types LabelEditingProvider adds that marker
  // for — matching the original report that this seemed main-process-only.)
  //
  // Fix: nobody should be able to rename "the container I'm currently
  // standing inside" via a stray double-click on its own empty canvas in
  // the first place — that was never an intentional feature, just a gap in
  // bpmn-js's own type check. Intercept at a higher priority than
  // LabelEditingProvider's default-priority listener and swallow the event
  // (returning `false` from a diagram-js eventBus listener stops
  // propagation to lower-priority listeners) whenever the dblclick resolved
  // to the current plane's own root element.
  modeler.get('eventBus').on('element.dblclick', 2000, function(event) {
    if (event.element === modeler.get('canvas').getRootElement()) {
      return false;
    }
  });

  // Configurable default size for brand-new tasks (Settings ⚙ → "Default
  // task size"), applied uniformly regardless of task subtype. Covers both
  // ways a task gets created: dragging from the palette ('shape.create')
  // and the context-pad "Append" action ('shape.append') — these are
  // distinct commandStack actions in bpmn-js, so both need a listener.
  // Import doesn't go through the commandStack at all, so pre-existing
  // tasks loaded from a file are never touched by this.
  modeler.get('eventBus').on(['commandStack.shape.create.postExecuted', 'commandStack.shape.append.postExecuted'], function(event) {
    const size = dictionaries.taskDefaultSize;
    if (!size || !size.width || !size.height) return;
    const shape = event.context && event.context.shape;
    if (!shape || !RESIZABLE_TASK_TYPES.includes(shape.type)) return;
    const newWidth = Math.max(MIN_SHAPE_SIZE, Math.round(size.width));
    const newHeight = Math.max(MIN_SHAPE_SIZE, Math.round(size.height));
    if (shape.width === newWidth && shape.height === newHeight) return;
    // Keep the shape centered where it was dropped/appended rather than
    // anchoring on its top-left corner, so a bigger-than-default size
    // doesn't visually shift the shape away from the cursor/anchor point.
    const newX = Math.round(shape.x + (shape.width - newWidth) / 2);
    const newY = Math.round(shape.y + (shape.height - newHeight) / 2);
    modeler.get('modeling').resizeShape(shape, { x: newX, y: newY, width: newWidth, height: newHeight });
  });

  modeler.on('commandStack.changed', async () => {
    hasUnsavedChanges = true;
    setStatus('Unsaved changes', '');
    if (xmlPanelVisible) await refreshXmlPanel();
    // Copy/paste (and duplicate, and undo/redo of either) clones each
    // element's businessObject — including the hidden bpmn:Documentation
    // node our meta (System/Location/Device, Time, flow %, Details URL) is
    // serialized into — but the NEW element's id was never loaded into
    // window._bpmnMeta (that cache is only ever populated wholesale by
    // loadMetaFromModel() on file import, or per-id by setElementMeta() as
    // the user edits the properties panel). Without re-reading it here, a
    // pasted copy's badges/overlays stay invisible — and its properties-
    // panel fields read as empty — until something else happens to call
    // loadMetaFromModel(), which today only happens by navigating to a
    // different plane and back (root.set → refreshDetailOverlays(),
    // rebuilt from whatever was already in memory). Reloading from the
    // model on every command stays consistent with updateTree() below,
    // which already does a full rebuild unconditionally here — this only
    // runs once per finished (undoable) action, not per mouse-move.
    loadMetaFromModel();
    updateTree();
    refreshDetailOverlays();
    scheduleAutosave();
  });

  // Handle drill-down via a click on bpmn-js's own arrow overlay — this is
  // the ONE handler that fires for every plane change regardless of how it
  // was triggered (Process structure tree, canvas breadcrumb "Back", or
  // bpmn-js's own drilldown arrow), so navStack is rebuilt from the model
  // here rather than trusted from whatever the triggering code did (see
  // rebuildNavStack() for why).
  modeler.on('root.set', () => {
    rebuildNavStack();
    updateBreadcrumb();
    updateTree();
    refreshDetailOverlays();
    renderGridBackground();
  });

  // Properties panel on element selection
  modeler.on('selection.changed', ({ newSelection }) => {
    updatePropsPanel(newSelection);
  });

  restoreLastFileOrNew();
  updateAutosaveIndicator();
  updateExtendedDetailsButton();
  updateGridButton();
  focusCanvas();
}

/* ─── DIAGRAM OPERATIONS ─── */

async function newDiagram() {
  navStack = [];
  collapsedTreeIds = new Set();
  currentFileHandle = null;
  hasUnsavedChanges = false;
  try {
    await modeler.importXML(EMPTY_DIAGRAM);
    fitViewport();
    updateBreadcrumb();
    updateTree();
    setStatus('New diagram', 'ok');
    updateAutosaveIndicator();
    flushDictionariesToModel();
    refreshDetailOverlays();
    renderGridBackground();
    focusCanvas();
  } catch(e) {
    setStatus('Error: ' + e.message, 'err');
  }
}

function fitViewport() {
  try { modeler.get('canvas').zoom('fit-viewport'); } catch(e) {}
}

// bpmn-js already binds its own Ctrl/Cmd +, -, 0 (and Ctrl/Cmd+scroll)
// zoom shortcuts to the diagram — but only once the canvas SVG itself has
// received keyboard focus (e.g. after clicking on it). Until that first
// click, those key combos fall straight through to the *browser's* own
// page zoom instead, which Chrome/Safari share across every tab open to
// the same site — for file:// diagrams, effectively every open tab — which
// is exactly why zooming one tab could visibly zoom another. Explicitly
// focusing the SVG right after it's created (and after every new/opened
// diagram) means bpmn-js's own per-tab zoom shortcut is live from the
// start, with no need to reimplement zoom in-app.
function focusCanvas() {
  try {
    const svg = document.querySelector('#canvas svg');
    if (svg) svg.focus();
  } catch (e) {}
}

function undo() { modeler.get('commandStack').undo(); }
function redo() { modeler.get('commandStack').redo(); }

async function saveDiagram() {
  try {
    const { xml } = await modeler.saveXML({ format: true });

    // If we already have a file handle, but the user changed the name in the
    // field next to it — treat this like "Save as": ask for a new location
    // instead of silently overwriting the previous file under the old name.
    if (currentFileHandle) {
      const typedName = (document.getElementById('filename-input').value || '').trim();
      const handleBase = currentFileHandle.name.replace(/\.bpmn$|\.xml$/i, '');
      if (typedName && typedName !== handleBase) {
        currentFileHandle = null;
      }
    }

    // Quick save: we already have a file handle (from an earlier Save/Open)
    // — save without asking for a location.
    if (currentFileHandle) {
      try {
        const writable = await currentFileHandle.createWritable();
        await writable.write(xml);
        await writable.close();
        hasUnsavedChanges = false;
        setStatus('Saved: ' + currentFileHandle.name, 'ok');
        updateAutosaveIndicator();
        return;
      } catch (e) {
        // The handle may have become invalid (e.g. file moved/deleted) —
        // ask for a new location, same as on the first save.
        currentFileHandle = null;
      }
    }

    const name = document.getElementById('filename-input').value.trim() || 'diagram';
    const filename = name.endsWith('.bpmn') ? name : name + '.bpmn';

    if (window.showSaveFilePicker) {
      // File System Access API — native "Save as" picker
      const handle = await window.showSaveFilePicker({
        suggestedName: filename,
        types: [{ description: 'BPMN diagram', accept: { 'application/xml': ['.bpmn', '.xml'] } }]
      });
      const writable = await handle.createWritable();
      await writable.write(xml);
      await writable.close();
      currentFileHandle = handle;
      await rememberLastFileHandle(handle);
      // Update the filename in the field
      const savedBase = handle.name.replace(/\.bpmn$|\.xml$/i, '');
      document.getElementById('filename-input').value = savedBase;
      currentFilename = savedBase;
      hasUnsavedChanges = false;
      setStatus('Saved: ' + handle.name, 'ok');
      updateTree();
      updateBreadcrumb();
      updateAutosaveIndicator();
    } else {
      // Fallback for browsers without the File System Access API
      const blob = new Blob([xml], { type: 'application/xml' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = filename;
      a.click();
      URL.revokeObjectURL(a.href);
      setStatus('Downloaded: ' + filename, 'ok');
    }
  } catch(e) {
    if (e.name === 'AbortError') {
      setStatus('Save canceled', '');
    } else {
      setStatus('Save error: ' + e.message, 'err');
    }
  }
}

/* ─── EXPORT (PNG / PDF) OF THE CURRENTLY VISIBLE PROCESS ───
   Exports only the current plane — main process, or whichever sub-process
   you've drilled into — never the whole tree. bpmn-js's own modeler.saveSVG()
   already does exactly that: it reads canvas.getActiveLayer() (the plane
   currently rendered on screen) and its bounding box, so other planes are
   never touched. That SVG is then rasterized onto an offscreen canvas sized
   to the diagram's own bounding box (in its own coordinate units) times a
   fixed supersampling factor — NOT a fixed page size like A4 — so resolution
   scales with how big/complex the current view actually is, capped only by
   a safety ceiling so an enormous diagram can't produce a canvas bigger than
   some browsers/OSes can rasterize. */

const EXPORT_RASTER_SCALE = 3;
const EXPORT_MAX_DIMENSION_PX = 8000;

function toggleExportMenu(event) {
  event.stopPropagation();
  const menu = document.getElementById('export-menu');
  if (!menu) return;
  if (menu.style.display === 'flex') {
    closeExportMenu();
    return;
  }
  const btn = document.getElementById('export-toggle');
  const rect = btn.getBoundingClientRect();
  menu.style.left = rect.left + 'px';
  menu.style.top = (rect.bottom + 4) + 'px';
  // 'flex' (not 'block') — the CSS lays this out as a column flexbox, and an
  // inline style always wins over the stylesheet's own `display: flex`, so
  // setting the wrong value here would silently break the stacked layout.
  menu.style.display = 'flex';
  // Deferred: the click that just opened the menu would otherwise
  // immediately bubble into this same listener and close it right away.
  setTimeout(() => document.addEventListener('click', closeExportMenuOnOutsideClick), 0);
}

function closeExportMenu() {
  const menu = document.getElementById('export-menu');
  if (menu) menu.style.display = 'none';
  document.removeEventListener('click', closeExportMenuOnOutsideClick);
}

function closeExportMenuOnOutsideClick(e) {
  const menu = document.getElementById('export-menu');
  const btn = document.getElementById('export-toggle');
  if (menu && !menu.contains(e.target) && e.target !== btn) closeExportMenu();
}

async function exportCurrentView(format) {
  closeExportMenu();
  if (!modeler) return;
  setStatus('Preparing ' + format.toUpperCase() + ' export…', '');
  try {
    const { svg } = await modeler.saveSVG();
    // An empty plane (no shapes) gives saveSVG() a zero-size bounding box —
    // width="0" height="0" — rather than erroring. Catch that up front
    // instead of silently handing the user a blank white image/PDF.
    const emptyDims = parseSvgDimensions(svg);
    if (!emptyDims.width || !emptyDims.height) {
      setStatus('Nothing to export — this view is empty', 'err');
      return;
    }
    // saveSVG() only ever serializes the diagram's own shapes/connections —
    // dictionary badges and the details-link icon are separate HTML overlays
    // diagram-js positions on top of the canvas (shown/hidden by the
    // Extended details toggle), so without this the export would silently
    // drop whatever's currently visible there. collectExportOverlays() reads
    // them straight off the live DOM; widenSvgForOverlays() grows the
    // exported SVG's own bounding box first (a badge can sit outside the
    // plane's element bbox) so nothing gets clipped once drawn back in.
    const overlays = collectExportOverlays();
    const { svg: svgResized, viewBox } = widenSvgForOverlays(svg, overlays);
    const raster = await rasterizeSvgToCanvas(svgResized);
    drawExportOverlays(raster, overlays, viewBox);
    const baseName = sanitizeFilename(suggestedExportBaseName());

    if (format === 'png') {
      const blob = await canvasToPngBlob(raster.canvas);
      await saveBlobToFile(blob, baseName + '.png', 'PNG image', { 'image/png': ['.png'] });
      setStatus('Exported: ' + baseName + '.png', 'ok');
    } else {
      if (!window.jspdf || !window.jspdf.jsPDF) throw new Error('PDF library not loaded');
      const { jsPDF } = window.jspdf;
      // Custom page size in px, exactly matching the rasterized image — the
      // point is to avoid forcing the diagram into a fixed page like A4,
      // which would either crop it or shrink it down to illegibility.
      const orientation = raster.pixelWidth >= raster.pixelHeight ? 'landscape' : 'portrait';
      const doc = new jsPDF({
        orientation,
        unit: 'px',
        format: [raster.pixelWidth, raster.pixelHeight],
        compress: true
      });
      const dataUrl = raster.canvas.toDataURL('image/png');
      doc.addImage(dataUrl, 'PNG', 0, 0, raster.pixelWidth, raster.pixelHeight);
      const blob = doc.output('blob');
      await saveBlobToFile(blob, baseName + '.pdf', 'PDF document', { 'application/pdf': ['.pdf'] });
      setStatus('Exported: ' + baseName + '.pdf', 'ok');
    }
  } catch (e) {
    if (e.name === 'AbortError') {
      setStatus('Export canceled', '');
    } else {
      setStatus('Export error: ' + e.message, 'err');
    }
  }
}

// Reads every dict-badge / details-link overlay currently in the DOM (for
// the current plane only, same as what's on screen — refreshDetailOverlays()
// only ever populates these when Extended details is on) and converts each
// one's on-screen pixel position/size back into the plane's own
// model-coordinate space — the same space saveSVG()'s viewBox uses — via
// the canvas's current zoom/scroll (canvas.viewbox()). That makes the
// result independent of whatever the user happened to have panned/zoomed to
// when exporting.
//
// These are deliberately NOT rendered by drawing the overlay HTML into an
// <svg><foreignObject> and rasterizing that — Chromium permanently taints
// any canvas a <foreignObject>-bearing SVG is drawn onto ("Tainted canvases
// may not be exported"), which would break toBlob()/toDataURL() for the
// rest of the export. drawExportOverlays() instead repaints each one with
// plain Canvas2D primitives once the (untainted) diagram image is already
// on the canvas.
//
// Returns null when nothing is visible to add, otherwise
// { items: [{kind, x, y, width, height, ...}], bounds: {minX,minY,maxX,maxY} }
// (x/y/width/height in model units).
function collectExportOverlays() {
  if (!modeler) return null;
  const canvas = modeler.get('canvas');
  const container = canvas.getContainer();
  const containerRect = container.getBoundingClientRect();
  if (!containerRect.width || !containerRect.height) return null;
  const viewbox = canvas.viewbox();
  const scale = viewbox.scale || 1;

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const items = [];

  function toModelRect(rect) {
    return {
      x: viewbox.x + (rect.left - containerRect.left) / scale,
      y: viewbox.y + (rect.top - containerRect.top) / scale,
      width: rect.width / scale,
      height: rect.height / scale
    };
  }

  container.querySelectorAll('.djs-overlay-dict-badge').forEach(ov => {
    const span = ov.querySelector('.dict-badge-overlay');
    const rect = ov.getBoundingClientRect();
    if (!span || !rect.width || !rect.height) return;
    const m = toModelRect(rect);
    items.push({
      kind: 'dict-badge',
      x: m.x, y: m.y, width: m.width, height: m.height,
      label: span.textContent || '',
      bgColor: span.style.background || '#cce5ff',
      textColor: span.style.color || '#222'
    });
    minX = Math.min(minX, m.x); minY = Math.min(minY, m.y);
    maxX = Math.max(maxX, m.x + m.width); maxY = Math.max(maxY, m.y + m.height);
  });

  container.querySelectorAll('.djs-overlay-detail-link').forEach(ov => {
    const rect = ov.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const m = toModelRect(rect);
    items.push({ kind: 'detail-link', x: m.x, y: m.y, width: m.width, height: m.height });
    minX = Math.min(minX, m.x); minY = Math.min(minY, m.y);
    maxX = Math.max(maxX, m.x + m.width); maxY = Math.max(maxY, m.y + m.height);
  });

  if (!items.length) return null;
  return { items, bounds: { minX, minY, maxX, maxY } };
}

// Widens a saveSVG() string's own width/height/viewBox (only if needed) so
// that any overlay extending past the plane's element bounding box — a
// badge below the bottom-most shape, a details-link icon above the topmost
// one — has room to be drawn without being clipped by the SVG viewport.
// Always returns the (possibly unchanged) viewBox alongside the svg string,
// since drawExportOverlays() needs it to convert model coordinates to
// pixels on the rasterized canvas.
function widenSvgForOverlays(svgStr, overlaysInfo) {
  const viewBoxMatch = svgStr.match(/viewBox="([-\d.]+) ([-\d.]+) ([-\d.]+) ([-\d.]+)"/);
  const vbX = viewBoxMatch ? parseFloat(viewBoxMatch[1]) : 0;
  const vbY = viewBoxMatch ? parseFloat(viewBoxMatch[2]) : 0;
  const vbW = viewBoxMatch ? parseFloat(viewBoxMatch[3]) : parseSvgDimensions(svgStr).width;
  const vbH = viewBoxMatch ? parseFloat(viewBoxMatch[4]) : parseSvgDimensions(svgStr).height;

  if (!overlaysInfo) return { svg: svgStr, viewBox: { x: vbX, y: vbY, width: vbW, height: vbH } };

  const { minX, minY, maxX, maxY } = overlaysInfo.bounds;
  const newMinX = Math.min(vbX, minX);
  const newMinY = Math.min(vbY, minY);
  const newW = Math.max(vbX + vbW, maxX) - newMinX;
  const newH = Math.max(vbY + vbH, maxY) - newMinY;

  if (newMinX === vbX && newMinY === vbY && newW === vbW && newH === vbH) {
    return { svg: svgStr, viewBox: { x: vbX, y: vbY, width: vbW, height: vbH } };
  }
  const out = svgStr
    .replace(/\swidth="[\d.]+"/, ' width="' + newW + '"')
    .replace(/\sheight="[\d.]+"/, ' height="' + newH + '"')
    .replace(/viewBox="[-\d.]+ [-\d.]+ [-\d.]+ [-\d.]+"/, 'viewBox="' + newMinX + ' ' + newMinY + ' ' + newW + ' ' + newH + '"');
  return { svg: out, viewBox: { x: newMinX, y: newMinY, width: newW, height: newH } };
}

// Paints collectExportOverlays()'s items directly onto the already-rasterized
// export canvas, in the exact position/size they occupy on screen — see
// collectExportOverlays() for why this uses Canvas2D primitives rather than
// compositing HTML/SVG.
function drawExportOverlays(raster, overlaysInfo, viewBox) {
  if (!overlaysInfo || !viewBox || !viewBox.width) return;
  const ctx = raster.canvas.getContext('2d');
  const pixelScale = raster.pixelWidth / viewBox.width;

  overlaysInfo.items.forEach(item => {
    const px = (item.x - viewBox.x) * pixelScale;
    const py = (item.y - viewBox.y) * pixelScale;
    const pw = item.width * pixelScale;
    const ph = item.height * pixelScale;
    if (item.kind === 'dict-badge') drawExportDictBadge(ctx, px, py, pw, ph, item, pixelScale);
    else if (item.kind === 'detail-link') drawExportDetailLink(ctx, px, py, pw, ph, pixelScale);
  });
}

function exportRoundRectPath(ctx, x, y, w, h, r) {
  r = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// Greedy word-wrap identical in spirit to the CSS the on-screen badge uses
// (white-space: normal / word-break: break-word) — not pixel-identical to
// the browser's own line breaking, but visually equivalent for the short
// labels dictionary items actually have.
function exportWrapText(ctx, text, maxWidth) {
  const words = String(text).split(/\s+/).filter(Boolean);
  if (!words.length) return [''];
  const lines = [];
  let current = words[0];
  for (let i = 1; i < words.length; i++) {
    const test = current + ' ' + words[i];
    if (ctx.measureText(test).width <= maxWidth) current = test;
    else { lines.push(current); current = words[i]; }
  }
  lines.push(current);
  return lines;
}

// Replicates the .dict-badge-overlay CSS (assets/css/app.css): rounded
// colored pill, centered bold text, soft drop shadow.
function drawExportDictBadge(ctx, px, py, pw, ph, item, pixelScale) {
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.25)';
  ctx.shadowBlur = 3 * pixelScale;
  ctx.shadowOffsetY = 1 * pixelScale;
  ctx.fillStyle = item.bgColor;
  exportRoundRectPath(ctx, px, py, pw, ph, 4 * pixelScale);
  ctx.fill();
  ctx.restore();

  const fontSize = 10 * pixelScale;
  ctx.fillStyle = item.textColor;
  ctx.font = '600 ' + fontSize + 'px Arial, Helvetica, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const paddingX = 7 * pixelScale;
  const maxTextWidth = Math.max(1, pw - paddingX * 2);
  const lines = exportWrapText(ctx, item.label, maxTextWidth);
  const lineHeight = fontSize * 1.4;
  const startY = py + ph / 2 - ((lines.length - 1) * lineHeight) / 2;
  lines.forEach((line, i) => {
    ctx.fillText(line, px + pw / 2, startY + i * lineHeight, maxTextWidth);
  });
}

// Replicates the .detail-link-overlay CSS: filled circle, white ring, globe icon.
function drawExportDetailLink(ctx, px, py, pw, ph, pixelScale) {
  const cx = px + pw / 2, cy = py + ph / 2, r = Math.min(pw, ph) / 2;
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.3)';
  ctx.shadowBlur = 3 * pixelScale;
  ctx.shadowOffsetY = 1 * pixelScale;
  ctx.fillStyle = '#1a6bb5';
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  const ringWidth = 2 * pixelScale;
  ctx.lineWidth = ringWidth;
  ctx.strokeStyle = '#fff';
  ctx.beginPath();
  ctx.arc(cx, cy, Math.max(0, r - ringWidth / 2), 0, Math.PI * 2);
  ctx.stroke();

  // Globe icon — circle + one vertical meridian ellipse + one horizontal
  // equator line, matching GLOBE_ICON_SVG used on-screen (see notes there).
  const iconR = r * 0.63;
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 1.1 * pixelScale;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.arc(cx, cy, iconR, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.ellipse(cx, cy, iconR * 0.47, iconR, 0, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(cx - iconR, cy);
  ctx.lineTo(cx + iconR, cy);
  ctx.stroke();
}

// Reads the width/height bpmn-js's saveSVG() sets on the root <svg> element
// from the current plane's own bounding box — zero for a genuinely empty
// plane, otherwise the diagram's real size in its own coordinate units.
function parseSvgDimensions(svgStr) {
  const widthMatch = svgStr.match(/\swidth="([\d.]+)"/);
  const heightMatch = svgStr.match(/\sheight="([\d.]+)"/);
  return {
    width: widthMatch ? parseFloat(widthMatch[1]) : 0,
    height: heightMatch ? parseFloat(heightMatch[1]) : 0
  };
}

// Renders an SVG string onto an offscreen <canvas>, sized to the SVG's own
// width/height (as set by saveSVG() from its bounding box) times
// EXPORT_RASTER_SCALE, clamped so neither dimension exceeds
// EXPORT_MAX_DIMENSION_PX (scaling both sides down together to preserve the
// aspect ratio if it would).
function rasterizeSvgToCanvas(svgStr) {
  return new Promise((resolve, reject) => {
    const dims = parseSvgDimensions(svgStr);
    let svgWidth = dims.width, svgHeight = dims.height;
    // Callers are expected to have already rejected a genuinely empty plane
    // (see exportCurrentView) — this fallback only guards against an
    // unexpected/malformed saveSVG() result, not the empty-diagram case.
    if (!svgWidth || !svgHeight) { svgWidth = svgWidth || 800; svgHeight = svgHeight || 600; }

    let scale = EXPORT_RASTER_SCALE;
    const largestSide = Math.max(svgWidth, svgHeight) * scale;
    if (largestSide > EXPORT_MAX_DIMENSION_PX) {
      scale = EXPORT_MAX_DIMENSION_PX / Math.max(svgWidth, svgHeight);
    }
    scale = Math.max(scale, 1);

    const pixelWidth = Math.max(1, Math.round(svgWidth * scale));
    const pixelHeight = Math.max(1, Math.round(svgHeight * scale));

    const svgBlob = new Blob([svgStr], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(svgBlob);
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = pixelWidth;
      canvas.height = pixelHeight;
      const ctx = canvas.getContext('2d');
      // The SVG itself has a transparent background (diagram-js draws only
      // shapes/connections, not a page backdrop) — fill with the same
      // canvas background color the user sees on screen (Settings → Canvas
      // background) so the export doesn't come out see-through.
      ctx.fillStyle = (appColors && appColors.canvasBg) || '#ffffff';
      ctx.fillRect(0, 0, pixelWidth, pixelHeight);
      ctx.drawImage(img, 0, 0, pixelWidth, pixelHeight);
      URL.revokeObjectURL(url);
      resolve({ canvas, pixelWidth, pixelHeight });
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Could not render the diagram to an image'));
    };
    img.src = url;
  });
}

function canvasToPngBlob(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('Could not create PNG')), 'image/png');
  });
}

// "<file name> - <sub-process/Call Activity target name>" for anything below
// the main process, or just the file name at the top level — mirrors the
// label already shown in the breadcrumb for whatever's currently on screen.
function suggestedExportBaseName() {
  const root = getCurrentRoot();
  const base = currentFilename || 'diagram';
  if (!root || !root.businessObject) return base;
  const t = root.businessObject.$type;
  if (t === 'bpmn:Process' || t === 'bpmn:Collaboration') return base;
  return base + ' - ' + getBreadcrumbLabel(root);
}

function sanitizeFilename(name) {
  return (name || 'diagram').replace(/[\\/:*?"<>|]+/g, '_').trim() || 'diagram';
}

// Shared by both export formats: native "Save as" picker when available
// (Chromium — same mechanism the Save button already uses), falling back to
// a plain download link elsewhere. Unlike Save, exports never reuse a
// remembered file handle — each export asks where to put it.
async function saveBlobToFile(blob, suggestedName, description, acceptMap) {
  if (window.showSaveFilePicker) {
    const handle = await window.showSaveFilePicker({
      suggestedName,
      types: [{ description, accept: acceptMap }]
    });
    const writable = await handle.createWritable();
    await writable.write(blob);
    await writable.close();
    return;
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = suggestedName;
  a.click();
  URL.revokeObjectURL(a.href);
}

/* ─── AUTO-ZAPIS: implementacja ─── */

function scheduleAutosave() {
  if (!autosaveEnabled || !currentFileHandle) return;
  if (autosaveTimer) clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(performAutosave, AUTOSAVE_DELAY_MS);
}

async function performAutosave() {
  autosaveTimer = null;
  if (!autosaveEnabled || !currentFileHandle || !hasUnsavedChanges) return;
  try {
    const { xml } = await modeler.saveXML({ format: true });
    const writable = await currentFileHandle.createWritable();
    await writable.write(xml);
    await writable.close();
    hasUnsavedChanges = false;
    const time = new Date().toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    setStatus('Auto-saved at ' + time, 'ok');
  } catch (e) {
    setStatus('Auto-save error: ' + e.message, 'err');
  }
}

function toggleAutosave() {
  autosaveEnabled = !autosaveEnabled;
  updateAutosaveIndicator();
  if (autosaveEnabled && hasUnsavedChanges && currentFileHandle) scheduleAutosave();
}

function updateAutosaveIndicator() {
  const btn = document.getElementById('autosave-toggle');
  if (!btn) return;
  if (!window.showSaveFilePicker) {
    btn.textContent = 'Auto-save';
    btn.title = 'This browser does not support the File System Access API — auto-save needs it.';
    btn.classList.remove('primary');
    btn.disabled = true;
    return;
  }
  btn.disabled = false;
  btn.textContent = 'Auto-save';
  btn.classList.toggle('primary', autosaveEnabled);
  btn.title = currentFileHandle
    ? (autosaveEnabled
      ? 'Auto-save active — saving to file: ' + currentFileHandle.name
      : 'Auto-save is off')
    : 'Auto-save turns on automatically after the first “Save” or “Open…”';
}

// Native browser warning when trying to close/refresh the page with unsaved changes —
// a safety net in case auto-save hasn't had a chance to run yet (or is unavailable).
window.addEventListener('beforeunload', (e) => {
  if (hasUnsavedChanges) {
    e.preventDefault();
    e.returnValue = '';
  }
});

async function triggerFileOpen() {
  // First try the native picker (File System Access API) — this gives us
  // a file handle so we can later save/auto-save without asking.
  if (window.showOpenFilePicker) {
    try {
      const [handle] = await window.showOpenFilePicker({
        types: [{ description: 'BPMN diagram', accept: { 'application/xml': ['.bpmn', '.xml'] } }]
      });
      const file = await handle.getFile();
      const text = await file.text();
      currentFileHandle = handle;
      await rememberLastFileHandle(handle);
      await importXml(text, file.name);
      updateAutosaveIndicator();
      return;
    } catch (e) {
      if (e.name === 'AbortError') return; // user cancelled the file picker
      // on an unexpected error — fall back to the old method below
    }
  }
  document.getElementById('file-input').click();
}

function openFile(event) {
  const file = event.target.files[0];
  if (!file) return;
  currentFileHandle = null; // this loading method doesn't give us a save handle
  // Without a handle, THIS file can't be automatically restored after an F5 — and
  // re-opening the previously remembered (different) file would be confusing,
  // since the user just opened something else. Forget it.
  forgetLastFileHandle();
  const reader = new FileReader();
  reader.onload = async e => { await importXml(e.target.result, file.name); updateAutosaveIndicator(); };
  reader.readAsText(file);
  event.target.value = '';
}

async function importXml(xml, filename) {
  navStack = [];
  collapsedTreeIds = new Set();
  try {
    // Add the camunda namespace if it's missing — needed for extensionElements
    if (!xml.includes('xmlns:camunda')) {
      xml = xml.replace('<bpmn:definitions ', '<bpmn:definitions xmlns:camunda="http://camunda.org/schema/1.0/bpmn" ');
      xml = xml.replace('<definitions ', '<definitions xmlns:camunda="http://camunda.org/schema/1.0/bpmn" ');
    }
    await modeler.importXML(xml);
    fitViewport();
    updateBreadcrumb();
    updateTree();
    if (filename) {
      const base = filename.replace(/\.bpmn$|\.xml$/i, '');
      document.getElementById('filename-input').value = base;
      currentFilename = base;
    } else {
      currentFilename = '';
    }
    setStatus('Loaded: ' + (filename || 'diagram'), 'ok');
    if (xmlPanelVisible) await refreshXmlPanel();
    loadMetaFromModel();
    // Merge dictionaries embedded in this file into what we already have —
    // makes Systems/Locations portable across computers without silently
    // dropping local-only entries not yet saved into any file.
    const embeddedDicts = loadDictionariesFromModel();
    if (embeddedDicts) {
      // A file saved by an older version of the app embeds the legacy
      // { systems, locations, devices } shape — migrate it the same way a
      // legacy localStorage value would be, before merging.
      const embeddedNormalized = Array.isArray(embeddedDicts.list) ? normalizeDictionaries(embeddedDicts) : migrateLegacyDictionaries(embeddedDicts);
      dictionaries = mergeDictionaries(dictionaries, embeddedNormalized);
      saveDictionaries();
    }
    flushDictionariesToModel();
    // Refresh the breadcrumb after setting currentFilename
    updateBreadcrumb();
    updateTree();
    refreshDetailOverlays();
    renderGridBackground();
    focusCanvas();
  } catch(e) {
    setStatus('Import error: ' + e.message, 'err');
  }
}

async function toggleXmlPanel() {
  xmlPanelVisible = !xmlPanelVisible;
  document.getElementById('xml-panel').classList.toggle('visible', xmlPanelVisible);
  if (xmlPanelVisible) await refreshXmlPanel();
}

async function refreshXmlPanel() {
  try {
    const { xml } = await modeler.saveXML({ format: true });
    document.getElementById('xml-textarea').value = xml;
  } catch(e) {}
}

async function importFromXmlPanel() {
  await importXml(document.getElementById('xml-textarea').value);
}

async function copyXml() {
  const xml = document.getElementById('xml-textarea').value;
  await navigator.clipboard.writeText(xml);
  setStatus('XML copied', 'ok');
}

/* ─── OPIS I DETAILS — zapis przez documentation + custom attr ─── */

function getElementMeta(bo, key) {
  try {
    // Use a simple in-memory store keyed by the element's id
    return (window._bpmnMeta && window._bpmnMeta[bo.id] && window._bpmnMeta[bo.id][key]) || '';
  } catch(e) { return ''; }
}

function setElementMeta(bo, key, value) {
  if (!window._bpmnMeta) window._bpmnMeta = {};
  if (!window._bpmnMeta[bo.id]) window._bpmnMeta[bo.id] = {};
  window._bpmnMeta[bo.id][key] = value;
}

// Serialize metadata to XML as a documentation element
function flushMetaToModel() {
  if (!window._bpmnMeta || !modeler) return;
  const er = modeler.get('elementRegistry');
  const modeling = modeler.get('modeling');
  Object.entries(window._bpmnMeta).forEach(([id, data]) => {
    const el = er.get(id);
    if (!el || !el.businessObject) return;
    const bo = el.businessObject;
    // Save as JSON in the first documentation element
    const metaStr = JSON.stringify(data);
    try {
      modeling.updateProperties(el, {
        'custom:description': data.description || '',
        'custom:details': data.details || ''
      });
    } catch(e) {}
    // Store in documentation
    try {
      const bpmnFactory = modeler.get('bpmnFactory');
      let docs = bo.documentation || [];
      const metaDoc = docs.find(d => d.textFormat === 'application/json+bpmn-meta');
      if (metaDoc) {
        metaDoc.text = metaStr;
      } else {
        const newDoc = bpmnFactory.create('bpmn:Documentation', {
          textFormat: 'application/json+bpmn-meta',
          text: metaStr
        });
        modeling.updateProperties(el, { documentation: [...docs, newDoc] });
      }
    } catch(e) {}
  });
}

function loadMetaFromModel() {
  if (!modeler) return;
  window._bpmnMeta = {};
  const er = modeler.get('elementRegistry');
  er.getAll().forEach(el => {
    if (!el.businessObject) return;
    const bo = el.businessObject;
    const docs = bo.documentation || [];
    const metaDoc = docs.find(d => d.textFormat === 'application/json+bpmn-meta');
    if (metaDoc && metaDoc.text) {
      try {
        window._bpmnMeta[bo.id] = JSON.parse(metaDoc.text);
      } catch(e) {}
    }
  });
}

/* ─── EXTENDED DETAILS ───
   When on, elements with "Details (URL)" set get a small arrow icon above
   the top-right corner (opens the URL in a new tab), and elements with a
   "System" assigned get a colored badge below the bottom-left corner. */

// Icon size (must match width/height of .detail-link-overlay in CSS) and the
// gap used on both axes around it, so it sits just outside the element's
// corner rather than flush against an edge — diagonally clear of it, the
// same way the two corner icons (globe above, ↘ enter-arrow below) stay
// clear of any edge-aligned label (Time-duration, dict badges, ...) instead
// of competing with them for the same strip of space.
// Note on bpmn-js math: "right"/"bottom" in an overlay's position are
// measured from the element's OWN left/top edge going outward, so a
// positive value of X pixels moves the icon X pixels INSIDE the element
// (e.g. right: SIZE lines the icon up flush with the right edge); a
// NEGATIVE value moves it that many pixels OUTSIDE the edge instead — which
// is what places these icons past the corner rather than on top of it.
const DETAIL_OVERLAY_SIZE = 20;
const DETAIL_OVERLAY_GAP = 3;

// "Extra info / URL" icon — a plain globe (circle + one meridian ellipse +
// one equator line), monochrome so it reads clearly at 20px and doesn't
// depend on an emoji font being installed (unlike e.g. "🌐", which can
// render as a missing-glyph box in some environments). Kept distinct from
// the Call Activity "enter subprocess" arrow below so the two affordances
// aren't confused with each other.
const GLOBE_ICON_SVG = `<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="#fff" stroke-width="1.3" stroke-linecap="round">
  <circle cx="8" cy="8" r="6.3"/>
  <ellipse cx="8" cy="8" rx="3" ry="6.3"/>
  <line x1="1.8" y1="8" x2="14.2" y2="8"/>
</svg>`;

// Gap between the element's bottom edge and the system badge below it.
const SYSTEM_BADGE_GAP = 6;

// Location badge sits above the element, on the left (mirror of the URL icon,
// which sits above on the right) — needs its own approx. rendered height,
// same reasoning as DETAIL_OVERLAY_SIZE above: with a "top" position the
// overlay is placed by its OWN top edge, so we must move it up by gap+height
// to clear the element with a visible gap. Value calibrated against the
// actual rendered badge height (see refreshDetailOverlays()).
const LOCATION_OVERLAY_GAP = 6;
// Empirically-measured correction between the element's visual bounding box
// and where diagram-js actually anchors an overlay's own top edge (a couple
// px, most likely from the shape's stroke) — combined with the badge's real
// rendered height (see measureBadgeHeight()) this gives a pixel-accurate
// "top" offset so the gap above the element is always exactly GAP, whether
// the label is one line or has wrapped to two.
const LOCATION_OVERLAY_TOP_CORRECTION = 2;

// Dictionary badges (System below, Location above) wrap to a second line
// once the label would be wider than this fraction of the element's own
// width, instead of overflowing sideways.
const DICT_BADGE_MAX_WIDTH_RATIO = 0.75;

// Gap between an element's right edge and its Time-duration label (same
// convention as DETAIL_OVERLAY_GAP/SYSTEM_BADGE_GAP above), and between a
// sequence flow's exit point and its % label.
const TIME_OVERLAY_GAP = 6;

// Renders an identical, invisible probe badge to find out how tall it will
// actually be (1 line vs. wrapped 2 lines) for a given label + max-width,
// so callers can position it precisely before it ever appears on screen.
function measureBadgeHeight(className, text, maxWidthPx) {
  const probe = document.createElement('span');
  probe.className = className;
  probe.style.position = 'fixed';
  probe.style.visibility = 'hidden';
  probe.style.left = '-9999px';
  probe.style.top = '0';
  probe.style.maxWidth = maxWidthPx + 'px';
  probe.style.width = 'max-content';
  probe.textContent = text;
  document.body.appendChild(probe);
  const height = probe.getBoundingClientRect().height;
  document.body.removeChild(probe);
  return height;
}

// Same probe trick as measureBadgeHeight(), but for width — used by the
// Device badge (bottom-right corner) to know how far to shift its "right"
// offset so the badge's own right edge lands exactly on the element's right
// edge and it grows LEFTWARD as the label gets longer, mirroring how the
// System badge (bottom-left) grows rightward and the Location badge
// (top-left) grows upward. See the "right" positioning note on
// DETAIL_OVERLAY_SIZE above — diagram-js's overlay "right" is a left-shift
// by that many px from the element's right edge, not a real CSS "right".
function measureBadgeWidth(className, text, maxWidthPx) {
  const probe = document.createElement('span');
  probe.className = className;
  probe.style.position = 'fixed';
  probe.style.visibility = 'hidden';
  probe.style.left = '-9999px';
  probe.style.top = '0';
  probe.style.maxWidth = maxWidthPx + 'px';
  probe.style.width = 'max-content';
  probe.textContent = text;
  document.body.appendChild(probe);
  const width = probe.getBoundingClientRect().width;
  document.body.removeChild(probe);
  return width;
}

// Element types without their own Description/Details/System fields — same
// list used by updatePropsPanel (single- and multi-select) and the
// overlay-rendering code, so overlays only ever appear where these fields
// can actually be set.
const DETAIL_FIELDS_EXCLUDED_TYPES = ['bpmn:SequenceFlow', 'bpmn:MessageFlow', 'bpmn:Association',
  'bpmn:DataInputAssociation', 'bpmn:DataOutputAssociation'];

// Element types without a fill-color field (pool/lane headers aren't filled
// via the color picker; connections have no fill). Shared by the
// single-select and multi-select Properties panels.
const NO_COLOR_TYPES = ['bpmn:SequenceFlow', 'bpmn:MessageFlow', 'bpmn:Association',
  'bpmn:DataInputAssociation', 'bpmn:DataOutputAssociation', 'bpmn:Lane', 'bpmn:Participant'];

let extendedDetailsEnabled = false;
try { extendedDetailsEnabled = localStorage.getItem('bpmnEditor.extendedDetails') === '1'; } catch(e) {}
let detailOverlayIds = [];
let enterOverlayIds = [];

// Time analysis (Settings toggle) — v1 scope is fields + on-canvas display
// only, no calculation engine. Independent of extendedDetailsEnabled: both
// are checked separately inside the same refreshDetailOverlays() loop.
let timeAnalysisEnabled = false;
try { timeAnalysisEnabled = localStorage.getItem('bpmnEditor.timeAnalysis') === '1'; } catch(e) {}
let timeOverlayIds = [];

function toggleExtendedDetails() {
  extendedDetailsEnabled = !extendedDetailsEnabled;
  try { localStorage.setItem('bpmnEditor.extendedDetails', extendedDetailsEnabled ? '1' : '0'); } catch(e) {}
  updateExtendedDetailsButton();
  refreshDetailOverlays();
}

function updateExtendedDetailsButton() {
  const btn = document.getElementById('extended-details-toggle');
  if (!btn) return;
  btn.textContent = 'Extended';
  btn.classList.toggle('primary', extendedDetailsEnabled);
  btn.title = extendedDetailsEnabled
    ? 'Extended details are on — elements with a URL show a link icon, elements with a System/Location/Device show a badge'
    : 'Extended details are off';
}

// Toggling off hides Time-analysis fields/overlays but does NOT clear the
// underlying 'time'/'probability' meta values — same behavior as Extended
// details above, so re-enabling restores everything as it was.
function toggleTimeAnalysis() {
  timeAnalysisEnabled = !timeAnalysisEnabled;
  try { localStorage.setItem('bpmnEditor.timeAnalysis', timeAnalysisEnabled ? '1' : '0'); } catch(e) {}
  refreshDetailOverlays();
  if (modeler) updatePropsPanel(modeler.get('selection').get());
}

// "Enter" arrow for anything you can drill down into: Call Activities (which
// never get bpmn-js's own native "drilldown" arrow overlay at all — that
// built-in affordance, see _canDrillDown in the vendor bundle, is hard-wired
// to bpmn:SubProcess only, regardless of whether a Call Activity has a
// calledElement set) AND real collapsed bpmn:SubProcess/AdHocSubProcess
// elements (which DO get a native one, but styled as bpmn-js's own big
// square arrow button — visually heavier/less consistent with the rest of
// this app's icons). Both cases get the exact same small blue-circle
// treatment as the "extra info" globe icon above, mirrored to the
// bottom-right corner with the same gap/size convention, with a ↘ arrow
// instead of the globe so the two affordances ("open a URL" vs. "enter this
// element") aren't confused with each other. The native square button for
// SubProcess/AdHocSubProcess is hidden via CSS (.bjs-drilldown in
// app.css) so it doesn't show up doubled alongside ours. Unlike the
// System/Location/Device badges below, this must stay visible regardless of
// the Extended-details toggle — it's core navigation, not an optional
// detail — so it's a separate always-on overlay set, refreshed from inside
// refreshDetailOverlays() (which already runs at every point the current
// plane's contents can change) rather than gated by it.
function refreshEnterOverlays() {
  if (!modeler) return;
  const overlays = modeler.get('overlays');

  enterOverlayIds.forEach(id => { try { overlays.remove(id); } catch(e) {} });
  enterOverlayIds = [];

  const planes = modeler.get('canvas')._planes || [];

  function addEnterOverlay(el, targetId, isEmpty, title, navigateCall) {
    try {
      const overlayId = overlays.add(el, 'enter-overlay', {
        position: { bottom: -DETAIL_OVERLAY_GAP, right: -DETAIL_OVERLAY_GAP },
        html: `<a class="detail-link-overlay" href="#" title="Open ${title}"
          style="${isEmpty ? 'opacity:0.55;' : ''}"
          onmousedown="event.stopPropagation()" onclick="event.preventDefault();${navigateCall}">↘</a>`
      });
      enterOverlayIds.push(overlayId);
    } catch(e) {
      // element may not have its own graphical representation — skip
    }
  }

  getElementsInCurrentPlane().forEach(el => {
    if (el.labelTarget) return;
    const bo = el.businessObject;
    if (!bo) return;

    if (bo.$type === 'bpmn:CallActivity') {
      const targetId = bo.calledElement;
      if (!targetId) return;
      const targetPlane = planes.find(p => p.rootElement && p.rootElement.businessObject &&
        p.rootElement.businessObject.id === targetId);
      if (!targetPlane) return; // target missing/deleted — no arrow to show
      const targetBo = targetPlane.rootElement.businessObject;
      const isEmpty = !(targetBo.flowElements && targetBo.flowElements.length);
      addEnterOverlay(el, targetId, isEmpty, escHtml(targetBo.name || targetId),
        `treeNavigateToCallActivity('${escHtml(el.id)}')`);
    } else if ((bo.$type === 'bpmn:SubProcess' || bo.$type === 'bpmn:AdHocSubProcess') && el.collapsed) {
      const isEmpty = !(bo.flowElements && bo.flowElements.length);
      addEnterOverlay(el, bo.id, isEmpty, escHtml(bo.name || bo.id),
        `treeNavigateTo('${escHtml(el.id)}')`);
    }
  });
}

// Approx. rendered size of the flow-probability/time-duration label (11px
// bold, single line, a couple of digits + "%") — used below to make sure the
// label's own NEAR edge clears the line by TIME_OVERLAY_GAP, not just its
// anchor point (an overlay's "top"/"left" position is its top-left corner,
// not its center — moving the corner away from the line by exactly GAP only
// works when the label extends AWAY from the line on that axis; when it
// extends TOWARDS the line instead, the offset has to cover the label's own
// width/height too, or the label still overlaps it).
const FLOW_LABEL_APPROX_WIDTH = 28;
const FLOW_LABEL_APPROX_HEIGHT = 15;

// Positions a small label near a sequence flow's exit point out of its
// source gateway. Connections don't carry a usable .x/.y/.width/.height (see
// notes at the top of this section), so the bbox has to be computed by hand
// from the waypoints, and the anchor is interpolated 35% along the first
// waypoint segment (rather than sitting exactly at the gateway corner) so
// that two closely-spaced outgoing flows don't produce overlapping labels.
// The label is then pushed off the line itself, perpendicular to its actual
// direction (not just "upward", which used to leave it sitting right on top
// of a vertical/diagonal line) by the same gap the Time-duration label uses
// next to a task.
function flowExitOverlayPosition(flowEl) {
  const wps = flowEl.waypoints;
  if (!wps || wps.length < 1) return null;
  const p0 = wps[0], p1 = wps[1] || wps[0];
  const dx = p1.x - p0.x, dy = p1.y - p0.y;
  const len = Math.sqrt(dx * dx + dy * dy) || 1;
  const t = 0.35;
  const anchor = { x: p0.x + dx * t, y: p0.y + dy * t };
  // Perpendicular unit vector. bpmn-js's own connection NAME label (e.g.
  // "Yes"/"No") sits above a mostly-horizontal flow and to the right of a
  // mostly-vertical one — rotating the OTHER way here (below/left instead)
  // keeps our % badge from landing on top of that name label, on top of
  // just clearing the line itself.
  const perpX = -dy / len, perpY = dx / len;
  // Moving right/down lands the label's near (top-left) edge directly GAP
  // away from the line — no extra correction needed. Moving left/up lands
  // the label's FAR edge there instead, so the near edge (right/bottom) is
  // only GAP away once the offset also covers the label's own width/height.
  const offsetX = perpX >= 0 ? perpX * TIME_OVERLAY_GAP : perpX * (TIME_OVERLAY_GAP + FLOW_LABEL_APPROX_WIDTH);
  const offsetY = perpY >= 0 ? perpY * TIME_OVERLAY_GAP : perpY * (TIME_OVERLAY_GAP + FLOW_LABEL_APPROX_HEIGHT);
  const gx = anchor.x + offsetX;
  const gy = anchor.y + offsetY;
  const bboxX = Math.min(...wps.map(w => w.x));
  const bboxY = Math.min(...wps.map(w => w.y));
  return { left: gx - bboxX, top: gy - bboxY };
}

function refreshDetailOverlays() {
  if (!modeler) return;
  const overlays = modeler.get('overlays');

  refreshEnterOverlays();

  // Remove previous overlays — easier to rebuild from scratch than to diff.
  detailOverlayIds.forEach(id => { try { overlays.remove(id); } catch(e) {} });
  detailOverlayIds = [];
  timeOverlayIds.forEach(id => { try { overlays.remove(id); } catch(e) {} });
  timeOverlayIds = [];

  if (!extendedDetailsEnabled && !timeAnalysisEnabled) return;

  // Only elements on the plane you're actually looking at — using the full
  // elementRegistry here previously leaked badges from a collapsed
  // sub-process shape (e.g. a System tag set on the sub-process itself, on
  // the main diagram) into that sub-process's own empty canvas once you
  // navigated inside it, since bpmn-js re-renders overlays whenever a
  // matching businessObject exists anywhere, not just on the current plane.
  getElementsInCurrentPlane().forEach(el => {
    // Some elements (currently: Groups with a name set) get a *separate*
    // registry entry for their external label — e.g. "Group_1_label" next
    // to "Group_1" — which shares the same businessObject as the shape it
    // labels (el.labelTarget points back to it). Without this guard we'd
    // process both and draw every badge twice: once anchored to the real
    // shape's bounds, once anchored to the small label-only bounds.
    if (el.labelTarget) return;
    const bo = el.businessObject;
    if (!bo || !bo.$type) return;

    if (extendedDetailsEnabled && !DETAIL_FIELDS_EXCLUDED_TYPES.includes(bo.$type)) {
      const url = (getElementMeta(bo, 'details') || '').trim();
      if (url) {
        try {
          const overlayId = overlays.add(el, 'detail-link', {
            position: { top: -(DETAIL_OVERLAY_GAP + DETAIL_OVERLAY_SIZE), right: -DETAIL_OVERLAY_GAP },
            html: `<a class="detail-link-overlay" href="${escHtml(url)}" target="_blank" rel="noopener"
              title="${escHtml(url)}" onmousedown="event.stopPropagation()">${GLOBE_ICON_SVG}</a>`
          });
          detailOverlayIds.push(overlayId);
        } catch(e) {
          // element may not have its own graphical representation (e.g. process root) — skip
        }
      }

      // Element width (model units, same coordinate space diagram-js uses for
      // overlay positioning) — badges wrap once their label would be wider
      // than DICT_BADGE_MAX_WIDTH_RATIO of this.
      const elWidth = el.width || 100;
      const maxWidthPx = elWidth * DICT_BADGE_MAX_WIDTH_RATIO;

      detailOverlayIds.push(...renderDictBadgesForElement(el, bo, maxWidthPx, overlays));
    }

    if (timeAnalysisEnabled) {
      // Manual duration on tasks/sub-processes/Call Activities — displayed to
      // the right of the shape, top-aligned with a standard gap, same font
      // treatment as the flow-probability label below.
      if (TIME_FIELD_TYPES.includes(bo.$type)) {
        const timeVal = (getElementMeta(bo, 'time') || '').trim();
        if (timeVal !== '') {
          try {
            const elWidth = el.width || 100;
            const overlayId = overlays.add(el, 'time-duration', {
              position: { top: 0, left: elWidth + TIME_OVERLAY_GAP },
              html: `<span class="time-duration-overlay">${escHtml(timeVal)}s</span>`
            });
            timeOverlayIds.push(overlayId);
          } catch(e) {}
        }
      }

      // % split label near where a flow exits an Exclusive gateway.
      if (bo.$type === 'bpmn:SequenceFlow' && el.waypoints && bo.sourceRef &&
          bo.sourceRef.$type === 'bpmn:ExclusiveGateway') {
        const pct = (getElementMeta(bo, 'probability') || '').trim();
        if (pct !== '') {
          const pos = flowExitOverlayPosition(el);
          if (pos) {
            try {
              const overlayId = overlays.add(el, 'flow-probability', {
                position: pos,
                html: `<span class="time-duration-overlay">${escHtml(pct)}%</span>`
              });
              timeOverlayIds.push(overlayId);
            } catch(e) {}
          }
        }
      }
    }
  });
}

// Renders every dictionary's badge for one element, grouped by the 4
// visible positions (Hide is simply skipped) and stacked within each group
// — ascending by that dictionary's own "sort" number, read top-to-bottom on
// screen. That single rule naturally produces the asymmetry the position
// picker implies: for a TOP group (badges sit above the element, growing
// upward) the row nearest the element is the LAST one placed, i.e. the
// HIGHEST sort; for a BOTTOM group (badges sit below, growing downward) the
// row nearest the element is the FIRST one placed, i.e. the LOWEST sort.
// Returns the list of overlay ids added, for the caller to track for later
// removal (same contract as the rest of refreshDetailOverlays()).
function renderDictBadgesForElement(el, bo, maxWidthPx, overlays) {
  const addedIds = [];

  // Collect one entry per dictionary that actually has a value set on this
  // element AND isn't set to Hide — grouped by resolved position.
  const groups = { 'left-top': [], 'right-top': [], 'left-bottom': [], 'right-bottom': [] };
  (dictionaries.list || []).forEach(dict => {
    if (!dict || dict.position === 'hide' || !groups[dict.position]) return;
    const valueId = (getElementMeta(bo, dict.metaKey) || '').trim();
    if (!valueId) return;
    const item = (dict.items || []).find(it => it.id === valueId);
    if (!item) return;
    groups[dict.position].push({ dict, item });
  });

  Object.keys(groups).forEach(position => {
    const entries = groups[position];
    if (!entries.length) return;

    const isTop = position === 'left-top' || position === 'right-top';
    const isRight = position === 'right-top' || position === 'right-bottom';

    // Nearest-to-the-element item goes first in this order — see comment
    // above for why that's ascending sort for a BOTTOM group but descending
    // sort for a TOP group.
    const ordered = entries.slice().sort((a, b) =>
      isTop ? (b.dict.sort - a.dict.sort) : (a.dict.sort - b.dict.sort)
    );

    // Running distance from the element's own edge to the near edge of the
    // next badge to place — seeded at the same gap a single badge already
    // used (so a lone badge in a group renders pixel-identical to before
    // this feature existed), then grown by each placed badge's own size
    // plus a gap, so later (farther) badges stack progressively outward.
    let runningOffset = isTop ? (LOCATION_OVERLAY_GAP + LOCATION_OVERLAY_TOP_CORRECTION) : SYSTEM_BADGE_GAP;

    ordered.forEach(({ dict, item }) => {
      const labelText = item.name || '?';
      const textColor = contrastTextColor(item.color);
      const className = 'dict-badge-overlay';
      const html = `<span class="${className}" style="background:${escHtml(item.color)}; color:${textColor}; max-width:${maxWidthPx}px; width:max-content;"
        title="${escHtml(dict.name || '')}: ${escHtml(item.name || '')}">${escHtml(labelText)}</span>`;

      try {
        if (isTop) {
          // Grows upward: measure height first so the badge's OWN bottom
          // edge lands exactly `runningOffset` above the element (or the
          // next badge out), same reasoning the single-badge Location code
          // used to use.
          const badgeHeight = measureBadgeHeight(className, labelText, maxWidthPx);
          const positionSpec = { top: -(runningOffset + badgeHeight) };
          if (isRight) positionSpec.right = measureBadgeWidth(className, labelText, maxWidthPx);
          else positionSpec.left = 0;
          const overlayId = overlays.add(el, 'dict-badge', { position: positionSpec, html });
          addedIds.push(overlayId);
          runningOffset += badgeHeight + SYSTEM_BADGE_GAP;
        } else {
          // Grows downward: the badge's own top edge is `runningOffset`
          // below the element (or the previous, nearer badge) — no height
          // needed for ITS OWN placement, only to know how far to push
          // whatever comes after it.
          const positionSpec = { bottom: -runningOffset };
          if (isRight) positionSpec.right = measureBadgeWidth(className, labelText, maxWidthPx);
          else positionSpec.left = 0;
          const overlayId = overlays.add(el, 'dict-badge', { position: positionSpec, html });
          addedIds.push(overlayId);
          const badgeHeight = measureBadgeHeight(className, labelText, maxWidthPx);
          runningOffset += badgeHeight + SYSTEM_BADGE_GAP;
        }
      } catch (e) {
        // element may not have its own graphical representation — skip
      }
    });
  });

  return addedIds;
}

/* ─── GRID BACKGROUND (#) ───
   Purely visual — a dashed grid drawn on the canvas to help with alignment.
   Does NOT change bpmn-js's own snap-to-grid behavior (that stays fixed at
   10px, built into the library). Three states cycled by clicking the button:
   0 = off, 10 = light-blue button + 10px grid, 50 = blue button + 50px grid.
   Whichever spacing is active, lines every 100px are drawn a bit darker so
   there's always a visible "every 100" reference regardless of 10 vs 50. */
const GRID_MAJOR_SPACING = 100;
const GRID_MEDIUM_SIZE = 50;
// Half-extent (in diagram units) of the grid rect around the origin — large
// enough that panning around a normal diagram never runs past its edge.
const GRID_HALF_EXTENT = 20000;
const SVG_NS = 'http://www.w3.org/2000/svg';

// "Small" grid size (# button's first non-off state) — user-configurable
// in Settings → General settings (default 10px, e.g. 20px per a request to
// support that). Restricted to values that evenly divide GRID_MAJOR_SPACING
// (100) — makeMinorGridPattern() builds one repeating tile sized to the
// major spacing containing every interior small-grid line, which only tiles
// seamlessly (no uneven gap at each 100px boundary) when 100 is a whole
// multiple of the small size. GRID_MEDIUM_SIZE (50) is excluded from the
// choices too, so the two non-off grid states can never collide.
const DEFAULT_SMALL_GRID_SIZE = 10;
const SMALL_GRID_SIZE_STORAGE_KEY = 'bpmnEditor.smallGridSize';
const VALID_SMALL_GRID_SIZES = Array.from({ length: GRID_MAJOR_SPACING - 1 }, (_, i) => i + 1)
  .filter(n => GRID_MAJOR_SPACING % n === 0 && n !== GRID_MEDIUM_SIZE);

function snapToValidSmallGridSize(v) {
  if (!Number.isFinite(v) || v < 1) return DEFAULT_SMALL_GRID_SIZE;
  if (VALID_SMALL_GRID_SIZES.includes(v)) return v;
  return VALID_SMALL_GRID_SIZES.reduce((best, n) =>
    Math.abs(n - v) < Math.abs(best - v) ? n : best, VALID_SMALL_GRID_SIZES[0]);
}

function loadSmallGridSize() {
  try {
    const v = parseInt(localStorage.getItem(SMALL_GRID_SIZE_STORAGE_KEY), 10);
    if (Number.isFinite(v)) return snapToValidSmallGridSize(v);
  } catch (e) {}
  return DEFAULT_SMALL_GRID_SIZE;
}
let smallGridSize = loadSmallGridSize();

function getGridSizes() {
  return [0, smallGridSize, GRID_MEDIUM_SIZE];
}

// Changing the small grid size while that state is the one currently
// showing updates the live grid immediately (rather than requiring an
// extra click of the # button to "pick up" the new number).
function updateSmallGridSize(rawValue) {
  const wasActive = gridSize === smallGridSize;
  smallGridSize = snapToValidSmallGridSize(Math.round(parseFloat(rawValue)));
  try { localStorage.setItem(SMALL_GRID_SIZE_STORAGE_KEY, String(smallGridSize)); } catch (e) {}
  if (wasActive) {
    gridSize = smallGridSize;
    try { localStorage.setItem('bpmnEditor.gridSize', String(gridSize)); } catch (e) {}
  }
  updateGridButton();
  renderGridBackground();
  refreshSettingsDialogList();
}

function resetSmallGridSize() {
  updateSmallGridSize(DEFAULT_SMALL_GRID_SIZE);
}

// Canvas background + grid line colors — a per-computer editor preference
// (Settings → General settings), not part of a diagram's own data, so this
// is stored separately from `dictionaries` (which travels WITH a .bpmn file
// via flushDictionariesToModel()) and never embedded into the XML.
const DEFAULT_APP_COLORS = { canvasBg: '#ffffff', gridMajor: '#c9c9c3', gridMinor: '#e3e3df' };
const APP_COLORS_STORAGE_KEY = 'bpmnEditor.appColors';

function loadAppColors() {
  try {
    const raw = localStorage.getItem(APP_COLORS_STORAGE_KEY);
    if (raw) return Object.assign({}, DEFAULT_APP_COLORS, JSON.parse(raw));
  } catch (e) {}
  return Object.assign({}, DEFAULT_APP_COLORS);
}
function saveAppColors() {
  try { localStorage.setItem(APP_COLORS_STORAGE_KEY, JSON.stringify(appColors)); } catch (e) {}
}
let appColors = loadAppColors();

function updateAppColor(key, value) {
  if (!(key in DEFAULT_APP_COLORS)) return;
  appColors[key] = value;
  saveAppColors();
  renderGridBackground();
  refreshSettingsDialogList();
}

function resetAppColor(key) {
  if (!(key in DEFAULT_APP_COLORS)) return;
  appColors[key] = DEFAULT_APP_COLORS[key];
  saveAppColors();
  renderGridBackground();
  refreshSettingsDialogList();
}

let gridSize = 0;
try {
  const stored = parseInt(localStorage.getItem('bpmnEditor.gridSize'), 10);
  if (getGridSizes().includes(stored)) gridSize = stored;
} catch (e) {}

function toggleGrid() {
  const sizes = getGridSizes();
  const idx = sizes.indexOf(gridSize);
  gridSize = sizes[(idx + 1) % sizes.length];
  try { localStorage.setItem('bpmnEditor.gridSize', String(gridSize)); } catch (e) {}
  updateGridButton();
  renderGridBackground();
}

function updateGridButton() {
  const btn = document.getElementById('grid-toggle');
  if (!btn) return;
  btn.classList.remove('grid-off', 'grid-10', 'primary');
  if (gridSize === 0) {
    btn.classList.add('grid-off');
    btn.title = 'Grid: off';
  } else if (gridSize === smallGridSize) {
    btn.classList.add('grid-10');
    btn.title = `Grid: ${smallGridSize}px`;
  } else {
    btn.classList.add('primary');
    btn.title = `Grid: ${GRID_MEDIUM_SIZE}px`;
  }
}

// Major grid (the fixed "every 100px" reference lines) — one dashed line
// per tile edge, tile size = spacing, so it repeats cleanly on its own.
function makeMajorGridPattern(id, spacing, color) {
  const pattern = document.createElementNS(SVG_NS, 'pattern');
  pattern.setAttribute('id', id);
  pattern.setAttribute('patternUnits', 'userSpaceOnUse');
  pattern.setAttribute('width', spacing);
  pattern.setAttribute('height', spacing);

  const lineH = document.createElementNS(SVG_NS, 'line');
  lineH.setAttribute('x1', 0); lineH.setAttribute('y1', 0);
  lineH.setAttribute('x2', spacing); lineH.setAttribute('y2', 0);
  lineH.setAttribute('stroke', color);
  lineH.setAttribute('stroke-width', 1);
  lineH.setAttribute('vector-effect', 'non-scaling-stroke');
  lineH.setAttribute('stroke-dasharray', '2,2');

  const lineV = document.createElementNS(SVG_NS, 'line');
  lineV.setAttribute('x1', 0); lineV.setAttribute('y1', 0);
  lineV.setAttribute('x2', 0); lineV.setAttribute('y2', spacing);
  lineV.setAttribute('stroke', color);
  lineV.setAttribute('stroke-width', 1);
  lineV.setAttribute('vector-effect', 'non-scaling-stroke');
  lineV.setAttribute('stroke-dasharray', '2,2');

  pattern.appendChild(lineH);
  pattern.appendChild(lineV);
  return pattern;
}

// Minor grid (10px or 50px, whichever is active). Previously this used the
// same one-line-per-tile approach as the major pattern, at tile size =
// spacing — which meant that at every position that's ALSO a multiple of
// the major spacing (every 10th minor line at 10px, every 2nd at 50px),
// two separate lines from two independently-tiled patterns landed on the
// exact same coordinate. Both patterns tile from the same origin so they're
// logically aligned, but as two unrelated SVG layers the renderer was free
// to snap each to a device pixel independently — on a HiDPI screen that
// occasionally rounded them a device-pixel apart, reading as a blurry
// "double line" right where the grids should have coincided cleanly.
//
// Fixed by building ONE tile sized to the MAJOR spacing that explicitly
// omits the position(s) coinciding with a major line (0 and, by extension,
// every multiple of `spacing` up to but excluding `majorSpacing`) — so
// there is only ever one line drawn per coordinate, period, and the major
// pattern (drawn on top, see renderGridBackground()) owns those positions
// outright. (A dotted variant of this line was tried and reverted — dashed
// reads better here.)
//
// Both this and the major pattern's lines carry vector-effect:
// non-scaling-stroke, so a "1" stroke-width always renders as exactly one
// physical pixel regardless of canvas zoom — without it, zooming in made
// the (much more frequent) minor lines visually balloon in thickness right
// along with everything else on the canvas, reading as "bolder" than the
// major grid even though both share the same numeric stroke-width. Only
// the dash LENGTH still scales with zoom (that's not "thickness" — it's
// expected for a diagram-space ruler); the line's own weight now stays
// fixed, so the two grids only ever differ by color, as intended.
function makeMinorGridPattern(id, spacing, majorSpacing, color) {
  const pattern = document.createElementNS(SVG_NS, 'pattern');
  pattern.setAttribute('id', id);
  pattern.setAttribute('patternUnits', 'userSpaceOnUse');
  pattern.setAttribute('width', majorSpacing);
  pattern.setAttribute('height', majorSpacing);

  for (let pos = spacing; pos < majorSpacing; pos += spacing) {
    const lineV = document.createElementNS(SVG_NS, 'line');
    lineV.setAttribute('x1', pos); lineV.setAttribute('y1', 0);
    lineV.setAttribute('x2', pos); lineV.setAttribute('y2', majorSpacing);
    lineV.setAttribute('stroke', color);
    lineV.setAttribute('stroke-width', 1);
    lineV.setAttribute('vector-effect', 'non-scaling-stroke');
    lineV.setAttribute('stroke-dasharray', '2,2');
    pattern.appendChild(lineV);

    const lineH = document.createElementNS(SVG_NS, 'line');
    lineH.setAttribute('x1', 0); lineH.setAttribute('y1', pos);
    lineH.setAttribute('x2', majorSpacing); lineH.setAttribute('y2', pos);
    lineH.setAttribute('stroke', color);
    lineH.setAttribute('stroke-width', 1);
    lineH.setAttribute('vector-effect', 'non-scaling-stroke');
    lineH.setAttribute('stroke-dasharray', '2,2');
    pattern.appendChild(lineH);
  }
  return pattern;
}

// Same rounding diagram-js's own (minified, hardcoded-to-10) GridSnapping
// service uses internally — reimplemented here since that helper isn't
// exposed outside the bundle's own closure.
function quantizeToGrid(value, spacing, roundFn) {
  const fn = roundFn || 'round';
  return Math[fn](value / spacing) * spacing;
}

// Monkey-patches bpmn-js's built-in GridSnapping service so that every
// move/resize/connect snap follows `smallGridSize` (the Settings "Small
// grid size" value) instead of the library's hardcoded 10px. Only patches
// once per modeler instance (_mpPatched guard) — safe to call again on
// every initModeler() without double-wrapping.
function patchGridSnappingSpacing() {
  if (!modeler) return;
  let gridSnapping;
  try { gridSnapping = modeler.get('gridSnapping'); } catch (e) { return; }
  if (!gridSnapping || gridSnapping._mpPatched) return;
  gridSnapping._mpPatched = true;

  gridSnapping.getGridSpacing = function() { return smallGridSize; };

  // Mirrors the original snapValue()'s own logic (including its quirk of
  // treating an explicit 0 for min/max as "not set", via a truthy check
  // rather than a null check) — only the hardcoded "10" becomes dynamic.
  gridSnapping.snapValue = function(value, opts) {
    let offset = 0;
    if (opts && opts.offset) offset = opts.offset;
    const spacing = smallGridSize;
    let result = quantizeToGrid(value + offset, spacing);
    if (opts && opts.min) {
      const min = quantizeToGrid(opts.min + offset, spacing, 'ceil');
      result = Math.max(result, min);
    }
    if (opts && opts.max) {
      const max = quantizeToGrid(opts.max + offset, spacing, 'floor');
      result = Math.min(result, max);
    }
    return result - offset;
  };
}

// Rebuilds the grid layer from scratch — cheap enough (a handful of DOM
// nodes) to just redo on every toggle/import rather than diff it.
function renderGridBackground() {
  if (!modeler) return;
  let svg;
  try { svg = modeler.get('canvas')._svg; } catch (e) { return; }
  if (!svg) return;

  // Canvas background is a plain element style, not an SVG layer — applied
  // here too since this function already runs at every point the canvas
  // exists or might need refreshing (init, new diagram, import, plane
  // change, and now also a Settings color change).
  const canvasEl = document.getElementById('canvas');
  if (canvasEl) canvasEl.style.background = appColors.canvasBg;

  const oldLayer = svg.querySelector('#app-grid-layer');
  if (oldLayer) oldLayer.remove();
  const oldDefs = svg.querySelector('#app-grid-defs');
  if (oldDefs) oldDefs.remove();

  if (!gridSize) return;

  const viewport = svg.querySelector('.viewport');
  if (!viewport) return;

  const defs = document.createElementNS(SVG_NS, 'defs');
  defs.setAttribute('id', 'app-grid-defs');
  defs.appendChild(makeMinorGridPattern('app-grid-minor', gridSize, GRID_MAJOR_SPACING, appColors.gridMinor));
  defs.appendChild(makeMajorGridPattern('app-grid-major', GRID_MAJOR_SPACING, appColors.gridMajor));
  svg.insertBefore(defs, svg.firstChild);

  const layer = document.createElementNS(SVG_NS, 'g');
  layer.setAttribute('id', 'app-grid-layer');

  [['app-grid-minor'], ['app-grid-major']].forEach(([patternId]) => {
    const rect = document.createElementNS(SVG_NS, 'rect');
    rect.setAttribute('x', -GRID_HALF_EXTENT);
    rect.setAttribute('y', -GRID_HALF_EXTENT);
    rect.setAttribute('width', GRID_HALF_EXTENT * 2);
    rect.setAttribute('height', GRID_HALF_EXTENT * 2);
    rect.setAttribute('fill', `url(#${patternId})`);
    rect.setAttribute('pointer-events', 'none');
    layer.appendChild(rect);
  });

  // First child of .viewport → painted behind every real diagram layer.
  viewport.insertBefore(layer, viewport.firstChild);
}

/* ─── SETTINGS / DICTIONARIES (⚙) ───
   One shared config (currently just "Systems": name + color), stored in
   localStorage so it's independent of any single diagram. Element details
   pick a system from a dropdown instead of typing it by hand — see the
   "System" field in updatePropsPanel(). */
const DICTIONARIES_STORAGE_KEY = 'bpmnEditor.dictionaries';
// bpmn-js's own built-in default size for a freshly created task — used as
// the fallback/placeholder when no custom default has been configured.
const BPMN_DEFAULT_TASK_SIZE = { width: 100, height: 80 };

// The 5 places a dictionary's badges can appear (or nowhere at all).
const DICT_POSITIONS = ['hide', 'left-top', 'right-top', 'left-bottom', 'right-bottom'];
const DICT_POSITION_LABELS = { hide: 'Hide', 'left-top': 'Left Top', 'right-top': 'Right Top', 'left-bottom': 'Left Bottom', 'right-bottom': 'Right Bottom' };

// A brand-new install (nothing in localStorage yet, ever) starts with the 3
// built-in dictionaries present but empty and hidden — nothing to show
// until the user actually sets them up, rather than surprising a first-time
// user with badges/positions they never configured.
function defaultDictionaries() {
  return {
    list: [
      { id: 'system', name: 'Systems', builtIn: true, metaKey: 'system', position: 'hide', sort: 1, items: [] },
      { id: 'location', name: 'Locations', builtIn: true, metaKey: 'location', position: 'hide', sort: 1, items: [] },
      { id: 'device', name: 'Device', builtIn: true, metaKey: 'device', position: 'hide', sort: 1, items: [] }
    ],
    taskDefaultSize: null
  };
}

// Upgrades the old fixed { systems, locations, devices } shape (from before
// per-dictionary position/sort and custom dictionaries existed) into the
// current { list: [...] } shape. Positions are set to whatever the old,
// non-configurable hardcoded layout actually was (System below-left,
// Location above-left, Device below-right) so an existing user's diagram
// looks visually IDENTICAL right after this upgrade — nothing should
// appear to move or disappear just because the storage format changed.
function migrateLegacyDictionaries(old) {
  return {
    list: [
      { id: 'system', name: 'Systems', builtIn: true, metaKey: 'system', position: 'left-bottom', sort: 1, items: old.systems || [] },
      { id: 'location', name: 'Locations', builtIn: true, metaKey: 'location', position: 'left-top', sort: 1, items: old.locations || [] },
      { id: 'device', name: 'Device', builtIn: true, metaKey: 'device', position: 'right-bottom', sort: 1, items: old.devices || [] }
    ],
    taskDefaultSize: old.taskDefaultSize || null
  };
}

// Defensive normalization for the current shape — fills in anything
// missing/malformed (e.g. hand-edited localStorage, or a future field this
// version doesn't know about yet) rather than letting a bad entry crash
// rendering.
function normalizeDictionaries(parsed) {
  const list = (Array.isArray(parsed.list) ? parsed.list : []).map(d => ({
    id: d && d.id || ('dict_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)),
    name: (d && d.name) || '',
    builtIn: !!(d && d.builtIn),
    metaKey: (d && d.metaKey) || (d && d.id) || '',
    position: (d && DICT_POSITIONS.includes(d.position)) ? d.position : 'hide',
    sort: (d && typeof d.sort === 'number' && isFinite(d.sort)) ? d.sort : 1,
    items: Array.isArray(d && d.items) ? d.items : []
  }));
  return { list, taskDefaultSize: (parsed && parsed.taskDefaultSize) || null };
}

function loadDictionaries() {
  try {
    const raw = localStorage.getItem(DICTIONARIES_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed.list)) return normalizeDictionaries(parsed);
      return migrateLegacyDictionaries(parsed);
    }
  } catch (e) {}
  return defaultDictionaries();
}

function saveDictionaries() {
  try { localStorage.setItem(DICTIONARIES_STORAGE_KEY, JSON.stringify(dictionaries)); } catch (e) {}
}

let dictionaries = loadDictionaries();

function findDictionary(dictId) {
  return (dictionaries.list || []).find(d => d.id === dictId) || null;
}

function getDictItemById(dictId, itemId) {
  const dict = findDictionary(dictId);
  if (!dict || !itemId) return null;
  return (dict.items || []).find(it => it.id === itemId) || null;
}

// Called after any add/edit/remove — persists to localStorage (per-computer
// default), embeds the current dictionaries into the open diagram's XML
// (so the file is portable — see flushDictionariesToModel()), refreshes
// badges on canvas, and refreshes the dropdowns if the properties panel is open.
async function onDictionariesChanged() {
  saveDictionaries();
  flushDictionariesToModel();
  // flushDictionariesToModel() mutates the moddle tree directly (not through
  // the modeling service), so it never fires 'commandStack.changed' — the
  // only place that normally marks the document dirty and schedules
  // auto-save. Without this, editing a dictionary entry (rename/recolor)
  // wasn't picked up by auto-save or the unsaved-changes refresh guard, so
  // the change could silently vanish on the next reload. Mirror what the
  // commandStack.changed handler does for ordinary edits.
  hasUnsavedChanges = true;
  setStatus('Unsaved changes', '');
  if (xmlPanelVisible) await refreshXmlPanel();
  scheduleAutosave();
  refreshDetailOverlays();
  if (modeler) updatePropsPanel(modeler.get('selection').get());
}

/* Dictionaries are also embedded into the .bpmn file itself (as a JSON blob
   inside a bpmn:documentation element on the root process — same trick used
   for per-element meta), so that opening the file on another computer shows
   the correct system/location names and colors even before you've set up
   those dictionaries there. On import, embedded entries are merged into
   whatever's already in localStorage (file wins on matching id; anything
   local-only that isn't in the file is kept, not deleted). */

function flushDictionariesToModel() {
  if (!modeler) return;
  try {
    const definitions = modeler.getDefinitions();
    const processBo = definitions && (definitions.rootElements || []).find(r => r.$type === 'bpmn:Process');
    if (!processBo) return;
    const bpmnFactory = modeler.get('bpmnFactory');
    const dictStr = JSON.stringify(dictionaries);
    let docs = processBo.documentation || [];
    const dictDoc = docs.find(d => d.textFormat === 'application/json+bpmn-dictionaries');
    if (dictDoc) {
      dictDoc.text = dictStr;
    } else {
      const newDoc = bpmnFactory.create('bpmn:Documentation', {
        textFormat: 'application/json+bpmn-dictionaries',
        text: dictStr
      });
      newDoc.$parent = processBo;
      processBo.documentation = [...docs, newDoc];
    }
  } catch (e) {}
}

function loadDictionariesFromModel() {
  if (!modeler) return null;
  try {
    const definitions = modeler.getDefinitions();
    const processBo = definitions && (definitions.rootElements || []).find(r => r.$type === 'bpmn:Process');
    if (!processBo) return null;
    const docs = processBo.documentation || [];
    const dictDoc = docs.find(d => d.textFormat === 'application/json+bpmn-dictionaries');
    if (dictDoc && dictDoc.text) {
      return JSON.parse(dictDoc.text);
    }
  } catch (e) {}
  return null;
}

// File wins for ITEMS that exist in both a local and an incoming dictionary
// (matched by item id); local-only items (not yet saved into any file) are
// kept rather than dropped. A dictionary present in the file but not
// locally (e.g. a custom one someone else added) is adopted wholesale —
// name, position, sort and all. A dictionary that already exists locally
// keeps this computer's own name/position/sort (those are presentation
// choices for this machine, same spirit as dictionaries always having been
// a per-computer default) — only its items get merged in from the file.
function mergeDictionaries(local, incoming) {
  if (!incoming || !Array.isArray(incoming.list)) return local;
  const mergedList = (local.list || []).map(d => ({ ...d, items: [...(d.items || [])] }));
  incoming.list.forEach(incomingDict => {
    if (!incomingDict || !incomingDict.id) return;
    const localDict = mergedList.find(d => d.id === incomingDict.id);
    if (!localDict) {
      mergedList.push({ ...incomingDict, items: [...(incomingDict.items || [])] });
      return;
    }
    (incomingDict.items || []).forEach(item => {
      const idx = localDict.items.findIndex(x => x.id === item.id);
      if (idx >= 0) localDict.items[idx] = item;
      else localDict.items.push(item);
    });
  });
  return {
    list: mergedList,
    taskDefaultSize: incoming.taskDefaultSize || local.taskDefaultSize || null
  };
}

function openSettingsDictionary() {
  const old = document.getElementById('settings-dialog');
  if (old) old.remove();

  const dialog = document.createElement('div');
  dialog.id = 'settings-dialog';
  dialog.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.4);z-index:1000;display:flex;align-items:center;justify-content:center;';
  dialog.innerHTML = renderSettingsDialogHtml();
  document.body.appendChild(dialog);
  dialog.addEventListener('click', e => { if (e.target === dialog) dialog.remove(); });
}

function renderDictRows(dictId, items) {
  return items.map((s, i) => `
    <div style="display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid #f0f0ec;">
      <input type="color" value="${s.color}" onchange="updateDictItemField('${dictId}', ${i}, 'color', this.value)"
        style="width:32px;height:28px;border:1px solid #d0d0cc;border-radius:5px;padding:1px;cursor:pointer;">
      <input type="text" value="${escHtml(s.name)}" placeholder="Name" onchange="updateDictItemField('${dictId}', ${i}, 'name', this.value)"
        style="flex:1;font-size:13px;padding:5px 8px;border:1px solid #d0d0cc;border-radius:5px;">
      <button title="Remove" onclick="removeDictItem('${dictId}', ${i})"
        style="font-size:12px;padding:4px 8px;border-color:#c0392b;color:#c0392b;">✕</button>
    </div>`
  ).join('');
}

// One row for an app-preference color (canvas background, grid lines) —
// same swatch-on-the-left look as renderDictRows(), but there's no name to
// edit and no entry to remove, just a fixed label and a "Reset" that only
// appears once the value actually differs from the built-in default.
function renderAppColorRow(label, key) {
  const value = appColors[key] || DEFAULT_APP_COLORS[key];
  const isCustom = value.toLowerCase() !== DEFAULT_APP_COLORS[key].toLowerCase();
  return `
    <div style="display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid #f0f0ec;">
      <input type="color" value="${value}" onchange="updateAppColor('${key}', this.value)"
        style="width:32px;height:28px;border:1px solid #d0d0cc;border-radius:5px;padding:1px;cursor:pointer;">
      <div style="flex:1;font-size:13px;">${escHtml(label)}</div>
      ${isCustom ? `<button title="Reset to default" onclick="resetAppColor('${key}')" style="font-size:11px;padding:4px 8px;">Reset</button>` : ''}
    </div>`;
}

function renderSettingsDialogHtml() {
  // Each dictionary renders as its own block: an editable name (point 6),
  // its item rows, then one row holding "+ Add item", the position select
  // (point 4 — 5 options), a Sort number input, and the delete button — all
  // at the same height, per the user's explicit placement instruction.
  const dictBlocksHtml = (dictionaries.list || []).map(dict => {
    const rows = renderDictRows(dict.id, dict.items || [])
      || '<div style="padding:8px 0;font-size:12px;color:#aaa;">No items yet — add one below.</div>';
    const positionOptions = DICT_POSITIONS.map(p =>
      `<option value="${p}" ${dict.position === p ? 'selected' : ''}>${DICT_POSITION_LABELS[p]}</option>`
    ).join('');
    return `
      <div style="margin-bottom:18px;padding-bottom:14px;border-bottom:1px solid #eee;">
        <input type="text" value="${escHtml(dict.name)}" placeholder="Dictionary name"
          onchange="renameDictionary('${dict.id}', this.value)"
          style="width:100%;box-sizing:border-box;font-size:14px;font-weight:500;padding:5px 8px;border:1px solid #d0d0cc;border-radius:5px;margin-bottom:6px;">
        <div>${rows}</div>
        <div style="display:flex;align-items:center;gap:6px;margin-top:8px;flex-wrap:wrap;">
          <button onclick="addDictItem('${dict.id}')" style="font-size:12px;padding:5px 10px;">+ Add item</button>
          <select onchange="updateDictPosition('${dict.id}', this.value)" style="font-size:12px;padding:5px 6px;border:1px solid #d0d0cc;border-radius:5px;">
            ${positionOptions}
          </select>
          <span style="font-size:11px;color:#888;">Sort</span>
          <input type="number" value="${dict.sort}" step="1" onchange="updateDictSort('${dict.id}', this.value)"
            style="width:48px;font-size:12px;padding:5px 6px;border:1px solid #d0d0cc;border-radius:5px;">
          <button title="Delete dictionary" onclick="removeDictionary('${dict.id}')"
            style="font-size:12px;padding:4px 8px;border-color:#c0392b;color:#c0392b;margin-left:auto;">✕</button>
        </div>
      </div>`;
  }).join('');

  // Default task size — one shared width/height applied to newly created
  // tasks regardless of subtype (User Task, Service Task, ...). Falls back
  // to bpmn-js's own built-in default (100×80) when unset.
  const taskDefaultSize = dictionaries.taskDefaultSize || BPMN_DEFAULT_TASK_SIZE;
  const isCustomTaskSize = !!dictionaries.taskDefaultSize;

  const sectionLabel = 'font-size:11px;color:#888;text-transform:uppercase;letter-spacing:0.05em;margin:14px 0 6px;';

  // The dialog sizes to its content but is capped at 80% of the viewport
  // height (not a fixed size) — display:flex + max-height lets the box
  // shrink-to-fit when there's little content, while still clamping (and
  // handing scrolling to the columns below) once it doesn't fit.
  return `<div style="background:#fff;border-radius:10px;padding:20px;min-width:700px;max-width:860px;max-height:80vh;box-shadow:0 8px 32px rgba(0,0,0,0.18);display:flex;flex-direction:column;">
    <div style="display:flex;gap:32px;flex:1;min-height:0;">

      <div style="flex:1;min-width:0;display:flex;flex-direction:column;min-height:0;">
        <div style="font-size:14px;font-weight:500;margin-bottom:10px;flex-shrink:0;">Dictionaries</div>
        <div id="dict-scroll-container" style="flex:1;min-height:0;overflow-y:auto;padding-right:10px;">
          ${dictBlocksHtml || '<div style="padding:12px 0;font-size:12px;color:#aaa;">No dictionaries yet — add one below.</div>'}
          <button onclick="addDictionary()" style="font-size:12px;padding:6px 14px;">+ Add dictionary</button>
        </div>
      </div>

      <div style="flex:1;min-width:0;border-left:1px solid #eee;padding-left:32px;overflow-y:auto;">
        <div style="font-size:14px;font-weight:500;margin-bottom:2px;">General settings</div>

        <div style="${sectionLabel}">Default task size</div>
        <div style="font-size:11px;color:#aaa;margin-bottom:8px;">Applies to newly created tasks, regardless of type (User Task, Service Task, ...).</div>
        <div style="display:flex;align-items:center;gap:6px;">
          <input type="number" id="dict-task-default-width" min="${MIN_SHAPE_SIZE}" step="1" value="${taskDefaultSize.width}"
            onchange="updateTaskDefaultSize()"
            style="width:64px;font-size:13px;padding:5px 8px;border:1px solid #d0d0cc;border-radius:5px;">
          <span style="color:#999;">×</span>
          <input type="number" id="dict-task-default-height" min="${MIN_SHAPE_SIZE}" step="1" value="${taskDefaultSize.height}"
            onchange="updateTaskDefaultSize()"
            style="width:64px;font-size:13px;padding:5px 8px;border:1px solid #d0d0cc;border-radius:5px;">
          <span style="color:#999;font-size:11px;">px</span>
          ${isCustomTaskSize ? `<button onclick="resetTaskDefaultSize()" style="font-size:11px;padding:4px 8px;margin-left:auto;">Reset to ${BPMN_DEFAULT_TASK_SIZE.width}×${BPMN_DEFAULT_TASK_SIZE.height}</button>` : ''}
        </div>

        <div style="${sectionLabel}">Canvas &amp; grid</div>
        <div style="display:flex;align-items:center;gap:6px;padding:6px 0;border-bottom:1px solid #f0f0ec;">
          <div style="flex:1;font-size:13px;">Small grid size</div>
          <input type="number" id="small-grid-size-input" min="1" max="${GRID_MAJOR_SPACING - 1}" step="1" value="${smallGridSize}"
            onchange="updateSmallGridSize(this.value)"
            style="width:64px;font-size:13px;padding:5px 8px;border:1px solid #d0d0cc;border-radius:5px;">
          <span style="color:#999;font-size:11px;">px</span>
          ${smallGridSize !== DEFAULT_SMALL_GRID_SIZE ? `<button title="Reset to default" onclick="resetSmallGridSize()" style="font-size:11px;padding:4px 8px;">Reset</button>` : ''}
        </div>
        <div style="font-size:11px;color:#aaa;margin:4px 0 8px;">Must divide evenly into 100 (the fixed reference grid) — an invalid number snaps to the nearest one that does.</div>
        <div id="app-colors-list">
          ${renderAppColorRow('Canvas background', 'canvasBg')}
          ${renderAppColorRow('Grid lines — every 100px', 'gridMajor')}
          ${renderAppColorRow(`Grid lines — every ${smallGridSize}px`, 'gridMinor')}
        </div>

        <div style="${sectionLabel}">Time analysis</div>
        <div style="font-size:11px;color:#aaa;margin-bottom:8px;">Adds a "Time" field (seconds) to tasks/sub-processes/Call Activities, and a % split for each XOR gateway's outgoing paths — shown on canvas as small labels next to each. Fields only for now, no calculation yet.</div>
        <label style="display:flex;align-items:center;gap:8px;font-size:13px;cursor:pointer;">
          <input type="checkbox" id="time-analysis-toggle" ${timeAnalysisEnabled ? 'checked' : ''} onchange="toggleTimeAnalysis()">
          Enable time analysis fields
        </label>
      </div>

    </div>

    <div style="display:flex;justify-content:flex-end;margin-top:16px;flex-shrink:0;">
      <button onclick="document.getElementById('settings-dialog').remove()"
        style="font-size:13px;padding:5px 14px;background:#1a6bb5;color:#fff;border-color:#1558a0;">Close</button>
    </div>
  </div>`;
}

function refreshSettingsDialogList() {
  const dialog = document.getElementById('settings-dialog');
  if (!dialog) return;
  // Rebuilding the dialog's whole innerHTML also throws away the scroll
  // position of the dictionaries list — without restoring it, adding a
  // dictionary/item while scrolled down snaps the view back to the top,
  // forcing a re-scroll after every single edit. Capture it beforehand and
  // reapply it to the freshly-rendered container.
  const scrollEl = document.getElementById('dict-scroll-container');
  const savedScrollTop = scrollEl ? scrollEl.scrollTop : 0;
  // Deferred to the next tick: this is almost always called from an
  // onchange/onclick handler on an element that LIVES INSIDE the dialog
  // we're about to blow away (e.g. the input the user just typed into).
  // Replacing dialog.innerHTML synchronously, while the browser is still
  // in the middle of dispatching that very element's own event, made it
  // throw "NotFoundError: the node to be removed is no longer a child of
  // this node" once the event finished bubbling. Pushing the re-render to
  // a fresh task lets the triggering event fully finish first.
  setTimeout(() => {
    const dialog2 = document.getElementById('settings-dialog');
    if (!dialog2) return;
    dialog2.innerHTML = renderSettingsDialogHtml();
    const scrollEl2 = document.getElementById('dict-scroll-container');
    if (scrollEl2) scrollEl2.scrollTop = savedScrollTop;
  }, 0);
}

function addDictionary() {
  openPromptModal('New dictionary', 'Dictionary name', '', function(name) {
    name = (name || '').trim();
    if (!name) return;
    if (!dictionaries.list) dictionaries.list = [];
    const id = 'dict_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    dictionaries.list.push({ id, name, builtIn: false, metaKey: id, position: 'hide', sort: 1, items: [] });
    onDictionariesChanged();
    refreshSettingsDialogList();
  });
}

function removeDictionary(dictId) {
  const dict = findDictionary(dictId);
  if (!dict) return;
  openConfirmModal('Delete dictionary', `Delete "${dict.name || dict.id}" and all its items? This cannot be undone.`, function() {
    dictionaries.list = (dictionaries.list || []).filter(d => d.id !== dictId);
    onDictionariesChanged();
    refreshSettingsDialogList();
  });
}

function renameDictionary(dictId, newName) {
  const dict = findDictionary(dictId);
  if (!dict) return;
  dict.name = newName;
  onDictionariesChanged();
}

function updateDictPosition(dictId, position) {
  const dict = findDictionary(dictId);
  if (!dict || !DICT_POSITIONS.includes(position)) return;
  dict.position = position;
  onDictionariesChanged();
}

function updateDictSort(dictId, sortValue) {
  const dict = findDictionary(dictId);
  if (!dict) return;
  let sort = parseInt(sortValue, 10);
  if (!isFinite(sort)) sort = 1;
  dict.sort = sort;
  onDictionariesChanged();
}

function addDictItem(dictId) {
  const dict = findDictionary(dictId);
  if (!dict) return;
  if (!dict.items) dict.items = [];
  dict.items.push({
    id: 'item_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    name: '',
    color: '#cce5ff'
  });
  onDictionariesChanged();
  refreshSettingsDialogList();
}

function updateDictItemField(dictId, idx, field, value) {
  const dict = findDictionary(dictId);
  if (!dict || !dict.items || !dict.items[idx]) return;
  dict.items[idx][field] = value;
  onDictionariesChanged();
}

function removeDictItem(dictId, idx) {
  const dict = findDictionary(dictId);
  if (!dict || !dict.items) return;
  dict.items.splice(idx, 1);
  onDictionariesChanged();
  refreshSettingsDialogList();
}

function updateTaskDefaultSize() {
  const wInput = document.getElementById('dict-task-default-width');
  const hInput = document.getElementById('dict-task-default-height');
  if (!wInput || !hInput) return;

  let w = Math.round(parseFloat(wInput.value));
  let h = Math.round(parseFloat(hInput.value));
  if (!isFinite(w) || w < MIN_SHAPE_SIZE) w = MIN_SHAPE_SIZE;
  if (!isFinite(h) || h < MIN_SHAPE_SIZE) h = MIN_SHAPE_SIZE;
  wInput.value = w;
  hInput.value = h;

  dictionaries.taskDefaultSize = { width: w, height: h };
  onDictionariesChanged();
  refreshSettingsDialogList();
}

function resetTaskDefaultSize() {
  dictionaries.taskDefaultSize = null;
  onDictionariesChanged();
  refreshSettingsDialogList();
}

// Auto-save fields when the user leaves the element
let _autoSavePending = null;
function autoSaveFields(elementId) {
  const desc = document.getElementById('prop-description-' + elementId);
  const details = document.getElementById('prop-details-' + elementId);
  if (!desc && !details) return;

  const er = modeler.get('elementRegistry');
  const el = er.get(elementId);
  if (!el) return;
  const bo = el.businessObject;

  if (desc) setElementMeta(bo, 'description', desc.value);
  if (details) {
    setElementMeta(bo, 'details', details.value);
    const linkEl = document.getElementById('prop-details-link-' + elementId);
    if (linkEl) {
      const url = details.value.trim();
      linkEl.href = url;
      linkEl.textContent = url;
      linkEl.style.display = url ? 'block' : 'none';
    }
  }
  flushMetaToModel();
  refreshDetailOverlays();
}

function applyElementSize(elementId) {
  const wInput = document.getElementById('prop-width-' + elementId);
  const hInput = document.getElementById('prop-height-' + elementId);
  if (!wInput || !hInput) return;

  const er = modeler.get('elementRegistry');
  const el = er.get(elementId);
  if (!el) return;

  let newWidth = Math.round(parseFloat(wInput.value));
  let newHeight = Math.round(parseFloat(hInput.value));
  // Empty/garbage input reverts to the current size; a valid-but-too-small
  // number gets clamped up to the floor instead.
  if (!isFinite(newWidth)) newWidth = Math.round(el.width);
  else if (newWidth < MIN_SHAPE_SIZE) newWidth = MIN_SHAPE_SIZE;
  if (!isFinite(newHeight)) newHeight = Math.round(el.height);
  else if (newHeight < MIN_SHAPE_SIZE) newHeight = MIN_SHAPE_SIZE;

  // Reflect any clamping back into the fields even if nothing else changes.
  wInput.value = newWidth;
  hInput.value = newHeight;

  if (newWidth === el.width && newHeight === el.height) return;

  const allowed = modeler.get('rules').allowed('shape.resize', { shape: el });
  if (!allowed) {
    setStatus('This element type cannot be resized', 'err');
    wInput.value = Math.round(el.width);
    hInput.value = Math.round(el.height);
    return;
  }

  modeler.get('modeling').resizeShape(el, {
    x: el.x,
    y: el.y,
    width: newWidth,
    height: newHeight
  });
  refreshDetailOverlays();
}

// Manual duration field (Time analysis, v1 — storage + overlay only, no
// calculation). Stored via the generic meta system, same as Description/
// Details, so it round-trips through bpmn:Documentation for free.
function applyElementTime(elementId) {
  const er = modeler.get('elementRegistry');
  const el = er.get(elementId);
  if (!el) return;
  const input = document.getElementById('prop-time-' + elementId);
  if (!input) return;

  const val = input.value.trim();
  if (val === '') {
    setElementMeta(el.businessObject, 'time', '');
  } else {
    let num = parseInt(val, 10);
    if (isNaN(num) || num < 0) num = 0;
    setElementMeta(el.businessObject, 'time', String(num));
    input.value = num;
  }
  flushMetaToModel();
  refreshDetailOverlays();
}

// % share of an Exclusive gateway's outgoing flow, stored on the flow's own
// businessObject (getElementMeta/setElementMeta work identically for
// connections and shapes since both just key off businessObject.id).
function applyFlowProbability(flowId) {
  const er = modeler.get('elementRegistry');
  const flowEl = er.get(flowId);
  if (!flowEl || !flowEl.businessObject) return;
  const input = document.getElementById('prop-flowpct-' + flowId);
  if (!input) return;

  const val = input.value.trim();
  if (val === '') {
    setElementMeta(flowEl.businessObject, 'probability', '');
  } else {
    let num = parseInt(val, 10);
    if (isNaN(num)) num = 0;
    num = Math.max(0, Math.min(100, num));
    setElementMeta(flowEl.businessObject, 'probability', String(num));
    input.value = num;
  }
  flushMetaToModel();
  refreshDetailOverlays();
  // Re-render the panel so the running "Suma: X%" indicator updates live.
  updatePropsPanel(modeler.get('selection').get());
}

function setElementDictValue(elementId, dictId, valueId) {
  const dict = findDictionary(dictId);
  if (!dict) return;
  const er = modeler.get('elementRegistry');
  const el = er.get(elementId);
  if (!el) return;
  setElementMeta(el.businessObject, dict.metaKey, valueId);
  flushMetaToModel();
  refreshDetailOverlays();
}

const COLOR_PALETTE = [
  // Pastel — happy path and markers
  { hex: '#d4edda', label: 'Pastel green' },
  { hex: '#cce5ff', label: 'Pastel blue' },
  { hex: '#fff3cd', label: 'Pastel yellow' },
  { hex: '#f8d7da', label: 'Pastel red' },
  { hex: '#e2d9f3', label: 'Pastel purple' },
  { hex: '#fde2c8', label: 'Pastel orange' },
  { hex: '#d1ecf1', label: 'Pastel turquoise' },
  { hex: '#f5c6cb', label: 'Pastel pink' },
  // Stronger
  { hex: '#28a745', label: 'Green' },
  { hex: '#007bff', label: 'Blue' },
  { hex: '#ffc107', label: 'Yellow' },
  { hex: '#dc3545', label: 'Red' },
  { hex: '#6f42c1', label: 'Purple' },
  { hex: '#fd7e14', label: 'Orange' },
  { hex: '#17a2b8', label: 'Turquoise' },
  { hex: '#e83e8c', label: 'Pink' },
  // Neutral
  { hex: '#f8f9fa', label: 'Light gray' },
  { hex: '#dee2e6', label: 'Gray' },
  { hex: '#6c757d', label: 'Dark gray' },
  { hex: '#343a40', label: 'Almost black' },
  { hex: '#ffffff', label: 'White' },
  { hex: '#fffde7', label: 'Cream' },
  { hex: '#e8f5e9', label: 'Mint' },
  { hex: '#e3f2fd', label: 'Ice' },
];

// Currently selected color in the picker
let pickerFill = '#d4edda';
let pickerStroke = null; // null = auto (darker than fill)

function hexToRgb(hex) {
  const r = parseInt(hex.slice(1,3),16);
  const g = parseInt(hex.slice(3,5),16);
  const b = parseInt(hex.slice(5,7),16);
  return {r,g,b};
}

function darken(hex, factor=0.6) {
  if (!hex) return '#333';
  const {r,g,b} = hexToRgb(hex);
  return '#' + [r,g,b].map(v => Math.round(v*factor).toString(16).padStart(2,'0')).join('');
}

// Mixes a color toward white — used for the note background tint (same hue
// as the chosen color, just much lighter), as opposed to darken() above
// which mixes toward black for the auto text/stroke color.
function lighten(hex, amount=0.82) {
  if (!hex) return '#ffffff';
  const {r,g,b} = hexToRgb(hex);
  const mix = v => Math.round(v + (255 - v) * amount);
  return '#' + [r,g,b].map(v => mix(v).toString(16).padStart(2,'0')).join('');
}

// Picks readable text color (near-black or white) for a given background color.
function contrastTextColor(hex) {
  if (!hex) return '#222';
  const {r,g,b} = hexToRgb(hex);
  const luminance = (0.299*r + 0.587*g + 0.114*b) / 255;
  return luminance > 0.6 ? '#222' : '#fff';
}

// WCAG-style contrast ratio (1–21) between two hex colors — used as a
// safety net for note backgrounds: if the auto-picked text color doesn't
// contrast enough against the new lightened background, we force pure
// black/white instead (see contrastTextColor above).
function srgbChannelToLinear(c) {
  const cs = c / 255;
  return cs <= 0.03928 ? cs / 12.92 : Math.pow((cs + 0.055) / 1.055, 2.4);
}

function relativeLuminance(hex) {
  const {r,g,b} = hexToRgb(hex);
  return 0.2126 * srgbChannelToLinear(r) + 0.7152 * srgbChannelToLinear(g) + 0.0722 * srgbChannelToLinear(b);
}

function contrastRatio(hexA, hexB) {
  const lA = relativeLuminance(hexA);
  const lB = relativeLuminance(hexB);
  const lighter = Math.max(lA, lB);
  const darker = Math.min(lA, lB);
  return (lighter + 0.05) / (darker + 0.05);
}

function applyColor(elementId, fill, stroke) {
  const er = modeler.get('elementRegistry');
  const modeling = modeler.get('modeling');
  const el = er.get(elementId);
  if (!el) return;
  const strokeColor = stroke || darken(fill);
  modeling.setColor([el], { fill, stroke: strokeColor });
  setStatus('Color applied', 'ok');
  // Refresh the panel
  updatePropsPanel(modeler.get('selection').get());
}

function clearColor(elementId) {
  const er = modeler.get('elementRegistry');
  const modeling = modeler.get('modeling');
  const el = er.get(elementId);
  if (!el) return;
  modeling.setColor([el], { fill: null, stroke: null });
  setStatus('Color removed', 'ok');
  updatePropsPanel(modeler.get('selection').get());
}

function buildColorPicker(elementId) {
  const er = modeler.get('elementRegistry');
  const el = er.get(elementId);
  // di is available via the diagram element, not directly via businessObject
  let currentFill = null;
  try {
    const diElement = el && el.di;
    currentFill = diElement && diElement.fill || null;
  } catch(e) { currentFill = null; }

  let swatches = `<div class="color-palette">`;
  // "No color" swatch
  swatches += `<div class="color-swatch none${!currentFill ? ' active' : ''}" title="Remove color" onclick="clearColor('${escHtml(elementId)}')"></div>`;
  COLOR_PALETTE.forEach(c => {
    const isActive = currentFill && currentFill.toLowerCase() === c.hex.toLowerCase();
    swatches += `<div class="color-swatch${isActive ? ' active' : ''}"
      style="background:${c.hex}; border-color: ${isActive ? '#1a6bb5' : darken(c.hex, 0.8)};"
      title="${escHtml(c.label)}"
      onclick="applyColor('${escHtml(elementId)}', '${c.hex}', null)"></div>`;
  });
  swatches += `</div>`;

  const customRow = `<div class="color-row">
    <label>Custom:</label>
    <input type="color" id="custom-fill-picker" value="${currentFill || '#ffffff'}"
      oninput="document.getElementById('custom-fill-preview').style.background=this.value"
      onchange="document.getElementById('custom-fill-preview').style.background=this.value">
    <div class="color-preview-box" id="custom-fill-preview" style="background:${currentFill || '#ffffff'};"></div>
    <button class="color-apply-btn" onclick="applyColor('${escHtml(elementId)}', document.getElementById('custom-fill-picker').value, null)">Apply</button>
  </div>`;

  return `<div class="color-section">
    <div class="prop-name" style="margin-bottom:6px;">Fill color</div>
    ${swatches}
    ${customRow}
  </div>`;
}

// Collapse state for the Properties panel — a ▼/▲ toggle next to the
// "Properties" title lets you fold it away so the Process structure tree
// above can use the freed space, without losing the current selection.
// Persisted so it survives a reload.
const PROPS_PANEL_COLLAPSED_KEY = 'bpmnEditor.propsPanelCollapsed';
let propsPanelCollapsed = false;
try { propsPanelCollapsed = localStorage.getItem(PROPS_PANEL_COLLAPSED_KEY) === '1'; } catch (e) {}

function togglePropsPanelCollapsed() {
  propsPanelCollapsed = !propsPanelCollapsed;
  try { localStorage.setItem(PROPS_PANEL_COLLAPSED_KEY, propsPanelCollapsed ? '1' : '0'); } catch (e) {}
  updatePropsPanel(modeler.get('selection').get());
}

// Element ids the bulk panel's buttons currently act on, split by what kind
// of edit they support (a shift-selected group is usually a mix of types —
// e.g. some Tasks and a Gateway — so each capability has its own eligible
// subset, same rules as the single-element panel: no color on connections/
// lanes/pools, no System/Location/Description on connections, no resize on
// non-resizable types). Recomputed on every renderBulkPropsPanel() call, so
// the bulk buttons (defined as plain onclick="..." globals, which can't
// close over a local array) read it fresh each time.
let bulkPropsTargets = { color: [], meta: [], resize: [] };

// Multi-select Properties panel: unlike the single-element panel there's no
// one Name/Type/Id to show, so instead this surfaces only the fields that
// make sense to set identically across a whole group at once — Size, Fill
// color, System, Location, Description, Details — each applied only to the
// subset of the selection that actually supports it. Renamed elements,
// per-type actions (Call Activity target, "Enter subprocess") and the raw
// Name/Type/Id rows are deliberately left out: they're inherently
// per-element, and showing one of them "for the group" would either be
// meaningless or actively dangerous (e.g. giving every selected element the
// exact same Name).
function renderBulkPropsPanel(panel, selection) {
  // A label shares its parent shape's businessObject — if both the shape and
  // its own label happen to be in `selection` (rare, but possible via
  // lasso), counting both would just double up every field below.
  const elements = selection.filter(el => el.type !== 'label' && el.businessObject);

  const collapseBtn = `<button class="props-collapse-btn" onclick="togglePropsPanelCollapsed()"
    title="${propsPanelCollapsed ? 'Show properties' : 'Hide properties'}">${propsPanelCollapsed ? '▲' : '▼'}</button>`;
  const labelRow = `<div class="props-label-row"><div class="props-label">Properties</div>${collapseBtn}</div>`;

  if (propsPanelCollapsed) {
    panel.innerHTML = labelRow;
    panel.style.display = 'block';
    return;
  }

  const colorEls = elements.filter(el => el.businessObject.$type && !NO_COLOR_TYPES.includes(el.businessObject.$type));
  const metaEls = elements.filter(el => el.businessObject.id && el.businessObject.$type &&
    !DETAIL_FIELDS_EXCLUDED_TYPES.includes(el.businessObject.$type));
  const resizeEls = elements.filter(el => typeof el.width === 'number' && typeof el.height === 'number' && !el.waypoints &&
    modeler.get('rules').allowed('shape.resize', { shape: el }));

  bulkPropsTargets = {
    color: colorEls.map(el => el.id),
    meta: metaEls.map(el => el.id),
    resize: resizeEls.map(el => el.id)
  };

  const typeCounts = {};
  elements.forEach(el => {
    const t = (el.businessObject.$type || el.type || '?').replace('bpmn:', '');
    typeCounts[t] = (typeCounts[t] || 0) + 1;
  });
  const typeSummary = Object.entries(typeCounts).map(([t, n]) => `${n} × ${t}`).join(', ');

  let html = labelRow;
  html += `<div class="prop-row"><div class="prop-name">Selection</div>
    <div class="prop-val">${elements.length} elements selected</div></div>`;
  html += `<div class="prop-row" style="margin-top:-6px;">
    <div class="prop-val" style="color:#888;font-size:11px;">${escHtml(typeSummary)}</div></div>`;

  if (resizeEls.length > 0) {
    // Seeded from the first resizable element purely as a starting value —
    // Apply always sets every eligible element to exactly this width/height
    // (each keeps its own x/y top-left corner, same as single-element resize).
    const seed = resizeEls[0];
    html += `<div class="prop-row">
      <div class="prop-name">Size (${resizeEls.length} resizable)</div>
      <div style="display:flex;align-items:center;gap:6px;">
        <input class="prop-input" type="number" min="${MIN_SHAPE_SIZE}" step="1" style="width:64px;"
          id="bulk-prop-width" value="${Math.round(seed.width)}">
        <span style="color:#999;">×</span>
        <input class="prop-input" type="number" min="${MIN_SHAPE_SIZE}" step="1" style="width:64px;"
          id="bulk-prop-height" value="${Math.round(seed.height)}">
        <span style="color:#999;font-size:11px;">px</span>
      </div>
      <button class="prop-btn" style="margin-top:6px;" onclick="applyBulkSize()">Apply to ${resizeEls.length} element${resizeEls.length === 1 ? '' : 's'}</button>
    </div>`;
  }

  if (colorEls.length > 0) {
    html += buildBulkColorPicker(colorEls);
  }

  if (metaEls.length > 0) {
    (dictionaries.list || []).forEach(dict => {
      html += buildBulkMetaSelect({
        id: 'bulk-prop-dict-' + dict.id, label: dict.name || dict.id, count: metaEls.length,
        items: dict.items || [], metaKey: dict.metaKey, metaEls,
        onchange: `applyBulkDictValue('${dict.id}', this.value)`
      });
    });

    html += `<div class="prop-row" style="margin-top:10px;">
      <div class="prop-name">Description — overwrite all</div>
      <textarea class="prop-textarea" id="bulk-prop-description"
        placeholder="Type text, then Apply — overwrites Description on all ${metaEls.length} selected elements"></textarea>
      <button class="prop-btn" style="margin-top:6px;" onclick="applyBulkDescription()">Apply to ${metaEls.length} element${metaEls.length === 1 ? '' : 's'}</button>
    </div>`;

    html += `<div class="prop-row">
      <div class="prop-name">Details (URL) — overwrite all</div>
      <input class="prop-input" type="url" id="bulk-prop-details" placeholder="https://...">
      <button class="prop-btn" style="margin-top:6px;" onclick="applyBulkDetails()">Apply to ${metaEls.length} element${metaEls.length === 1 ? '' : 's'}</button>
    </div>`;
  }

  if (!resizeEls.length && !colorEls.length && !metaEls.length) {
    html += `<div class="prop-row"><div class="prop-val" style="color:#aaa;">None of the selected elements support shared editing (e.g. only connections are selected).</div></div>`;
  }

  panel.innerHTML = html;
  panel.style.display = 'block';
}

// Builds a <select> for a metadata field (System/Location) that also
// represents "the selection doesn't agree" as an explicit, non-selectable
// "— mixed —" option, distinct from "— none —" (every element explicitly
// has no value) — picking either always overwrites the whole group.
function buildBulkMetaSelect({ id, label, count, items, metaKey, metaEls, onchange }) {
  const values = new Set(metaEls.map(el => getElementMeta(el.businessObject, metaKey)));
  const mixed = values.size > 1;
  const common = mixed ? null : [...values][0];

  let opts = '';
  if (mixed) opts += `<option value="" disabled selected>— mixed —</option>`;
  opts += `<option value="" ${!mixed && common === '' ? 'selected' : ''}>— none —</option>`;
  opts += items.map(it =>
    `<option value="${escHtml(it.id)}" ${!mixed && it.id === common ? 'selected' : ''}>${escHtml(it.name || '(unnamed)')}</option>`
  ).join('');

  return `<div class="prop-row" style="margin-top:10px;">
    <div class="prop-name">${label} (${count} elements)</div>
    <select class="prop-input" id="${id}" onchange="${onchange}">${opts}</select>
  </div>`;
}

// Same swatch UI as buildColorPicker(), but applying sets the color across
// every color-eligible element in the current selection in ONE
// modeling.setColor() call — bpmn-js's setColor accepts an element array
// natively, so (unlike the per-element metadata fields below) this bulk
// action is a single undo step, not one step per element.
function buildBulkColorPicker(colorEls) {
  const fills = new Set(colorEls.map(el => {
    try { return (el.di && el.di.fill) || ''; } catch (e) { return ''; }
  }));
  const commonFill = fills.size === 1 ? [...fills][0] : null;

  let swatches = `<div class="color-palette">`;
  swatches += `<div class="color-swatch none${!commonFill ? ' active' : ''}" title="Remove color" onclick="clearBulkColor()"></div>`;
  COLOR_PALETTE.forEach(c => {
    const isActive = commonFill && commonFill.toLowerCase() === c.hex.toLowerCase();
    swatches += `<div class="color-swatch${isActive ? ' active' : ''}"
      style="background:${c.hex}; border-color: ${isActive ? '#1a6bb5' : darken(c.hex, 0.8)};"
      title="${escHtml(c.label)}"
      onclick="applyBulkColor('${c.hex}')"></div>`;
  });
  swatches += `</div>`;

  const customRow = `<div class="color-row">
    <label>Custom:</label>
    <input type="color" id="bulk-custom-fill-picker" value="${commonFill || '#ffffff'}"
      oninput="document.getElementById('bulk-custom-fill-preview').style.background=this.value"
      onchange="document.getElementById('bulk-custom-fill-preview').style.background=this.value">
    <div class="color-preview-box" id="bulk-custom-fill-preview" style="background:${commonFill || '#ffffff'};"></div>
    <button class="color-apply-btn" onclick="applyBulkColor(document.getElementById('bulk-custom-fill-picker').value)">Apply</button>
  </div>`;

  return `<div class="color-section">
    <div class="prop-name" style="margin-bottom:6px;">Fill color (${colorEls.length} elements)</div>
    ${swatches}
    ${customRow}
  </div>`;
}

function applyBulkSize() {
  const w = document.getElementById('bulk-prop-width');
  const h = document.getElementById('bulk-prop-height');
  if (!w || !h) return;
  let newWidth = Math.round(parseFloat(w.value));
  let newHeight = Math.round(parseFloat(h.value));
  if (!isFinite(newWidth) || newWidth < MIN_SHAPE_SIZE) newWidth = MIN_SHAPE_SIZE;
  if (!isFinite(newHeight) || newHeight < MIN_SHAPE_SIZE) newHeight = MIN_SHAPE_SIZE;
  w.value = newWidth;
  h.value = newHeight;

  const er = modeler.get('elementRegistry');
  const modeling = modeler.get('modeling');
  const rules = modeler.get('rules');
  let applied = 0;
  bulkPropsTargets.resize.forEach(id => {
    const el = er.get(id);
    if (!el || !rules.allowed('shape.resize', { shape: el })) return;
    if (el.width === newWidth && el.height === newHeight) return;
    modeling.resizeShape(el, { x: el.x, y: el.y, width: newWidth, height: newHeight });
    applied++;
  });
  refreshDetailOverlays();
  setStatus(`Size applied to ${applied} element${applied === 1 ? '' : 's'}`, 'ok');
}

function applyBulkColor(hex) {
  const er = modeler.get('elementRegistry');
  const els = bulkPropsTargets.color.map(id => er.get(id)).filter(Boolean);
  if (!els.length) return;
  modeler.get('modeling').setColor(els, { fill: hex, stroke: darken(hex) });
  setStatus(`Color applied to ${els.length} elements`, 'ok');
  updatePropsPanel(modeler.get('selection').get());
}

function clearBulkColor() {
  const er = modeler.get('elementRegistry');
  const els = bulkPropsTargets.color.map(id => er.get(id)).filter(Boolean);
  if (!els.length) return;
  modeler.get('modeling').setColor(els, { fill: null, stroke: null });
  setStatus(`Color removed from ${els.length} elements`, 'ok');
  updatePropsPanel(modeler.get('selection').get());
}

// Metadata (System/Location/Description/Details) lives in a plain in-memory
// map keyed by element id (see setElementMeta/flushMetaToModel above), not
// on a bpmn-js command — so unlike Size/Color there's no native multi-
// element call. Looping is fine functionally, but note it's N undo steps,
// not one: Ctrl+Z after a bulk metadata edit reverts one element at a time.
function applyBulkDictValue(dictId, valueId) {
  const dict = findDictionary(dictId);
  if (!dict) return;
  const er = modeler.get('elementRegistry');
  bulkPropsTargets.meta.forEach(id => {
    const el = er.get(id);
    if (el) setElementMeta(el.businessObject, dict.metaKey, valueId);
  });
  flushMetaToModel();
  refreshDetailOverlays();
  setStatus(`${dict.name || dict.id} applied to ${bulkPropsTargets.meta.length} elements`, 'ok');
}

function applyBulkDescription() {
  const input = document.getElementById('bulk-prop-description');
  if (!input) return;
  const er = modeler.get('elementRegistry');
  bulkPropsTargets.meta.forEach(id => {
    const el = er.get(id);
    if (el) setElementMeta(el.businessObject, 'description', input.value);
  });
  flushMetaToModel();
  setStatus(`Description applied to ${bulkPropsTargets.meta.length} elements`, 'ok');
}

function applyBulkDetails() {
  const input = document.getElementById('bulk-prop-details');
  if (!input) return;
  const er = modeler.get('elementRegistry');
  bulkPropsTargets.meta.forEach(id => {
    const el = er.get(id);
    if (el) setElementMeta(el.businessObject, 'details', input.value);
  });
  flushMetaToModel();
  refreshDetailOverlays();
  setStatus(`Details applied to ${bulkPropsTargets.meta.length} elements`, 'ok');
}

function updatePropsPanel(selection) {
  const panel = document.getElementById('props-panel');
  if (!selection || selection.length === 0) {
    panel.style.display = 'none';
    panel.innerHTML = '';
    return;
  }
  if (selection.length > 1) {
    renderBulkPropsPanel(panel, selection);
    return;
  }

  const el = selection[0];
  const bo = el.businessObject;
  if (!bo) { panel.style.display = 'none'; return; }

  const collapseBtn = `<button class="props-collapse-btn" onclick="togglePropsPanelCollapsed()"
    title="${propsPanelCollapsed ? 'Show properties' : 'Hide properties'}">${propsPanelCollapsed ? '▲' : '▼'}</button>`;
  const labelRow = `<div class="props-label-row"><div class="props-label">Properties</div>${collapseBtn}</div>`;

  if (propsPanelCollapsed) {
    panel.innerHTML = labelRow;
    panel.style.display = 'block';
    return;
  }

  const type = bo.$type || '';
  const name = bo.name || '';
  const id = bo.id || '';
  const safeId = escHtml(id);
  const isTask = type === 'bpmn:Task' || type === 'bpmn:UserTask' || type === 'bpmn:ServiceTask' || type === 'bpmn:ManualTask';
  const isCallActivity = type === 'bpmn:CallActivity';
  const isSubProcess = type === 'bpmn:SubProcess';

  let html = labelRow;
  html += `<div class="prop-row"><div class="prop-name">Name</div><div class="prop-val">${escHtml(name || '—')}</div></div>`;
  html += `<div class="prop-row"><div class="prop-name">Type</div><div class="prop-val">${escHtml(type.replace('bpmn:',''))}</div></div>`;

  // Size — for any element with geometry (not a connection/label).
  // Editable fields only when bpmn-js actually allows resizing this
  // type (our rule for Tasks + the built-in rules for Pool/Lane/expanded
  // Sub-Process/Text Annotation/...) — otherwise read-only.
  const hasSize = typeof el.width === 'number' && typeof el.height === 'number' && !el.waypoints && el.type !== 'label';
  if (hasSize) {
    const canResize = modeler.get('rules').allowed('shape.resize', { shape: el });
    if (canResize) {
      html += `<div class="prop-row">
        <div class="prop-name">Size</div>
        <div style="display:flex;align-items:center;gap:6px;">
          <input class="prop-input" type="number" min="${MIN_SHAPE_SIZE}" step="1" style="width:64px;"
            id="prop-width-${safeId}" value="${Math.round(el.width)}"
            onblur="applyElementSize('${safeId}')"
            onkeydown="if(event.key==='Enter'){this.blur();}">
          <span style="color:#999;">×</span>
          <input class="prop-input" type="number" min="${MIN_SHAPE_SIZE}" step="1" style="width:64px;"
            id="prop-height-${safeId}" value="${Math.round(el.height)}"
            onblur="applyElementSize('${safeId}')"
            onkeydown="if(event.key==='Enter'){this.blur();}">
          <span style="color:#999;font-size:11px;">px</span>
        </div>
      </div>`;
    } else {
      html += `<div class="prop-row"><div class="prop-name">Size</div><div class="prop-val">${Math.round(el.width)} × ${Math.round(el.height)} px</div></div>`;
    }
  }

  // Color picker — for all elements that have a fill
  const supportsColor = !!type && !NO_COLOR_TYPES.includes(type);
  if (supportsColor) {
    html += buildColorPicker(id);
  }

  // Time (s) — manual duration field shown only when Time analysis is
  // enabled in Settings. Sub-processes/Call Activities get the same single
  // field as a Task and ignore their own inner content (mirrors PNG export's
  // per-plane scoping) — v1 has no calculation engine, this is storage +
  // on-canvas display only.
  if (timeAnalysisEnabled && TIME_FIELD_TYPES.includes(type)) {
    const timeVal = getElementMeta(bo, 'time');
    html += `<div class="prop-row" style="margin-top:10px;">
      <div class="prop-name">Time (s)</div>
      <input class="prop-input" type="number" min="0" step="1" style="width:100px;"
        id="prop-time-${safeId}" value="${escHtml(timeVal)}" placeholder="—"
        onblur="applyElementTime('${safeId}')"
        onkeydown="if(event.key==='Enter'){this.blur();}">
    </div>`;
  }

  if (isCallActivity) {
    const target = bo.calledElement || '';
    const planes = modeler.get('canvas')._planes || [];
    const targetPlane = planes.find(p => p.rootElement && p.rootElement.businessObject && p.rootElement.businessObject.id === target);
    const targetName = targetPlane ? (targetPlane.rootElement.businessObject.name || target) : (target || '— none');
    html += `<div class="prop-row"><div class="prop-name">Target (calledElement)</div><div class="prop-val" style="color:#1a6bb5;">${escHtml(targetName)}</div></div>`;
    html += `<button class="prop-btn" onclick="openCallActivitySelector('${escHtml(id)}')">Change target…</button>`;
    if (target) {
      html += `<button class="prop-btn" style="margin-top:4px;" onclick="treeNavigateTo('${escHtml(target)}')">Go to target ↗</button>`;
    }
    html += `<button class="prop-btn danger" style="margin-top:4px;" onclick="convertCallActivityToTask('${escHtml(id)}')">Remove link (→ Task)</button>`;
  } else if (isTask) {
    html += `<button class="prop-btn" onclick="convertToCallActivity('${escHtml(id)}')">Mark as Call Activity ⇒</button>`;
  } else if (isSubProcess) {
    html += `<button class="prop-btn" onclick="treeNavigateTo('${escHtml(id)}')">Enter subprocess ↗</button>`;
  }

  // Time analysis — % split of an Exclusive gateway's outgoing paths. Only
  // XOR gateways get this (a percentage split of "which single path is
  // taken" isn't meaningful for Parallel/Inclusive/EventBased/Complex).
  // v1: no validation blocking a sum ≠ 100%, just a red/green indicator
  // here in the panel (not on canvas, per explicit decision) — no default-%
  // auto-fill either.
  if (timeAnalysisEnabled && type === 'bpmn:ExclusiveGateway') {
    const outgoingFlows = bo.outgoing || [];
    if (outgoingFlows.length) {
      let sum = 0;
      const rows = outgoingFlows.map(flowBo => {
        const val = getElementMeta(flowBo, 'probability');
        const num = val === '' ? 0 : (parseInt(val, 10) || 0);
        sum += num;
        const label = flowBo.name || flowBo.id;
        return `<div class="prop-row" style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:6px;">
          <div class="prop-name" style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${escHtml(label)}">${escHtml(label)}</div>
          <div style="display:flex;align-items:center;gap:4px;flex-shrink:0;">
            <input class="prop-input" type="number" min="0" max="100" step="1" style="width:60px;"
              id="prop-flowpct-${escHtml(flowBo.id)}" value="${escHtml(val)}" placeholder="0"
              onblur="applyFlowProbability('${escHtml(flowBo.id)}')"
              onkeydown="if(event.key==='Enter'){this.blur();}">
            <span style="color:#999;font-size:11px;">%</span>
          </div>
        </div>`;
      }).join('');
      const sumColor = sum === 100 ? '#2e7d32' : '#c0392b';
      html += `<div class="prop-row" style="margin-top:14px;">
        <div class="prop-name" style="text-transform:uppercase;font-size:11px;letter-spacing:0.04em;color:#888;">Time analysis</div>
      </div>
      ${rows}
      <div class="prop-row" style="margin-top:6px;font-size:11px;color:${sumColor};font-weight:600;">Suma: ${sum}%</div>`;
    }
  }

  // Description and Details fields — for all elements with an id
  if (id && type && !['bpmn:SequenceFlow','bpmn:MessageFlow','bpmn:Association',
      'bpmn:DataInputAssociation','bpmn:DataOutputAssociation'].includes(type)) {
    const descVal = getElementMeta(bo, 'description');
    const detailsVal = getElementMeta(bo, 'details');
    const detailsUrl = detailsVal.trim();

    // One generic <select> per dictionary — the label is the dictionary's
    // own (possibly renamed) name, kept in sync with Settings (point 6).
    (dictionaries.list || []).forEach(dict => {
      const currentValueId = getElementMeta(bo, dict.metaKey);
      const dictOptions = (dict.items || []).map(it =>
        `<option value="${escHtml(it.id)}" ${it.id === currentValueId ? 'selected' : ''}>${escHtml(it.name || '(unnamed)')}</option>`
      ).join('');
      html += `<div class="prop-row" style="margin-top:10px;">
        <div class="prop-name">${escHtml(dict.name || dict.id)}</div>
        <select class="prop-input" id="prop-dict-${dict.id}-${safeId}" onchange="setElementDictValue('${safeId}', '${dict.id}', this.value)">
          <option value="">— none —</option>
          ${dictOptions}
        </select>
      </div>`;
    });

    html += `<div class="prop-row" style="margin-top:10px;">
      <div class="prop-name">Description</div>
      <textarea class="prop-textarea" id="prop-description-${safeId}"
        placeholder="Describe this element..."
        onblur="autoSaveFields('${safeId}')">${escHtml(descVal)}</textarea>
    </div>`;

    html += `<div class="prop-row">
      <div class="prop-name">Details (URL)</div>
      <input class="prop-input" type="url" id="prop-details-${safeId}"
        placeholder="https://..."
        value="${escHtml(detailsVal)}"
        onblur="autoSaveFields('${safeId}')">
      <a class="prop-link" id="prop-details-link-${safeId}"
        href="${escHtml(detailsUrl)}" target="_blank" rel="noopener"
        style="display:${detailsUrl ? 'block' : 'none'};">${escHtml(detailsUrl)}</a>
    </div>`;
  }

  panel.innerHTML = html;
  panel.style.display = 'block';
}

function convertToCallActivity(elementId) {
  const er = modeler.get('elementRegistry');
  const el = er.get(elementId);
  if (!el) return;
  // bpmn-js doesn't allow changing $type via updateProperties — use
  // bpmnReplace to actually turn the element into a Call Activity.
  const replace = modeler.get('bpmnReplace');
  const newEl = replace.replaceElement(el, { type: 'bpmn:CallActivity' });
  setStatus('Converted to Call Activity', 'ok');
  createAndLinkNewCallActivityTarget(newEl.id);
}

// A brand-new Call Activity has nowhere to "enter" until it's linked to a
// target sub-process — unlike converting an element straight to
// bpmn:SubProcess, which gets its own (empty, but real) inner canvas
// immediately. To match that experience rather than dropping the user into
// a "Select target" dialog with nothing in it yet, auto-create a brand-new,
// empty bpmn:SubProcess right below the Call Activity (in the same parent
// container) and link calledElement to it right away — same underlying
// calledElement-as-file-internal-reference mechanism this app's Call
// Activity support already uses elsewhere (see
// treeNavigateToCallActivity/openCallActivitySelector/applyCallActivityTarget),
// just skipping the manual "pick a target" step for the common case of a
// freshly created Call Activity with no target yet. The user can still
// re-point it to a different existing subprocess afterwards via "Change
// target…", and the auto-created subprocess is never auto-deleted (e.g. by
// "Remove link (→ Task)") to avoid unexpected data loss.
function createAndLinkNewCallActivityTarget(callActivityId) {
  const er = modeler.get('elementRegistry');
  const el = er.get(callActivityId);
  if (!el) return;

  const modeling = modeler.get('modeling');
  const elementFactory = modeler.get('elementFactory');
  const bpmnFactory = modeler.get('bpmnFactory');

  const targetBo = bpmnFactory.create('bpmn:SubProcess', { name: 'New subprocess' });
  const shape = elementFactory.createShape({
    type: 'bpmn:SubProcess',
    businessObject: targetBo,
    isExpanded: false
  });

  // modeling.createShape's position argument is the shape's CENTER point —
  // place it centered under the Call Activity with a small gap.
  const gap = 40;
  const position = {
    x: el.x + el.width / 2,
    y: el.y + el.height + gap + shape.height / 2
  };

  try {
    modeling.createShape(shape, position, el.parent);
  } catch (e) {
    setStatus('Could not auto-create subprocess target', 'err');
    return;
  }

  modeling.updateProperties(el, { calledElement: targetBo.id });

  // modeling.createShape() selects the shape it just created (the new
  // target sub-process) — left alone, the Properties panel would then show
  // that brand-new, still-unnamed sub-process instead of the Call Activity
  // the user actually has selected/is looking at. Re-select the Call
  // Activity itself so the panel (and its "Target (calledElement)" /
  // "Go to target ↗" rows) reflects what just happened to IT.
  modeler.get('selection').select(el);
  refreshDetailOverlays();
  updateTree();
  updatePropsPanel(modeler.get('selection').get());
  setStatus('Call Activity → new empty subprocess created', 'ok');
}

function convertCallActivityToTask(elementId) {
  const er = modeler.get('elementRegistry');
  const el = er.get(elementId);
  if (!el) return;
  const replace = modeler.get('bpmnReplace');
  replace.replaceElement(el, { type: 'bpmn:Task' });
  setStatus('Call Activity link removed', 'ok');
  updateTree();
  refreshDetailOverlays();
}

function escHtml(str) {
  return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

/* ─── PANEL RESIZE (gripka na dole) ─── */
(function() {
  const grip  = document.getElementById('panel-resize-grip');
  const panel = document.getElementById('structure-panel');
  let startX, startW, active = false;

  function startResize(clientX) {
    startX = clientX;
    startW = panel.offsetWidth;
    active = true;
    grip.classList.add('dragging');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }

  function doResize(clientX) {
    if (!active) return;
    // Dragging left → wider panel, right → narrower
    const delta = startX - clientX;
    const newW = Math.min(520, Math.max(160, startW + delta));
    panel.style.width = newW + 'px';
  }

  function endResize() {
    if (!active) return;
    active = false;
    grip.classList.remove('dragging');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    document.removeEventListener('mousemove', onMouseMove);
    document.removeEventListener('mouseup', onMouseUp);
    document.removeEventListener('touchmove', onTouchMove);
    document.removeEventListener('touchend', onTouchEnd);
  }

  function onMouseMove(e) { doResize(e.clientX); }
  function onMouseUp()    { endResize(); }
  function onTouchMove(e) { e.preventDefault(); doResize(e.touches[0].clientX); }
  function onTouchEnd()   { endResize(); }

  grip.addEventListener('mousedown', e => {
    startResize(e.clientX);
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
    e.preventDefault();
  });

  grip.addEventListener('touchstart', e => {
    startResize(e.touches[0].clientX);
    document.addEventListener('touchmove', onTouchMove, { passive: false });
    document.addEventListener('touchend', onTouchEnd);
    e.preventDefault();
  }, { passive: false });
})();

/* ─── DRAG & DROP ─── */
const canvasEl = document.getElementById('canvas');
const overlayEl = document.getElementById('drop-overlay');
canvasEl.addEventListener('dragenter', e => { e.preventDefault(); overlayEl.classList.add('visible'); });
canvasEl.addEventListener('dragleave', e => { if (!canvasEl.contains(e.relatedTarget)) overlayEl.classList.remove('visible'); });
canvasEl.addEventListener('dragover', e => e.preventDefault());
canvasEl.addEventListener('drop', e => {
  e.preventDefault();
  overlayEl.classList.remove('visible');
  const file = e.dataTransfer.files[0];
  if (!file) return;
  currentFileHandle = null; // a dropped file doesn't give us a save handle
  forgetLastFileHandle(); // see the comment in openFile()
  const reader = new FileReader();
  reader.onload = async ev => { await importXml(ev.target.result, file.name); updateAutosaveIndicator(); };
  reader.readAsText(file);
});

/* ─── HELP / USER GUIDE (?) ───
   In-app guide covering everything the app can do (files, structure
   navigation, properties, Systems/Locations, Extended details, XML panel,
   shortcuts), in EN/PL/RU. Content lives in help-content.js; this just
   renders it in a dialog with a language switcher, same visual pattern as
   the Settings dialog above. */
let helpLang = 'en';
try { helpLang = localStorage.getItem('bpmnEditor.helpLang') || 'en'; } catch(e) {}

function openHelp() {
  const old = document.getElementById('help-dialog');
  if (old) old.remove();

  const dialog = document.createElement('div');
  dialog.id = 'help-dialog';
  dialog.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.4);z-index:1000;display:flex;align-items:center;justify-content:center;';
  dialog.innerHTML = renderHelpDialogHtml();
  document.body.appendChild(dialog);
  dialog.addEventListener('click', e => { if (e.target === dialog) dialog.remove(); });
}

function renderHelpDialogHtml() {
  const langs = [['en', 'EN'], ['pl', 'PL'], ['ru', 'RU']];
  const tabs = langs.map(([code, label]) => {
    const active = helpLang === code;
    return `<button onclick="setHelpLang('${code}')" style="font-size:12px;padding:5px 14px;${active ? 'background:#1a6bb5;color:#fff;border-color:#1558a0;' : ''}">${label}</button>`;
  }).join('');

  return `<div style="background:#fff;border-radius:10px;width:720px;max-width:92vw;max-height:86vh;box-shadow:0 8px 32px rgba(0,0,0,0.18);display:flex;flex-direction:column;overflow:hidden;">
    <div style="display:flex;align-items:center;gap:12px;padding:14px 20px;border-bottom:1px solid #e8e8e4;flex-shrink:0;">
      <div style="font-size:15px;font-weight:600;flex:1;">User guide</div>
      <div style="display:flex;gap:4px;">${tabs}</div>
      <button onclick="document.getElementById('help-dialog').remove()" style="font-size:13px;padding:5px 10px;">✕</button>
    </div>
    <div class="help-content" style="overflow-y:auto;padding:8px 24px 24px;">${HELP_CONTENT[helpLang]}</div>
  </div>`;
}

function setHelpLang(lang) {
  helpLang = lang;
  try { localStorage.setItem('bpmnEditor.helpLang', lang); } catch(e) {}
  const dialog = document.getElementById('help-dialog');
  if (dialog) dialog.innerHTML = renderHelpDialogHtml();
}

/* ─── FIRST-TIME ONBOARDING CALLOUT ───
   A coachmark pointing at the Help ("?") button so first-time users
   notice it, with a dimming overlay behind it so it (and the highlighted
   button) stand out. Shown once on first launch; dismissed for good (via
   localStorage) as soon as it's closed, the overlay is clicked, or its
   "HOW TO" button is used to open the guide. */
(function initHelpOnboarding() {
  let seen = false;
  try { seen = localStorage.getItem('bpmnEditor.onboardingSeen') === '1'; } catch(e) {}
  if (seen) return;

  const el = document.getElementById('help-onboarding');
  const overlay = document.getElementById('help-onboarding-overlay');
  const toggleBtn = document.getElementById('help-toggle');
  if (!el) return;

  function dismissOnboarding() {
    el.style.display = 'none';
    if (overlay) overlay.style.display = 'none';
    if (toggleBtn) toggleBtn.classList.remove('onboarding-highlight');
    try { localStorage.setItem('bpmnEditor.onboardingSeen', '1'); } catch(e) {}
  }

  el.style.display = 'block';
  if (overlay) overlay.style.display = 'block';
  if (toggleBtn) toggleBtn.classList.add('onboarding-highlight');

  const closeBtn = document.getElementById('help-onboarding-close');
  const howToBtn = document.getElementById('help-onboarding-btn');
  if (closeBtn) closeBtn.addEventListener('click', dismissOnboarding);
  if (overlay) overlay.addEventListener('click', dismissOnboarding);
  if (howToBtn) howToBtn.addEventListener('click', () => {
    dismissOnboarding();
    openHelp();
  });
})();

/* ─── SHORTCUTS ─── */
document.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); saveDiagram(); }
  if ((e.ctrlKey || e.metaKey) && e.key === 'o') { e.preventDefault(); triggerFileOpen(); }
  if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
  if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.key === 'z' && e.shiftKey))) { e.preventDefault(); redo(); }
  // Escape intentionally does NOT navigate up to the parent process anymore
  // — jumping planes on Escape was reported as disruptive (easy to trigger
  // by accident, e.g. while just trying to drop a selection). bpmn-js's own
  // Keyboard module already binds Escape to clear the current selection —
  // that default is left alone; we simply no longer layer plane navigation
  // on top of it.
  // bpmn-js's own diagram already binds Ctrl/Cmd +, -, 0 to its own
  // per-tab zoom once the canvas has focus (see focusCanvas()) — so we
  // don't re-implement the zoom itself here (that would double it up on
  // every press). What bpmn-js's handler does NOT do is call
  // preventDefault(), so left alone, the *browser's* native page zoom
  // would still fire on top of it — and that's the part that's shared
  // across every tab open to the same site, which was the actual bug
  // report. Suppressing just the browser's default here is enough to stop
  // that; bpmn-js's own listener still runs normally afterwards.
  if ((e.ctrlKey || e.metaKey) && (e.key === '+' || e.key === '=' || e.key === '-' || e.key === '0')) {
    e.preventDefault();
  }
});

if (typeof BpmnJS !== 'undefined') {
  initModeler();
} else {
  setStatus('Error: bpmn-js failed to load', 'err');
}
