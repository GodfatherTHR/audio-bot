const els = {
  workspacePath: document.getElementById("workspacePath"),
  fileCount: document.getElementById("fileCount"),
  refreshTree: document.getElementById("refreshTree"),
  fileTree: document.getElementById("fileTree"),
  treeNote: document.getElementById("treeNote"),
  fileName: document.getElementById("fileName"),
  fileMeta: document.getElementById("fileMeta"),
  reloadFile: document.getElementById("reloadFile"),
  saveFile: document.getElementById("saveFile"),
  fileEditor: document.getElementById("fileEditor"),
  editorEmpty: document.getElementById("editorEmpty"),
  fileNotice: document.getElementById("fileNotice"),
  noticeMark: document.getElementById("noticeMark"),
  noticeTitle: document.getElementById("noticeTitle"),
  noticeText: document.getElementById("noticeText"),
  downloadFile: document.getElementById("downloadFile"),
  saveState: document.getElementById("saveState"),
  cursorPosition: document.getElementById("cursorPosition"),
  toast: document.getElementById("toast")
};

const state = {
  current: null,
  closedDirs: new Set(),
  toastTimer: null,
  loading: false
};

function showToast(message, isError = false) {
  clearTimeout(state.toastTimer);
  els.toast.textContent = message;
  els.toast.className = `toast${isError ? " error" : ""}`;
  els.toast.hidden = false;
  state.toastTimer = setTimeout(() => {
    els.toast.hidden = true;
  }, 4200);
}

async function api(url, options) {
  const response = await fetch(url, { cache: "no-store", ...options });
  let data = {};
  try {
    data = await response.json();
  } catch {
    data = {};
  }
  if (!response.ok) {
    throw new Error(data.error || `Request failed (${response.status}).`);
  }
  return data;
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}`;
}

function formatTime(milliseconds) {
  if (!Number.isFinite(milliseconds)) return "";
  return new Date(milliseconds).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  });
}

function treeIcon(type) {
  const icon = document.createElement("span");
  icon.className = `tree-icon ${type === "dir" ? "folder" : type === "symlink" ? "symlink" : "file"}`;
  return icon;
}

function renderEntries(entries, container) {
  for (const entry of entries) {
    if (entry.type === "dir") {
      const details = document.createElement("details");
      details.className = "tree-dir";
      details.dataset.path = entry.path;
      details.open = !state.closedDirs.has(entry.path);
      details.addEventListener("toggle", () => {
        if (details.open) state.closedDirs.delete(entry.path);
        else state.closedDirs.add(entry.path);
      });

      const summary = document.createElement("summary");
      summary.className = "tree-row";
      summary.title = entry.path;

      const chevron = document.createElement("span");
      chevron.className = "tree-chevron";
      chevron.textContent = "›";

      const name = document.createElement("span");
      name.className = "tree-name";
      name.textContent = entry.name;

      const meta = document.createElement("span");
      meta.className = "tree-meta";
      meta.textContent = entry.children ? String(entry.children.length) : "…";

      summary.append(chevron, treeIcon("dir"), name, meta);

      const children = document.createElement("div");
      children.className = "tree-children";
      renderEntries(entry.children || [], children);

      details.append(summary, children);
      container.append(details);
      continue;
    }

    const button = document.createElement("button");
    button.type = "button";
    button.className = "tree-row file-row";
    button.dataset.path = entry.path;
    button.dataset.type = entry.type;
    button.title = entry.path;

    const name = document.createElement("span");
    name.className = "tree-name";
    name.textContent = entry.name;

    const meta = document.createElement("span");
    meta.className = "tree-meta";
    meta.textContent = entry.type === "symlink" ? "link" : formatBytes(entry.size);

    button.append(treeIcon(entry.type), name, meta);
    button.addEventListener("click", () => selectEntry(entry));
    container.append(button);
  }
}

function updateSelectedRow() {
  const currentPath = state.current?.path;
  for (const row of els.fileTree.querySelectorAll(".tree-row.file-row")) {
    row.classList.toggle("selected", row.dataset.path === currentPath);
  }
}

async function loadTree() {
  const scrollTop = els.fileTree.scrollTop;
  try {
    const data = await api("/api/workspace/tree");
    els.workspacePath.textContent = data.root;
    els.workspacePath.title = data.root;
    els.fileCount.textContent = `${data.count} item${data.count === 1 ? "" : "s"}`;

    els.fileTree.textContent = "";
    if (!data.entries.length) {
      const empty = document.createElement("div");
      empty.className = "tree-empty";
      empty.textContent = "This workspace is empty. Ask pi to create something.";
      els.fileTree.append(empty);
    } else {
      renderEntries(data.entries, els.fileTree);
    }

    if (data.truncated) {
      els.treeNote.hidden = false;
      els.treeNote.textContent = `Showing the first ${data.maxEntries} items. The tree is truncated.`;
    } else {
      els.treeNote.hidden = true;
    }

    updateSelectedRow();
    els.fileTree.scrollTop = scrollTop;
  } catch (error) {
    els.fileTree.textContent = "";
    const empty = document.createElement("div");
    empty.className = "tree-empty";
    empty.textContent = `Could not load the workspace: ${error.message}`;
    els.fileTree.append(empty);
    showToast(error.message, true);
  }
}

function isDirty() {
  return Boolean(
    state.current?.editable && els.fileEditor.value !== state.current.original
  );
}

function setSaveState(text, kind) {
  els.saveState.textContent = text;
  els.saveState.className = `save-state${kind ? ` ${kind}` : ""}`;
}

function updateFileMeta() {
  const current = state.current;
  if (!current) return;
  const parts = [current.path, formatBytes(current.size)];
  if (current.mtimeMs) parts.push(`modified ${formatTime(current.mtimeMs)}`);
  els.fileMeta.textContent = parts.join(" · ");
}

function updateEditorState() {
  const current = state.current;
  if (!current) {
    els.fileName.textContent = "Select a file";
    els.fileMeta.textContent = "Choose a file from the tree to view or edit it.";
    els.saveFile.disabled = true;
    els.reloadFile.disabled = true;
    els.fileEditor.hidden = true;
    els.fileEditor.disabled = true;
    els.editorEmpty.hidden = false;
    els.fileNotice.hidden = true;
    els.downloadFile.hidden = true;
    setSaveState("Ready", "");
    els.cursorPosition.textContent = "Ln 1, Col 1";
    return;
  }

  updateFileMeta();

  if (!current.editable) {
    els.saveFile.disabled = true;
    els.reloadFile.disabled = true;
    setSaveState("Read-only", "");
    return;
  }

  const dirty = isDirty();
  els.saveFile.disabled = !dirty || state.loading;
  els.reloadFile.disabled = state.loading;
  setSaveState(dirty ? "Unsaved changes" : "No unsaved changes", dirty ? "dirty" : "saved");
}

function updateCursor() {
  if (!state.current?.editable) {
    els.cursorPosition.textContent = "Ln 1, Col 1";
    return;
  }
  const before = els.fileEditor.value.slice(0, els.fileEditor.selectionStart);
  const lines = before.split("\n");
  const line = lines.length;
  const column = lines[lines.length - 1].length + 1;
  els.cursorPosition.textContent = `Ln ${line}, Col ${column}`;
}

function updateUrl(filePath) {
  const url = new URL(location.href);
  if (filePath) url.searchParams.set("path", filePath);
  else url.searchParams.delete("path");
  history.replaceState(null, "", url);
}

function showNotice(title, text, options = {}) {
  els.fileEditor.hidden = true;
  els.editorEmpty.hidden = true;
  els.fileNotice.hidden = false;
  els.noticeMark.textContent = options.error ? "!" : "i";
  els.noticeMark.className = `file-notice-mark${options.error ? " error" : ""}`;
  els.noticeTitle.textContent = title;
  els.noticeText.textContent = text;
  els.saveFile.disabled = true;
  els.reloadFile.disabled = true;

  if (options.downloadPath) {
    els.downloadFile.hidden = false;
    els.downloadFile.href = `/api/workspace/download?path=${encodeURIComponent(options.downloadPath)}`;
    els.downloadFile.download = options.downloadName || "";
  } else {
    els.downloadFile.hidden = true;
  }
}

async function loadFile(filePath) {
  state.loading = true;
  updateEditorState();
  setSaveState("Loading…", "");

  try {
    const data = await api(`/api/workspace/file?path=${encodeURIComponent(filePath)}`);
    state.current = {
      path: data.path,
      name: data.name,
      original: typeof data.content === "string" ? data.content : "",
      editable: !data.binary && !data.tooLarge,
      size: data.size,
      mtimeMs: data.mtimeMs
    };

    els.fileName.textContent = data.name;
    updateUrl(data.path);
    updateSelectedRow();

    if (data.binary || data.tooLarge) {
      const title = data.binary ? "Binary file" : "File too large to edit";
      const reason = data.binary
        ? "This file contains binary data and cannot be edited as text."
        : "This file is larger than the 1 MB editor limit.";
      showNotice(title, `${data.name} · ${formatBytes(data.size)}. ${reason}`, {
        downloadPath: data.path,
        downloadName: data.name
      });
      updateFileMeta();
      setSaveState("Read-only", "");
      els.cursorPosition.textContent = "Ln 1, Col 1";
      state.loading = false;
      return;
    }

    els.fileEditor.hidden = false;
    els.fileEditor.disabled = false;
    els.fileEditor.value = data.content;
    els.fileEditor.setSelectionRange(0, 0);
    els.editorEmpty.hidden = true;
    els.fileNotice.hidden = true;
    els.downloadFile.hidden = true;
    updateFileMeta();
    state.loading = false;
    updateEditorState();
    updateCursor();
    els.fileEditor.focus();
  } catch (error) {
    state.loading = false;
    updateEditorState();
    showToast(error.message, true);
    if (!state.current) {
      setSaveState("Could not open file", "error");
      showNotice("Could not open file", error.message, { error: true });
    }
  }
}

function selectEntry(entry) {
  if (entry.type === "symlink") {
    showToast("Symlinks are not followed.", true);
    return;
  }
  if (entry.type !== "file") {
    showToast("Only regular files can be opened.", true);
    return;
  }
  if (state.current?.path === entry.path) {
    els.fileEditor.focus();
    return;
  }
  if (isDirty() && !confirm(`Discard unsaved changes in ${state.current.name}?`)) {
    return;
  }
  loadFile(entry.path);
}

async function saveFile() {
  const current = state.current;
  if (!current?.editable || state.loading || !isDirty()) return;

  const content = els.fileEditor.value;
  if (new TextEncoder().encode(content).length > 1024 * 1024) {
    showToast("File content is larger than the 1 MB editor limit.", true);
    return;
  }

  state.loading = true;
  els.saveFile.disabled = true;
  setSaveState("Saving…", "");

  try {
    const data = await api("/api/workspace/file", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: current.path, content })
    });
    current.original = content;
    current.size = data.size;
    current.mtimeMs = data.mtimeMs;
    state.loading = false;
    updateEditorState();
    updateTreeRowMeta(current.path, data.size);
    setSaveState("Saved", "saved");
    showToast(`Saved ${current.name}.`);
  } catch (error) {
    state.loading = false;
    updateEditorState();
    setSaveState("Save failed", "error");
    showToast(error.message, true);
  }
}

function updateTreeRowMeta(path, size) {
  for (const row of els.fileTree.querySelectorAll(".tree-row.file-row")) {
    if (row.dataset.path !== path) continue;
    const meta = row.querySelector(".tree-meta");
    if (meta) meta.textContent = formatBytes(size);
    return;
  }
}

function reloadFile() {
  if (!state.current) return;
  if (isDirty() && !confirm(`Discard unsaved changes in ${state.current.name}?`)) {
    return;
  }
  loadFile(state.current.path);
}

els.fileEditor.addEventListener("input", () => {
  updateEditorState();
  updateCursor();
});
els.fileEditor.addEventListener("keyup", updateCursor);
els.fileEditor.addEventListener("click", updateCursor);
els.fileEditor.addEventListener("select", updateCursor);

els.fileEditor.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
    event.preventDefault();
    saveFile();
    return;
  }
  if (event.key !== "Tab" || !state.current?.editable) return;
  event.preventDefault();
  const start = els.fileEditor.selectionStart;
  const end = els.fileEditor.selectionEnd;
  els.fileEditor.setRangeText("  ", start, end, "end");
  updateEditorState();
  updateCursor();
});

els.saveFile.addEventListener("click", saveFile);
els.reloadFile.addEventListener("click", reloadFile);
els.refreshTree.addEventListener("click", loadTree);

window.addEventListener("beforeunload", (event) => {
  if (!isDirty()) return;
  event.preventDefault();
  event.returnValue = "";
});

updateEditorState();
loadTree();

const initialPath = new URLSearchParams(location.search).get("path");
if (initialPath) loadFile(initialPath);
