// ===== PWA install (service worker) =====
if ("serviceWorker" in navigator) {
  window.addEventListener("load", async () => {
    try { await navigator.serviceWorker.register("./sw.js"); }
    catch (e) { console.warn("SW register failed:", e); }
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

const nowViewEl = document.getElementById("nowView");
const bigCoverEl = document.getElementById("bigCover");
const bigTitleEl = document.getElementById("bigTitle");
const bigSubEl = document.getElementById("bigSub");
const nowAlbumPreviewEl = document.getElementById("nowAlbumPreview");

document.getElementById("btnBigPrev").onclick = prev;
document.getElementById("btnBigPlay").onclick = playPause;
document.getElementById("btnBigNext").onclick = next;
nowAlbumPreviewEl.onclick = () => goToAlbumsView();

// Open big now-playing when user taps the bottom bar text area
document.querySelector(".player .now").onclick = () => openNowView();

// Add open/close + UI update
function openNowView() {
  nowViewEl.classList.add("open");
  nowViewEl.setAttribute("aria-hidden", "false");
}
function closeNowView() {
  nowViewEl.classList.remove("open");
  nowViewEl.setAttribute("aria-hidden", "true");
}

function goToAlbumsView() {
  closeNowView();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function updateNowViewUI(track) {
  bigTitleEl.textContent = track ? (track.title || "Unknown title") : "Nothing playing";
  bigSubEl.textContent = track ? `${track.artist || "Unknown artist"} • ${track.album || "Unknown album"}` : "Pick an album";

  // cover: use album cover if we have it
  let coverUrl = null;
  if (track && currentAlbumId) {
    const alb = library.albumsById.get(currentAlbumId);
    coverUrl = alb?.coverUrl || null;
  }
  bigCoverEl.innerHTML = coverUrl
    ? `<img alt="" src="${coverUrl}">`
    : `Cover`;
}

// ===== Audio element (simple, reliable) =====
const audio = new Audio();
audio.preload = "metadata";
audio.addEventListener("ended", () => next(true));

audio.addEventListener("timeupdate", () => {
  // save at most every ~2s
  const t = audio.currentTime || 0;
  if (!audio._lastSavedAt || (t - audio._lastSavedAt) >= 2) {
    audio._lastSavedAt = t;
    savePlayerState().catch(()=>{});
  }
});
audio.addEventListener("pause", () => savePlayerState().catch(()=>{}));
audio.addEventListener("play", () => savePlayerState().catch(()=>{}));
window.addEventListener("beforeunload", () => { savePlayerState(); });

// ===== App state =====
let dirHandle = null;

let library = {
  albums: [],            // [{id,title,artist,coverUrl,tracks:[trackIds]}]
  tracksById: new Map(), // id -> {id, title, artist, album, trackNo, fileHandle}
  albumsById: new Map(),
};

let queue = [];        // array of trackIds
let queueIndex = 0;
let isPlaying = false;
let currentAlbumId = null;

const STATE_KEY = "playerState";

async function savePlayerState() {
  const currentTrackId = queue[queueIndex] ?? null;
  const state = {
    currentAlbumId,
    queue,
    queueIndex,
    currentTrackId,
    position: audio.currentTime || 0,
    wasPlaying: !audio.paused
  };
  await idbSet(STATE_KEY, state);
}

async function loadPlayerState() {
  return await idbGet(STATE_KEY);
}

// ===== Small helpers =====
function escapeHtml(s) {
  return (s ?? "").replace(/[&<>"']/g, c => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"
  })[c]);
}

function setStatus(msg) { statusEl.textContent = msg; }

function toggleDrawer() {
  drawerEl.classList.toggle("open");
  drawerEl.setAttribute("aria-hidden", drawerEl.classList.contains("open") ? "false" : "true");
}
function closeDrawer() {
  drawerEl.classList.remove("open");
  drawerEl.setAttribute("aria-hidden", "true");
}

// ===== Rendering =====
function renderAlbums(albums) {
  gridEl.innerHTML = "";

  if (!albums.length) {
    gridEl.innerHTML = `<div style="color:#a7a7a7;">No albums yet. Connect a folder with MP3 files.</div>`;
    renderNowAlbumPreview(albums);
    return;
  }

  for (const a of albums) {
    const tile = document.createElement("div");
    tile.className = "tile";

    // obvious tap to play overlay:
    const cover = a.coverUrl
      ? `<img alt="" src="${a.coverUrl}" style="width:100%;height:100%;object-fit:cover;display:block;">`
      : `<div class="cover">No cover</div>`;
    
    tile.innerHTML = `
      <div class="cover" style="padding:0; position:relative;">
        ${cover}
        <div class="playOverlay">
          <div class="playBtn">▶</div>
        </div>
      </div>
      <div class="meta">
        <p class="album">${escapeHtml(a.title)}</p>
        <p class="artist">${escapeHtml(a.artist)}</p>
      </div>
    `;
    // standard without overlay
    //const cover = a.coverUrl
    //  ? `<img alt="" src="${a.coverUrl}" style="width:100%;height:100%;object-fit:cover;display:block;">`
    //  : `<div class="cover">No cover</div>`;

    //tile.innerHTML = `
    //  <div class="cover" style="padding:0;">${cover}</div>
    //  <div class="meta">
    //    <p class="album">${escapeHtml(a.title)}</p>
    //    <p class="artist">${escapeHtml(a.artist)}</p>
    //  </div>
    //`;

    tile.onclick = async () => {
      currentAlbumId = a.id;
      buildQueueFromAlbum(a.id);
      queueIndex = 0;
      try {
        await playCurrent();
        openNowView();
      } catch (err) {
        console.warn(err);
        setStatus("Could not play this track. Try another one or reconnect folder.");
      }
    };

    gridEl.appendChild(tile);
  }

  renderNowAlbumPreview(albums);
}

function renderNowAlbumPreview(albums) {
  nowAlbumPreviewEl.innerHTML = "";

  if (!albums.length) {
    nowAlbumPreviewEl.textContent = "No albums yet";
    nowAlbumPreviewEl.style.color = "var(--mut)";
    return;
  }

  nowAlbumPreviewEl.style.color = "";

  for (const a of albums) {
    const thumb = document.createElement("div");
    thumb.className = "thumb";
    thumb.innerHTML = a.coverUrl
      ? `<img alt="" src="${a.coverUrl}">`
      : "♪";
    nowAlbumPreviewEl.appendChild(thumb);
  }
}

function setNowPlayingUI(track) {
  if (!track) {
    nowTitleEl.textContent = "Nothing playing";
    nowSubEl.textContent = "Pick an album tile";
    return;
  }
  nowTitleEl.textContent = track.title || "Unknown title";
  nowSubEl.textContent = `${track.artist || "Unknown artist"} • ${track.album || "Unknown album"}`;

  updateNowViewUI(track);
}

// ===== Folder connect / persist across reloads =====
async function connectFolder() {
  if (!window.showDirectoryPicker) {
    setStatus("This browser doesn’t support folder picking. Use Chrome/Edge/Chromium.");
    return;
  }
  try {
    dirHandle = await window.showDirectoryPicker();
    await idbSet("musicDir", dirHandle);
    await idbSet("musicDirConnectedAt", Date.now());
    libInfoEl.textContent = "Folder connected (saved). Scanning…";
    setStatus("Folder connected. Scanning music…");
    await scanAndBuildLibrary(dirHandle);
  } catch (e) {
    console.warn(e);
    setStatus("Folder connect canceled or failed.");
  }
}

async function reconnectFolder() {
  const saved = await idbGet("musicDir");
  if (!saved) {
    setStatus("No saved folder yet. Click “Connect Folder”.");
    return;
  }
  try {
    let perm = await saved.queryPermission({ mode: "read" });
    if (perm !== "granted") perm = await saved.requestPermission({ mode: "read" });

    if (perm === "granted") {
      dirHandle = saved;
      libInfoEl.textContent = "Reconnected. Scanning…";
      setStatus("Reconnected to saved folder. Scanning music…");
      await scanAndBuildLibrary(dirHandle);
    } else {
      libInfoEl.textContent = "Saved folder exists, but permission not granted.";
      setStatus("Permission not granted. Tap “Connect Folder” to pick it again.");
    }
  } catch (e) {
    console.warn(e);
    setStatus("Could not reconnect. Tap “Connect Folder” to pick the folder again.");
  }
}

// ===== Directory scanning (recursive) =====
async function* walkDirectory(dir, path = "") {
  for await (const entry of dir.values()) {
    const entryPath = path ? `${path}/${entry.name}` : entry.name;
    if (entry.kind === "file") yield { fileHandle: entry, path: entryPath };
    else if (entry.kind === "directory") yield* walkDirectory(entry, entryPath);
  }
}

function isMp3Name(name) {
  return /\.mp3$/i.test(name);
}

// ===== Read ID3 tags using jsmediatags =====
function readTagsFromFile(file) {
  return new Promise((resolve) => {
    if (!window.jsmediatags) {
      resolve({ ok: false, reason: "jsmediatags not loaded" });
      return;
    }
    window.jsmediatags.read(file, {
      onSuccess: (res) => resolve({ ok: true, tags: res.tags }),
      onError: (err) => resolve({ ok: false, reason: err?.info || "tag read error" }),
    });
  });
}

function coverUrlFromTags(tags) {
  // jsmediatags: tags.picture = { format, data: [byte...] }
  const pic = tags?.picture;
  if (!pic?.data?.length) return null;

  const bytes = new Uint8Array(pic.data);
  const blob = new Blob([bytes], { type: pic.format || "image/jpeg" });
  return URL.createObjectURL(blob);
}

function normalizeText(s, fallback) {
  s = (s ?? "").toString().trim();
  return s.length ? s : fallback;
}

// ===== Build library =====
async function scanAndBuildLibrary(dir) {
  // Reset in-memory library (simple MVP). Later we’ll persist metadata + covers.
  library = {
    albums: [],
    tracksById: new Map(),
    albumsById: new Map(),
  };

  // Release old cover URLs to avoid memory leaks
  // (only safe because we rebuild from scratch)
  // NOTE: if you later persist covers, don’t revoke.
  // We don’t store the old list here in MVP, so nothing to revoke.

  const albumKeyToAlbumId = new Map();

  let mp3Count = 0;
  let readCount = 0;

  // First pass: count MP3s quickly for nicer progress
  for await (const item of walkDirectory(dir)) {
    if (isMp3Name(item.path)) mp3Count++;
  }
  if (mp3Count === 0) {
    setStatus("No MP3 files found in this folder (or subfolders).");
    libInfoEl.textContent = "Connected, but no MP3s found.";
    renderAlbums([]);
    return;
  }

  setStatus(`Found ${mp3Count} MP3 files. Reading tags…`);

  // Second pass: read tags + build albums
  for await (const item of walkDirectory(dir)) {
    if (!isMp3Name(item.path)) continue;

    readCount++;
    if (readCount % 5 === 0 || readCount === mp3Count) {
      setStatus(`Reading music… ${readCount}/${mp3Count}`);
    }

    let file;
    try {
      file = await item.fileHandle.getFile();
    } catch (e) {
      console.warn("Could not open file:", item.path, e);
      continue;
    }

    const tagRes = await readTagsFromFile(file);
    const tags = tagRes.ok ? tagRes.tags : {};

    const album = normalizeText(tags?.album, "Unknown album");
    const artist = normalizeText(tags?.artist, "Unknown artist");
    const title = normalizeText(tags?.title, file.name.replace(/\.mp3$/i, ""));
    const trackNoRaw = tags?.track; // can be "3/12" or number
    const trackNo = parseInt((trackNoRaw ?? "").toString().split("/")[0], 10);
    const safeTrackNo = Number.isFinite(trackNo) ? trackNo : 0;

    const albumKey = `${artist}|||${album}`;
    let albumId = albumKeyToAlbumId.get(albumKey);

    if (!albumId) {
      //albumId = crypto.randomUUID();
      // Deterministic album ID so saved state matches after reloads
      albumId = `album:${albumKey}`;
      albumKeyToAlbumId.set(albumKey, albumId);

      const coverUrl = coverUrlFromTags(tags); // might be null
      const albumObj = {
        id: albumId,
        title: album,
        artist,
        coverUrl,
        tracks: [],
      };
      library.albumsById.set(albumId, albumObj);
    } else {
      // If album exists but has no cover yet, try to set it from this track
      const a = library.albumsById.get(albumId);
      if (a && !a.coverUrl) {
        const cu = coverUrlFromTags(tags);
        if (cu) a.coverUrl = cu;
      }
    }

    //const trackId = crypto.randomUUID();
    // Deterministic track ID so saved state matches after reloads
    const trackId = `track:${item.path}`;
    const trackObj = {
      id: trackId,
      title,
      artist,
      album,
      trackNo: safeTrackNo,
      fileHandle: item.fileHandle,
    };

    library.tracksById.set(trackId, trackObj);
    library.albumsById.get(albumId).tracks.push(trackId);
  }

  // Finalize albums list and sort
  library.albums = Array.from(library.albumsById.values())
    .map(a => {
      // sort tracks by trackNo then title for usability
      a.tracks.sort((id1, id2) => {
        const t1 = library.tracksById.get(id1);
        const t2 = library.tracksById.get(id2);
        const d = (t1?.trackNo ?? 0) - (t2?.trackNo ?? 0);
        if (d !== 0) return d;
        return (t1?.title ?? "").localeCompare(t2?.title ?? "");
      });
      return a;
    })
    .sort((a, b) => (a.artist + " " + a.title).localeCompare(b.artist + " " + b.title));

  renderAlbums(library.albums);
  libInfoEl.textContent = `Connected. ${library.albums.length} albums found. Tap an album cover to play.`;
  setStatus(`Ready: ${library.albums.length} albums. Tap an album cover to start.`);

  const savedState = await loadPlayerState();
  if (savedState?.queue?.length) {
    queue = savedState.queue.filter(id => library.tracksById.has(id));
    queueIndex = Math.min(savedState.queueIndex ?? 0, Math.max(0, queue.length - 1));
    currentAlbumId = savedState.currentAlbumId ?? null;
  
    // Update UI to show last track even before playing
    const tid = queue[queueIndex];
    if (tid) {
      const tr = library.tracksById.get(tid);
      setNowPlayingUI(tr);
      updateNowViewUI(tr); // (we’ll add this function below)
    }
  
    // Optional: auto-resume (you said “yes”)
    // We will try to resume; if browser blocks autoplay, user can press Play.
    try {
      await playCurrent();
      audio.currentTime = Math.max(0, savedState.position || 0);
      if (!savedState.wasPlaying) audio.pause();
    } catch {
      // Autoplay blocked or file access prompt; user can press play
    }
  }
}

// ===== Queue + playback =====
function buildQueueFromAlbum(albumId) {
  const album = library.albumsById.get(albumId);
  if (!album) return;
  queue = [...album.tracks];
}

async function playTrackById(trackId) {
  const track = library.tracksById.get(trackId);
  if (!track) return;

  // Recreate a fresh object URL each time (safe across reloads)
  const file = await track.fileHandle.getFile();
  const url = URL.createObjectURL(file);

  // Clean up previous URL to avoid memory leaks
  if (audio.src && audio.src.startsWith("blob:")) {
    try { URL.revokeObjectURL(audio.src); } catch {}
  }

  audio.src = url;
  await audio.play();
  isPlaying = true;

  setNowPlayingUI(track);
  setStatus(`▶ Playing: ${track.title}`);
}

async function playCurrent() {
  if (!queue.length) {
    setStatus("No tracks in queue. Tap an album cover.");
    return;
  }
  const trackId = queue[queueIndex];
  await playTrackById(trackId);
}

function playPause() {
  if (!queue.length) {
    setStatus("Tap an album cover to start playing.");
    return;
  }
  if (audio.paused) {
    audio.play().then(() => {
      isPlaying = true;
      setStatus("▶ Playing");
    }).catch(e => {
      console.warn(e);
      setStatus("Could not start playback (permission/gesture needed). Tap Play again.");
    });
  } else {
    audio.pause();
    isPlaying = false;
    setStatus("⏸ Paused");
  }
}

function prev() {
  if (!queue.length) return;
  queueIndex = (queueIndex - 1 + queue.length) % queue.length;
  playCurrent().catch(e => console.warn(e));
}

function next(fromEnded = false) {
  if (!queue.length) return;
  queueIndex = (queueIndex + 1) % queue.length;
  playCurrent().catch(e => {
    console.warn(e);
    if (!fromEnded) setStatus("Could not play next track.");
  });
}

// ===== Boot =====
(async function init() {
  renderAlbums([]); // empty until connected/scanned
  setNowPlayingUI(null);

  // Auto-try reconnect on startup
  const saved = await idbGet("musicDir");
  if (saved) {
    libInfoEl.textContent = "Saved folder found. Reconnecting…";
    await reconnectFolder();
  } else {
    libInfoEl.textContent = "No folder connected yet. Tap “Connect Folder”.";
    setStatus("Not connected. Tap “Connect Folder”.");
  }
})();
