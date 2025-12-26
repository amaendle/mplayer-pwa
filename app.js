// ===== PWA install (service worker) =====
if ("serviceWorker" in navigator) {
  window.addEventListener("load", async () => {
    try {
      await navigator.serviceWorker.register("./sw.js");
    } catch (e) {
      console.warn("SW register failed:", e);
    }
  });
}

// ===== Minimal IndexedDB helper (stores directory handles too) =====
const DB_NAME = "mp3pwa";
const STORE = "kv";

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbSet(key, value) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function idbGet(key) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).get(key);
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror = () => reject(req.error);
  });
}

// ===== UI refs =====
const statusEl = document.getElementById("status");
const gridEl = document.getElementById("grid");
const nowTitleEl = document.getElementById("nowTitle");
const nowSubEl = document.getElementById("nowSub");

const drawerEl = document.getElementById("drawer");
const libInfoEl = document.getElementById("libInfo");

document.getElementById("btnLibrary").onclick = toggleDrawer;
document.getElementById("btnToggleLibrary").onclick = toggleDrawer;
document.getElementById("btnCloseDrawer").onclick = closeDrawer;
drawerEl.addEventListener("click", (e) => { if (e.target === drawerEl) closeDrawer(); });

document.getElementById("btnConnect").onclick = connectFolder;
document.getElementById("btnReconnect").onclick = reconnectFolder;

document.getElementById("btnPrev").onclick = prev;
document.getElementById("btnPlay").onclick = playPause;
document.getElementById("btnNext").onclick = next;

// ===== Playback (placeholder queue) =====
let queue = [
  { title: "Demo Track 1", artist: "Demo Artist", album: "Demo Album A" },
  { title: "Demo Track 2", artist: "Demo Artist", album: "Demo Album A" },
  { title: "Demo Track 3", artist: "Another Artist", album: "Demo Album B" },
];
let index = 0;
let isPlaying = false;

// ===== Folder handle state =====
let dirHandle = null;

// ===== Album tiles (placeholder) =====
const demoAlbums = [
  { id: "a", title: "Demo Album A", artist: "Demo Artist" },
  { id: "b", title: "Demo Album B", artist: "Another Artist" },
  { id: "c", title: "Demo Album C", artist: "Various" },
];

function renderAlbums(albums) {
  gridEl.innerHTML = "";
  for (const a of albums) {
    const tile = document.createElement("div");
    tile.className = "tile";
    tile.innerHTML = `
      <div class="cover">Cover</div>
      <div class="meta">
        <p class="album">${escapeHtml(a.title)}</p>
        <p class="artist">${escapeHtml(a.artist)}</p>
      </div>
    `;
    tile.onclick = () => {
      // For now: jump queue to first track of that album if it exists
      const found = queue.findIndex(t => t.album === a.title);
      index = found >= 0 ? found : 0;
      setNowPlaying();
      isPlaying = true;
      updatePlayState();
    };
    gridEl.appendChild(tile);
  }
}

function escapeHtml(s) {
  return (s ?? "").replace(/[&<>"']/g, c => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"
  })[c]);
}

// ===== Drawer =====
function toggleDrawer() {
  drawerEl.classList.toggle("open");
  drawerEl.setAttribute("aria-hidden", drawerEl.classList.contains("open") ? "false" : "true");
}
function closeDrawer() {
  drawerEl.classList.remove("open");
  drawerEl.setAttribute("aria-hidden", "true");
}

// ===== Playback UI =====
function setNowPlaying() {
  const t = queue[index];
  nowTitleEl.textContent = t ? t.title : "Nothing playing";
  nowSubEl.textContent = t ? `${t.artist} • ${t.album}` : "Select an album tile";
}
function updatePlayState() {
  // In the next step we’ll connect this to a real <audio> element.
  statusEl.textContent = `${dirHandle ? "Folder connected." : "Not connected."} ${isPlaying ? "▶ Playing" : "⏸ Paused"} — ${queue[index]?.title ?? ""}`;
}
function playPause() {
  isPlaying = !isPlaying;
  setNowPlaying();
  updatePlayState();
}
function prev() {
  index = (index - 1 + queue.length) % queue.length;
  setNowPlaying();
  updatePlayState();
}
function next() {
  index = (index + 1) % queue.length;
  setNowPlaying();
  updatePlayState();
}

// ===== Folder connect / persist across reloads =====
async function connectFolder() {
  if (!window.showDirectoryPicker) {
    statusEl.textContent = "This browser doesn’t support folder picking (File System Access API). Try Chrome/Edge/Chromium.";
    return;
  }
  try {
    dirHandle = await window.showDirectoryPicker();
    await idbSet("musicDir", dirHandle);
    await idbSet("musicDirConnectedAt", Date.now());
    statusEl.textContent = "Folder connected. (Next: scanning MP3s…)";
    libInfoEl.textContent = "Folder connected (handle saved).";
  } catch (e) {
    statusEl.textContent = "Folder connect canceled or failed.";
    console.warn(e);
  }
}

async function reconnectFolder() {
  const saved = await idbGet("musicDir");
  if (!saved) {
    statusEl.textContent = "No saved folder yet. Click “Connect Folder”.";
    return;
  }
  try {
    let perm = await saved.queryPermission({ mode: "read" });
    if (perm !== "granted") perm = await saved.requestPermission({ mode: "read" });
    if (perm === "granted") {
      dirHandle = saved;
      statusEl.textContent = "Reconnected to saved folder.";
      libInfoEl.textContent = "Reconnected (permission granted).";
    } else {
      statusEl.textContent = "Permission not granted. You may need to reconnect via “Connect Folder”.";
      libInfoEl.textContent = "Saved folder exists, but permission not granted.";
    }
  } catch (e) {
    statusEl.textContent = "Could not reconnect. You may need to re-pick the folder.";
    console.warn(e);
  }
}

// ===== Boot =====
(async function init() {
  renderAlbums(demoAlbums);
  setNowPlaying();
  updatePlayState();

  // Auto-try reconnect on startup
  const saved = await idbGet("musicDir");
  if (saved) {
    libInfoEl.textContent = "Saved folder found. Trying to reconnect…";
    await reconnectFolder();
  }
})();
