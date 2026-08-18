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

function navigateUp() {
  if (navStack.length === 0) return;
  const prev = navStack.pop();
  modeler.get('canvas').setRootElement(prev.rootEl);
  if (prev.viewport) {
    modeler.get('canvas').viewbox(prev.viewport);
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
  let html = '';

  // "Back to parent" button
  if (navStack.length > 0) {
    const parentEntry = navStack[navStack.length - 1];
    const parentType = parentEntry.rootEl && parentEntry.rootEl.businessObject && parentEntry.rootEl.businessObject.$type;
    const parentLabel = (parentType === 'bpmn:Process' || parentType === 'bpmn:Collaboration')
      ? getProcessDisplayName()
      : parentEntry.label;
    html += `<button class="bc-back-btn" onclick="navigateUp()">↑ Back to: ${escHtml(parentLabel)}</button>`;
  }

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

function updateTree() {
  const treeEl = document.getElementById('structure-tree');
  const currentRoot = getCurrentRoot();

  try {
    // Find the main process — independent of whether it's a bare
    // bpmn:process or wrapped in a bpmn:collaboration (pool, with or
    // without lanes). See getMainProcessBo() for why these two shapes are
    // treated the same here. Reaching "No diagram" now only happens for
    // genuinely unsupported shapes (e.g. 2+ participants, or a participant
    // with no processRef at all) — there's no in-between case left that
    // needs a manual conversion step.
    const processRoot = findProcessRoot();
    const processBo = getMainProcessBo();
    if (!processRoot || !processBo) {
      treeEl.innerHTML = '<div style="padding:12px;font-size:12px;color:#aaa;">No diagram</div>';
      return;
    }

    const subprocesses = buildSubprocessTree(processBo, 1);
    const currentBo = currentRoot ? currentRoot.businessObject : null;

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

    // Subprocesses and Call Activities
    subprocesses.forEach(item => {
      const isActive = currentBo && currentBo === item.bo;
      const indent = item.depth * 16;
      const label = item.bo.name || item.bo.id || 'Subprocess';

      if (item.type === 'callactivity') {
        const targetId = item.targetRef;
        const targetLabel = targetId
          ? (subprocesses.find(s => s.bo.id === targetId)
            ? (subprocesses.find(s => s.bo.id === targetId).bo.name || targetId)
            : targetId)
          : '— not set';
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
        </div>`;
      }
    });

    treeEl.innerHTML = html;
  } catch(e) {
    treeEl.innerHTML = `<div style="padding:12px;font-size:12px;color:#c00;">Error: ${e.message}</div>`;
  }
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
  const mainProcessBo = getMainProcessBo();

  // Save the current viewport for the current level
  const currentVp = modeler.get('canvas').viewbox();

  // Build a new stack: for every ancestor of targetRoot, take the viewport from the old stack if present,
  // and for the current level save the current viewport
  const newStack = path.map(bo => {
    // The top-of-path entry is always the main process bo (see
    // findPathToSubprocess()) — for a pool/lane-wrapped file there's no
    // plane whose businessObject is that raw bpmn:Process, since its flow
    // nodes are drawn directly on the collaboration's own plane. Resolve
    // that one via findProcessRoot() instead of a plane lookup.
    const rootEl = (bo === mainProcessBo)
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
}

function findPathToSubprocess(targetBo) {
  // Returns an array of businessObjects from the main process down to targetBo's parent (excluding targetBo)
  const processBo = getMainProcessBo();
  if (!processBo) return [];

  const path = [];
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
  search(processBo, path);
  return path;
}

/* ─── MODELER INIT ─── */

// Task-shaped elements that get resize handles — bpmn-js disallows resizing
// these by default (only containers like expanded sub-processes, pools,
// lanes, text annotations etc. are resizable out of the box).
const RESIZABLE_TASK_TYPES = ['bpmn:Task', 'bpmn:UserTask', 'bpmn:ServiceTask', 'bpmn:ManualTask',
  'bpmn:ScriptTask', 'bpmn:BusinessRuleTask', 'bpmn:SendTask', 'bpmn:ReceiveTask', 'bpmn:CallActivity'];

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

  // Allow resizing Tasks — override the built-in rule. The "rules" service
  // itself has no addRule() in this bundle (that lives on BpmnRules, which
  // isn't exposed under its own DI key here), so we hook the eventBus
  // directly at the same event RuleProvider.addRule() would use internally:
  // "commandStack.<action>.canExecute". Priority higher than bpmn-js's
  // default means ours is checked first; returning `undefined` for anything
  // else leaves bpmn-js's own rule to decide, so existing resizable elements
  // (sub-processes, pools, lanes, ...) are unaffected.
  modeler.get('eventBus').on('commandStack.shape.resize.canExecute', 2000, function(event) {
    const shape = event.context && event.context.shape;
    if (shape && RESIZABLE_TASK_TYPES.includes(shape.type)) {
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
  // This also covers a freshly-replaced COLLAPSED Sub-Process, which is
  // still task-sized visually — but deliberately NOT an expanded one, since
  // that's a container that's meant to grow and forcing it back to
  // task-size would make it useless.
  const TYPE_CHANGE_SIZE_PRESERVE_TYPES = RESIZABLE_TASK_TYPES.concat(['bpmn:SubProcess']);
  modeler.get('eventBus').on('commandStack.shape.replace.postExecuted', function(event) {
    const context = event.context || {};
    const oldShape = context.oldShape;
    const newShape = context.newShape;
    if (!oldShape || !newShape) return;
    if (!TYPE_CHANGE_SIZE_PRESERVE_TYPES.includes(oldShape.type) || !TYPE_CHANGE_SIZE_PRESERVE_TYPES.includes(newShape.type)) return;
    if (newShape.type === 'bpmn:SubProcess' && newShape.collapsed === false) return;
    if (oldShape.width === newShape.width && oldShape.height === newShape.height &&
        oldShape.x === newShape.x && oldShape.y === newShape.y) return;
    modeler.get('modeling').resizeShape(newShape, {
      x: oldShape.x,
      y: oldShape.y,
      width: oldShape.width,
      height: oldShape.height
    });
    // bpmn-js re-selects newShape as part of the replace, so the props
    // panel already re-rendered once (at the type's default size) before
    // we restored the old bounds here — refresh it so the Size fields don't
    // show a stale default.
    updatePropsPanel(modeler.get('selection').get());
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
    updateTree();
    scheduleAutosave();
  });

  // Handle drill-down via a click on bpmn-js's arrow
  modeler.on('root.set', () => {
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
    : 'Auto-save turns on automatically after the first “Save .bpmn” or “Open…”';
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
      dictionaries = mergeDictionaries(dictionaries, embeddedDicts);
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
// gap from the element's top edge, so the icon never overlaps the shape.
// Note on bpmn-js math: "right" in an overlay's position is measured from the
// LEFT edge of the element going right, so to line up the icon's right edge
// with the element's right edge, "right" must equal the icon's own width
// (not 0, and not a negative number).
const DETAIL_OVERLAY_SIZE = 20;
const DETAIL_OVERLAY_GAP = 6;

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

// Element types without their own Description/Details/System fields — same
// list as in updatePropsPanel, so overlays only ever appear where these
// fields can actually be set.
const DETAIL_FIELDS_EXCLUDED_TYPES = ['bpmn:SequenceFlow', 'bpmn:MessageFlow', 'bpmn:Association',
  'bpmn:DataInputAssociation', 'bpmn:DataOutputAssociation'];

let extendedDetailsEnabled = false;
try { extendedDetailsEnabled = localStorage.getItem('bpmnEditor.extendedDetails') === '1'; } catch(e) {}
let detailOverlayIds = [];

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
    ? 'Extended details are on — elements with a URL show a link icon, elements with a System show a badge'
    : 'Extended details are off';
}

function refreshDetailOverlays() {
  if (!modeler) return;
  const overlays = modeler.get('overlays');

  // Remove previous overlays — easier to rebuild from scratch than to diff.
  detailOverlayIds.forEach(id => { try { overlays.remove(id); } catch(e) {} });
  detailOverlayIds = [];

  if (!extendedDetailsEnabled) return;

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
    if (!bo || !bo.$type || DETAIL_FIELDS_EXCLUDED_TYPES.includes(bo.$type)) return;

    const url = (getElementMeta(bo, 'details') || '').trim();
    if (url) {
      try {
        const overlayId = overlays.add(el, 'detail-link', {
          position: { top: -(DETAIL_OVERLAY_GAP + DETAIL_OVERLAY_SIZE), right: DETAIL_OVERLAY_SIZE },
          html: `<a class="detail-link-overlay" href="${escHtml(url)}" target="_blank" rel="noopener"
            title="${escHtml(url)}" onmousedown="event.stopPropagation()">↗</a>`
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

    const systemId = (getElementMeta(bo, 'system') || '').trim();
    const system = systemId ? getSystemById(systemId) : null;
    if (system) {
      try {
        const textColor = contrastTextColor(system.color);
        // Below the element: grows downward naturally as it wraps, so no
        // position math is needed beyond the usual fixed gap.
        const overlayId = overlays.add(el, 'system-badge', {
          position: { left: 0, bottom: -SYSTEM_BADGE_GAP },
          html: `<span class="system-badge-overlay" style="background:${escHtml(system.color)}; color:${textColor}; max-width:${maxWidthPx}px; width:max-content;"
            title="System: ${escHtml(system.name || '')}">${escHtml(system.name || '?')}</span>`
        });
        detailOverlayIds.push(overlayId);
      } catch(e) {
        // element may not have its own graphical representation — skip
      }
    }

    const locationId = (getElementMeta(bo, 'location') || '').trim();
    const location = locationId ? getLocationById(locationId) : null;
    if (location) {
      try {
        const textColor = contrastTextColor(location.color);
        const labelText = location.name || '?';
        // Above the element: measure the real rendered height first (1 line
        // vs. wrapped 2 lines) so the badge grows UPWARD — the gap right
        // above the element stays fixed, only the top edge moves higher.
        const badgeHeight = measureBadgeHeight('location-badge-overlay', labelText, maxWidthPx);
        const overlayId = overlays.add(el, 'location-badge', {
          position: { top: -(LOCATION_OVERLAY_GAP + LOCATION_OVERLAY_TOP_CORRECTION + badgeHeight), left: 0 },
          html: `<span class="location-badge-overlay" style="background:${escHtml(location.color)}; color:${textColor}; max-width:${maxWidthPx}px; width:max-content;"
            title="Location: ${escHtml(location.name || '')}">${escHtml(labelText)}</span>`
        });
        detailOverlayIds.push(overlayId);
      } catch(e) {
        // element may not have its own graphical representation — skip
      }
    }
  });
}

/* ─── GRID BACKGROUND (#) ───
   Purely visual — a dashed grid drawn on the canvas to help with alignment.
   Does NOT change bpmn-js's own snap-to-grid behavior (that stays fixed at
   10px, built into the library). Three states cycled by clicking the button:
   0 = off, 10 = light-blue button + 10px grid, 50 = blue button + 50px grid.
   Whichever spacing is active, lines every 100px are drawn a bit darker so
   there's always a visible "every 100" reference regardless of 10 vs 50. */
const GRID_SIZES = [0, 10, 50];
const GRID_MAJOR_SPACING = 100;
const GRID_MINOR_COLOR = '#e3e3df';
const GRID_MAJOR_COLOR = '#c9c9c3';
// Half-extent (in diagram units) of the grid rect around the origin — large
// enough that panning around a normal diagram never runs past its edge.
const GRID_HALF_EXTENT = 20000;
const SVG_NS = 'http://www.w3.org/2000/svg';

let gridSize = 0;
try {
  const stored = parseInt(localStorage.getItem('bpmnEditor.gridSize'), 10);
  if (GRID_SIZES.includes(stored)) gridSize = stored;
} catch (e) {}

function toggleGrid() {
  const idx = GRID_SIZES.indexOf(gridSize);
  gridSize = GRID_SIZES[(idx + 1) % GRID_SIZES.length];
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
  } else if (gridSize === 10) {
    btn.classList.add('grid-10');
    btn.title = 'Grid: 10px';
  } else {
    btn.classList.add('primary');
    btn.title = 'Grid: 50px';
  }
}

function makeGridPattern(id, spacing, color) {
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
  lineH.setAttribute('stroke-dasharray', '2,2');

  const lineV = document.createElementNS(SVG_NS, 'line');
  lineV.setAttribute('x1', 0); lineV.setAttribute('y1', 0);
  lineV.setAttribute('x2', 0); lineV.setAttribute('y2', spacing);
  lineV.setAttribute('stroke', color);
  lineV.setAttribute('stroke-width', 1);
  lineV.setAttribute('stroke-dasharray', '2,2');

  pattern.appendChild(lineH);
  pattern.appendChild(lineV);
  return pattern;
}

// Rebuilds the grid layer from scratch — cheap enough (a handful of DOM
// nodes) to just redo on every toggle/import rather than diff it.
function renderGridBackground() {
  if (!modeler) return;
  let svg;
  try { svg = modeler.get('canvas')._svg; } catch (e) { return; }
  if (!svg) return;

  const oldLayer = svg.querySelector('#app-grid-layer');
  if (oldLayer) oldLayer.remove();
  const oldDefs = svg.querySelector('#app-grid-defs');
  if (oldDefs) oldDefs.remove();

  if (!gridSize) return;

  const viewport = svg.querySelector('.viewport');
  if (!viewport) return;

  const defs = document.createElementNS(SVG_NS, 'defs');
  defs.setAttribute('id', 'app-grid-defs');
  defs.appendChild(makeGridPattern('app-grid-minor', gridSize, GRID_MINOR_COLOR));
  defs.appendChild(makeGridPattern('app-grid-major', GRID_MAJOR_SPACING, GRID_MAJOR_COLOR));
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

function loadDictionaries() {
  try {
    const raw = localStorage.getItem(DICTIONARIES_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (!parsed.systems) parsed.systems = [];
      if (!parsed.locations) parsed.locations = [];
      return parsed;
    }
  } catch (e) {}
  return { systems: [], locations: [] };
}

function saveDictionaries() {
  try { localStorage.setItem(DICTIONARIES_STORAGE_KEY, JSON.stringify(dictionaries)); } catch (e) {}
}

let dictionaries = loadDictionaries();

function getSystemById(id) {
  return (dictionaries.systems || []).find(s => s.id === id) || null;
}

function getLocationById(id) {
  return (dictionaries.locations || []).find(l => l.id === id) || null;
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

// File wins for entries that exist in both (same id); local-only entries
// (not yet saved into any file) are kept rather than dropped.
function mergeDictionaries(local, incoming) {
  if (!incoming) return local;
  const merged = { systems: [...(local.systems || [])], locations: [...(local.locations || [])] };
  ['systems', 'locations'].forEach(cat => {
    (incoming[cat] || []).forEach(item => {
      const idx = merged[cat].findIndex(x => x.id === item.id);
      if (idx >= 0) merged[cat][idx] = item;
      else merged[cat].push(item);
    });
  });
  // File wins for taskDefaultSize too (same rule as systems/locations entries);
  // fall back to whatever we already had locally if the file doesn't carry one.
  merged.taskDefaultSize = incoming.taskDefaultSize || local.taskDefaultSize || null;
  return merged;
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

function renderDictRows(items, listId, updateFn, removeFn) {
  return items.map((s, i) => `
    <div style="display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid #f0f0ec;">
      <input type="color" value="${s.color}" onchange="${updateFn}(${i}, 'color', this.value)"
        style="width:32px;height:28px;border:1px solid #d0d0cc;border-radius:5px;padding:1px;cursor:pointer;">
      <input type="text" value="${escHtml(s.name)}" placeholder="Name" onchange="${updateFn}(${i}, 'name', this.value)"
        style="flex:1;font-size:13px;padding:5px 8px;border:1px solid #d0d0cc;border-radius:5px;">
      <button title="Remove" onclick="${removeFn}(${i})"
        style="font-size:12px;padding:4px 8px;border-color:#c0392b;color:#c0392b;">✕</button>
    </div>`
  ).join('');
}

function renderSettingsDialogHtml() {
  const systems = dictionaries.systems || [];
  const systemRows = renderDictRows(systems, 'dict-systems-list', 'updateDictSystemField', 'removeDictSystem')
    || '<div style="padding:12px 0;font-size:12px;color:#aaa;">No systems yet — add one below.</div>';

  const locations = dictionaries.locations || [];
  const locationRows = renderDictRows(locations, 'dict-locations-list', 'updateDictLocationField', 'removeDictLocation')
    || '<div style="padding:12px 0;font-size:12px;color:#aaa;">No locations yet — add one below.</div>';

  // Default task size — one shared width/height applied to newly created
  // tasks regardless of subtype (User Task, Service Task, ...). Falls back
  // to bpmn-js's own built-in default (100×80) when unset.
  const taskDefaultSize = dictionaries.taskDefaultSize || BPMN_DEFAULT_TASK_SIZE;
  const isCustomTaskSize = !!dictionaries.taskDefaultSize;

  return `<div style="background:#fff;border-radius:10px;padding:20px;min-width:380px;max-width:480px;box-shadow:0 8px 32px rgba(0,0,0,0.18);">
    <div style="font-size:14px;font-weight:500;margin-bottom:2px;">Settings — Dictionaries</div>

    <div style="font-size:11px;color:#888;text-transform:uppercase;letter-spacing:0.05em;margin:14px 0 6px;">Systems</div>
    <div id="dict-systems-list">${systemRows}</div>
    <button onclick="addDictSystem()" style="font-size:12px;padding:5px 12px;margin-top:8px;">+ Add system</button>

    <div style="font-size:11px;color:#888;text-transform:uppercase;letter-spacing:0.05em;margin:18px 0 6px;">Locations</div>
    <div id="dict-locations-list">${locationRows}</div>
    <button onclick="addDictLocation()" style="font-size:12px;padding:5px 12px;margin-top:8px;">+ Add location</button>

    <div style="font-size:11px;color:#888;text-transform:uppercase;letter-spacing:0.05em;margin:18px 0 6px;">Default task size</div>
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

    <div style="display:flex;justify-content:flex-end;margin-top:16px;">
      <button onclick="document.getElementById('settings-dialog').remove()"
        style="font-size:13px;padding:5px 14px;background:#1a6bb5;color:#fff;border-color:#1558a0;">Close</button>
    </div>
  </div>`;
}

function refreshSettingsDialogList() {
  const list = document.getElementById('dict-systems-list');
  if (!list) return;
  // Re-render just the list markup (via the full template minus the outer box)
  const dialog = document.getElementById('settings-dialog');
  if (dialog) dialog.innerHTML = renderSettingsDialogHtml();
}

function addDictSystem() {
  if (!dictionaries.systems) dictionaries.systems = [];
  dictionaries.systems.push({
    id: 'sys_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    name: '',
    color: '#cce5ff'
  });
  onDictionariesChanged();
  refreshSettingsDialogList();
}

function updateDictSystemField(idx, field, value) {
  if (!dictionaries.systems || !dictionaries.systems[idx]) return;
  dictionaries.systems[idx][field] = value;
  onDictionariesChanged();
}

function removeDictSystem(idx) {
  if (!dictionaries.systems) return;
  dictionaries.systems.splice(idx, 1);
  onDictionariesChanged();
  refreshSettingsDialogList();
}

function addDictLocation() {
  if (!dictionaries.locations) dictionaries.locations = [];
  dictionaries.locations.push({
    id: 'loc_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    name: '',
    color: '#e2d9f3'
  });
  onDictionariesChanged();
  refreshSettingsDialogList();
}

function updateDictLocationField(idx, field, value) {
  if (!dictionaries.locations || !dictionaries.locations[idx]) return;
  dictionaries.locations[idx][field] = value;
  onDictionariesChanged();
}

function removeDictLocation(idx) {
  if (!dictionaries.locations) return;
  dictionaries.locations.splice(idx, 1);
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

function setElementSystem(elementId, systemId) {
  const er = modeler.get('elementRegistry');
  const el = er.get(elementId);
  if (!el) return;
  setElementMeta(el.businessObject, 'system', systemId);
  flushMetaToModel();
  refreshDetailOverlays();
}

function setElementLocation(elementId, locationId) {
  const er = modeler.get('elementRegistry');
  const el = er.get(elementId);
  if (!el) return;
  setElementMeta(el.businessObject, 'location', locationId);
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

function updatePropsPanel(selection) {
  const panel = document.getElementById('props-panel');
  if (!selection || selection.length !== 1) {
    panel.style.display = 'none';
    panel.innerHTML = '';
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
  const NO_COLOR_TYPES = ['bpmn:SequenceFlow', 'bpmn:MessageFlow', 'bpmn:Association',
    'bpmn:DataInputAssociation', 'bpmn:DataOutputAssociation', 'bpmn:Lane', 'bpmn:Participant'];
  const supportsColor = !!type && !NO_COLOR_TYPES.includes(type);
  if (supportsColor) {
    html += buildColorPicker(id);
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

  // Description and Details fields — for all elements with an id
  if (id && type && !['bpmn:SequenceFlow','bpmn:MessageFlow','bpmn:Association',
      'bpmn:DataInputAssociation','bpmn:DataOutputAssociation'].includes(type)) {
    const descVal = getElementMeta(bo, 'description');
    const detailsVal = getElementMeta(bo, 'details');
    const detailsUrl = detailsVal.trim();

    const currentSystemId = getElementMeta(bo, 'system');
    const systemOptions = (dictionaries.systems || []).map(s =>
      `<option value="${escHtml(s.id)}" ${s.id === currentSystemId ? 'selected' : ''}>${escHtml(s.name || '(unnamed)')}</option>`
    ).join('');
    html += `<div class="prop-row" style="margin-top:10px;">
      <div class="prop-name">System</div>
      <select class="prop-input" id="prop-system-${safeId}" onchange="setElementSystem('${safeId}', this.value)">
        <option value="">— none —</option>
        ${systemOptions}
      </select>
    </div>`;

    const currentLocationId = getElementMeta(bo, 'location');
    const locationOptions = (dictionaries.locations || []).map(l =>
      `<option value="${escHtml(l.id)}" ${l.id === currentLocationId ? 'selected' : ''}>${escHtml(l.name || '(unnamed)')}</option>`
    ).join('');
    html += `<div class="prop-row">
      <div class="prop-name">Location</div>
      <select class="prop-input" id="prop-location-${safeId}" onchange="setElementLocation('${safeId}', this.value)">
        <option value="">— none —</option>
        ${locationOptions}
      </select>
    </div>`;

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
  const modeling = modeler.get('modeling');
  const er = modeler.get('elementRegistry');
  const el = er.get(elementId);
  if (!el) return;
  modeling.updateProperties(el, { $type: undefined });
  // bpmn-js doesn't allow changing $type via updateProperties
  // Use replaceShape to turn the element into a callActivity
  const bpmnFactory = modeler.get('bpmnFactory');
  const replace = modeler.get('bpmnReplace');
  replace.replaceElement(el, { type: 'bpmn:CallActivity' });
  setStatus('Converted to Call Activity', 'ok');
  setTimeout(() => openCallActivitySelector(elementId), 200);
}

function convertCallActivityToTask(elementId) {
  const er = modeler.get('elementRegistry');
  const el = er.get(elementId);
  if (!el) return;
  const replace = modeler.get('bpmnReplace');
  replace.replaceElement(el, { type: 'bpmn:Task' });
  setStatus('Call Activity link removed', 'ok');
  updateTree();
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
  if (e.key === 'Escape' && navStack.length > 0) navigateUp();
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
