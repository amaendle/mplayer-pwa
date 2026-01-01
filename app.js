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
const easyPlayerEl = document.getElementById("easyPlayer");
const easyTitleEl = document.getElementById("easyBigTitle");
const easySubEl = document.getElementById("easyBigSub");
const playerEl = document.querySelector(".player");

const drawerEl = document.getElementById("drawer");
const libInfoEl = document.getElementById("libInfo");
const rebuildModeDescEl = document.getElementById("rebuildModeDesc");
const rebuildModeButton = document.getElementById("btnToggleRebuildMode");
const storageModeDescEl = document.getElementById("storageModeDesc");
const storageModeButton = document.getElementById("btnToggleStorageMode");

document.getElementById("btnLibrary").onclick = toggleDrawer;
document.getElementById("btnCloseDrawer").onclick = closeDrawer;
drawerEl.addEventListener("click", (e) => { if (e.target === drawerEl) closeDrawer(); });

document.getElementById("btnConnect").onclick = connectFolder;
document.getElementById("btnReconnect").onclick = reconnectFolder;
document.getElementById("btnClearLibrary").onclick = clearLibrary;
document.getElementById("btnToggleStorageMode").onclick = toggleStorageMode;
document.getElementById("btnToggleRebuildMode").onclick = toggleRebuildMode;
document.getElementById("btnToggleEasyAccess").onclick = toggleEasyAccessMode;

document.getElementById("btnPrev").onclick = prev;
document.getElementById("btnPlay").onclick = playPause;
document.getElementById("btnNext").onclick = next;
document.getElementById("btnStop").onclick = stopAndReturnToAlbums;
document.getElementById("btnEasyPrev").onclick = prev;
document.getElementById("btnEasyPlay").onclick = playPause;
document.getElementById("btnEasyNext").onclick = next;
document.getElementById("btnEasyStop").onclick = stopAndReturnToAlbums;

const nowViewEl = document.getElementById("nowView");
const bigCoverEl = document.getElementById("bigCover");
const nowAlbumPreviewEl = document.getElementById("nowAlbumPreview");
const tracklistEl = document.getElementById("tracklist");
const nowAlbumTitleEl = document.getElementById("nowAlbumTitle");
const nowAlbumSubEl = document.getElementById("nowAlbumSub");

let coverSlideInterval = null;
let coverSlideIndex = 0;
let coverSlidePaused = false;
let coverSlideUrls = [];
let updateCoverSlideActive = () => {};
let coverSlideSwipeStart = null;
let currentTrackRequestId = 0;
let hasActiveTrack = false;
let spectrogramCanvas = null;
let spectrogramCtx = null;
let spectrogramFrequencyData = null;
let spectrogramBinLookup = [];
let spectrogramAnimationFrame = null;
let spectrogramLastDraw = 0;
let spectrogramVisible = false;
let audioCtx = null;
let analyserNode = null;
let mediaElementSource = null;

const FILE_READ_TIMEOUT_MS = 4000;

const COVER_SWIPE_THRESHOLD_PX = 28;
const SPECTROGRAM_TIME_STEP_MS = 25;
const SPECTROGRAM_FFT_SIZE = 4096;

nowAlbumPreviewEl.onclick = () => goToAlbumsView();

// Open big now-playing when user taps the bottom bar text area
document.querySelector(".player .now").onclick = () => openNowViewForCurrentPlayback();
easyPlayerEl?.addEventListener("click", (e) => {
  if (e.target.closest(".bigControls")) return;
  openNowViewForCurrentPlayback();
});

// Add open/close + UI update
function openNowView() {
  nowViewEl.classList.add("open");
  nowViewEl.setAttribute("aria-hidden", "false");
}
function openNowViewForCurrentPlayback() {
  if (queue.length) {
    const activeTrackId = queue[queueIndex] ?? null;
    const activeTrack = activeTrackId ? library.tracksById.get(activeTrackId) : null;

    if (activeQueueAlbumId) {
      currentAlbumId = activeQueueAlbumId;
    } else if (activeTrack?.albumId) {
      currentAlbumId = activeTrack.albumId;
      activeQueueAlbumId = activeTrack.albumId;
    }

    updateNowViewUI(activeTrack);
  }

  openNowView();
}
function closeNowView() {
  nowViewEl.classList.remove("open");
  nowViewEl.setAttribute("aria-hidden", "true");
}

function goToAlbumsView() {
  closeNowView();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function clearCoverSlideshow() {
  if (coverSlideInterval) {
    clearInterval(coverSlideInterval);
    coverSlideInterval = null;
  }
}

function pauseCoverSlideshow(shouldPause) {
  coverSlidePaused = shouldPause;
}

function setCoverContent(html) {
  let coverLayer = bigCoverEl.querySelector(".coverLayer");
  if (!coverLayer) {
    bigCoverEl.innerHTML = "";
    coverLayer = document.createElement("div");
    coverLayer.className = "coverLayer";
    bigCoverEl.appendChild(coverLayer);
  }
  coverLayer.innerHTML = html;
  ensureSpectrogramCanvas();
}

function renderCoverSlideshow(urls) {
  clearCoverSlideshow();
  coverSlidePaused = false;
  coverSlideUrls = Array.isArray(urls) ? [...urls] : [];

  if (!coverSlideUrls.length) {
    coverSlideUrls = [];
    setCoverContent("Cover");
    return;
  }

  coverSlideIndex = 0;
  setCoverContent(`
    <div class="coverSlider">
      ${coverSlideUrls.map((u, idx) => `<img alt="" src="${u}" class="${idx === 0 ? "active" : ""}">`).join("")}
    </div>
  `);

  updateCoverSlideActive = () => {
    const imgs = bigCoverEl.querySelectorAll(".coverSlider img");
    imgs.forEach((img, idx) => img.classList.toggle("active", idx === coverSlideIndex));
  };

  if (coverSlideUrls.length <= 1) return;

  coverSlideInterval = setInterval(() => {
    if (coverSlidePaused) return;
    coverSlideIndex = (coverSlideIndex + 1) % coverSlideUrls.length;
    updateCoverSlideActive();
  }, 3200);
}

bigCoverEl.addEventListener("mouseenter", () => pauseCoverSlideshow(true));
bigCoverEl.addEventListener("mouseleave", () => pauseCoverSlideshow(false));
bigCoverEl.addEventListener("touchstart", () => pauseCoverSlideshow(true));
bigCoverEl.addEventListener("touchend", () => pauseCoverSlideshow(false));
bigCoverEl.addEventListener("touchcancel", () => pauseCoverSlideshow(false));

function changeCoverSlide(step) {
  if (!coverSlideUrls.length) return;
  if (coverSlideUrls.length === 1) return;
  coverSlideIndex = (coverSlideIndex + step + coverSlideUrls.length) % coverSlideUrls.length;
  updateCoverSlideActive();
}

bigCoverEl.addEventListener("pointerdown", (e) => {
  if (coverSlideUrls.length <= 1) return;
  coverSlideSwipeStart = { x: e.clientX, y: e.clientY };
  pauseCoverSlideshow(true);
});

bigCoverEl.addEventListener("pointermove", (e) => {
  if (!coverSlideSwipeStart || coverSlideUrls.length <= 1) return;

  const dx = e.clientX - coverSlideSwipeStart.x;
  const dy = e.clientY - coverSlideSwipeStart.y;

  if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > COVER_SWIPE_THRESHOLD_PX) {
    changeCoverSlide(dx > 0 ? -1 : 1);
    coverSlideSwipeStart = null;
  }
});

bigCoverEl.addEventListener("pointerup", () => {
  coverSlideSwipeStart = null;
  pauseCoverSlideshow(false);
});

bigCoverEl.addEventListener("pointercancel", () => {
  coverSlideSwipeStart = null;
  pauseCoverSlideshow(false);
});

bigCoverEl.addEventListener("pointerleave", () => {
  coverSlideSwipeStart = null;
  pauseCoverSlideshow(false);
});

function ensureSpectrogramCanvas() {
  if (!spectrogramCanvas) {
    spectrogramCanvas = document.createElement("canvas");
    spectrogramCanvas.className = "spectrogramCanvas";
    spectrogramCtx = spectrogramCanvas.getContext("2d");
  }
  if (!bigCoverEl.contains(spectrogramCanvas)) {
    bigCoverEl.appendChild(spectrogramCanvas);
  }
  resizeSpectrogramCanvas();
}

function resizeSpectrogramCanvas() {
  if (!spectrogramCanvas || !bigCoverEl.isConnected) return;
  const rect = bigCoverEl.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const width = Math.max(1, Math.floor(rect.width));
  const height = Math.max(1, Math.floor(rect.height));
  const desiredWidth = Math.max(1, Math.floor(width * dpr));
  const desiredHeight = Math.max(1, Math.floor(height * dpr));

  if (spectrogramCanvas.width === desiredWidth && spectrogramCanvas.height === desiredHeight) return;

  spectrogramCanvas.width = desiredWidth;
  spectrogramCanvas.height = desiredHeight;
  spectrogramCanvas.style.width = `${width}px`;
  spectrogramCanvas.style.height = `${height}px`;
  spectrogramCtx = spectrogramCanvas.getContext("2d");
  spectrogramCtx.imageSmoothingEnabled = false;
  rebuildSpectrogramBinLookup();
}

function rebuildSpectrogramBinLookup() {
  if (!spectrogramCanvas || !analyserNode) return;
  const height = Math.max(1, spectrogramCanvas.height);
  const sampleRate = audioCtx?.sampleRate || 48000;
  const minFreq = 20;
  const maxFreq = sampleRate / 2;
  const logMin = Math.log(minFreq);
  const logMax = Math.log(maxFreq);
  const binCount = analyserNode.frequencyBinCount;

  spectrogramBinLookup = new Uint16Array(height);

  for (let y = 0; y < height; y++) {
    const norm = 1 - (y / Math.max(1, height - 1));
    const freq = Math.exp(logMin + norm * (logMax - logMin));
    const bin = Math.min(binCount - 1, Math.round((freq / maxFreq) * (binCount - 1)));
    spectrogramBinLookup[y] = bin;
  }
}

async function ensureAudioAnalyser() {
  if (analyserNode) return true;
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) {
    setStatus("Spectrogram requires Web Audio (not supported in this browser).");
    return false;
  }
  try {
    audioCtx = new Ctx();
    mediaElementSource = audioCtx.createMediaElementSource(audio);
    analyserNode = audioCtx.createAnalyser();
    analyserNode.fftSize = SPECTROGRAM_FFT_SIZE;
    analyserNode.smoothingTimeConstant = 0;
    mediaElementSource.connect(analyserNode);
    analyserNode.connect(audioCtx.destination);
    spectrogramFrequencyData = new Uint8Array(analyserNode.frequencyBinCount);
    rebuildSpectrogramBinLookup();
    return true;
  } catch (err) {
    console.warn(err);
    setStatus("Could not start spectrogram.");
    return false;
  }
}

function drawSpectrogramFrame(ts) {
  if (!spectrogramVisible) return;
  if (!spectrogramCanvas || !spectrogramCtx || !analyserNode || !spectrogramFrequencyData) {
    spectrogramAnimationFrame = requestAnimationFrame(drawSpectrogramFrame);
    return;
  }

  const width = spectrogramCanvas.width;
  const height = Math.min(spectrogramCanvas.height, spectrogramBinLookup.length || spectrogramCanvas.height);
  if (width <= 1 || height <= 0) {
    spectrogramAnimationFrame = requestAnimationFrame(drawSpectrogramFrame);
    return;
  }

  const elapsed = spectrogramLastDraw ? (ts - spectrogramLastDraw) : SPECTROGRAM_TIME_STEP_MS;
  const shift = Math.max(1, Math.round(elapsed / SPECTROGRAM_TIME_STEP_MS));
  spectrogramLastDraw = ts;

  spectrogramCtx.drawImage(spectrogramCanvas, -shift, 0);
  spectrogramCtx.fillStyle = "#050505";
  spectrogramCtx.fillRect(width - shift, 0, shift, spectrogramCanvas.height);

  analyserNode.getByteFrequencyData(spectrogramFrequencyData);

  for (let y = 0; y < height; y++) {
    const binIndex = spectrogramBinLookup[y] ?? 0;
    const v = spectrogramFrequencyData[binIndex] ?? 0;
    const hue = 240 - (v / 255) * 240;
    const light = 18 + (v / 255) * 60;
    spectrogramCtx.fillStyle = `hsl(${hue}, 90%, ${light}%)`;
    spectrogramCtx.fillRect(width - shift, y, shift, 1);
  }

  spectrogramAnimationFrame = requestAnimationFrame(drawSpectrogramFrame);
}

async function startSpectrogram() {
  ensureSpectrogramCanvas();
  const ok = await ensureAudioAnalyser();
  if (!ok) {
    spectrogramVisible = false;
    bigCoverEl.classList.remove("spectrogram-active");
    return;
  }
  if (audioCtx?.state === "suspended") {
    try { await audioCtx.resume(); } catch (e) { console.warn(e); }
  }
  rebuildSpectrogramBinLookup();
  spectrogramLastDraw = 0;
  bigCoverEl.classList.add("spectrogram-active");
  if (spectrogramAnimationFrame) cancelAnimationFrame(spectrogramAnimationFrame);
  spectrogramAnimationFrame = requestAnimationFrame(drawSpectrogramFrame);
}

function stopSpectrogram() {
  bigCoverEl.classList.remove("spectrogram-active");
  if (spectrogramAnimationFrame) {
    cancelAnimationFrame(spectrogramAnimationFrame);
    spectrogramAnimationFrame = null;
  }
}

function toggleSpectrogramMode() {
  spectrogramVisible = !spectrogramVisible;
  if (spectrogramVisible) {
    startSpectrogram();
  } else {
    stopSpectrogram();
  }
}

function resumeAudioContextIfNeeded() {
  if (spectrogramVisible && audioCtx?.state === "suspended") {
    audioCtx.resume().catch(() => {});
  }
}

window.addEventListener("resize", resizeSpectrogramCanvas);
bigCoverEl.addEventListener("click", toggleSpectrogramMode);

function timeoutError(message) {
  const err = new Error(message);
  err.name = "TimeoutError";
  return err;
}

async function getFileWithTimeout(fileHandle, timeoutMs = FILE_READ_TIMEOUT_MS) {
  const filePromise = fileHandle.getFile();
  filePromise.catch(() => {});

  return Promise.race([
    filePromise,
    new Promise((_, reject) => {
      setTimeout(() => reject(timeoutError("Timed out waiting for file handle.")), timeoutMs);
    }),
  ]);
}

function updateNowViewUI(track) {
  const selectedAlbum = currentAlbumId ? getAlbumById(currentAlbumId) : null;
  const albumForCover = selectedAlbum || (track?.albumId ? getAlbumById(track.albumId) : null);

  updateAlbumInfoUI(selectedAlbum);

  if (albumForCover?.isPlayLater) {
    clearCoverSlideshow();
    coverSlideUrls = [];
    setCoverContent(buildPlayLaterCollageHtml());
  } else {
    const coverUrls = albumForCover?.coverUrls?.length
      ? albumForCover.coverUrls
      : (albumForCover?.coverUrl ? [albumForCover.coverUrl] : []);
    renderCoverSlideshow(coverUrls);
  }

  let activeTrackId = null;

  if (albumForCover?.isPlayLater) {
    activeTrackId = activeQueueAlbumId === PLAY_LATER_ID
      ? (queue[queueIndex] ?? track?.id ?? null)
      : null;
  } else if (track && albumForCover && track.albumId === albumForCover.id) {
    activeTrackId = track.id;
  }
  renderTracklist(activeTrackId);
}

function updateAlbumInfoUI(album) {
  if (!nowAlbumTitleEl || !nowAlbumSubEl) return;

  if (!album) {
    nowAlbumTitleEl.textContent = "No album selected";
    nowAlbumSubEl.textContent = "Open an album to see its details";
    return;
  }

  nowAlbumTitleEl.textContent = album.title || "Unknown album";

  const albumArtist = album.albumArtist || album.artist || "Unknown artist";
  const parts = [];
  if (albumArtist) parts.push(albumArtist);
  if (album.year) parts.push(album.year);
  nowAlbumSubEl.textContent = parts.length ? parts.join(" • ") : "Album details unavailable";
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
audio.addEventListener("play", () => {
  savePlayerState().catch(()=>{});
  resumeAudioContextIfNeeded();
});
window.addEventListener("beforeunload", () => { savePlayerState(); });

// ===== App state =====
let dirHandles = [];

const MUSIC_DIRS_KEY = "musicDirs";

let library = {
  albums: [],            // [{id,title,artist,coverUrl,tracks:[trackIds]}]
  tracksById: new Map(), // id -> {id, title, artist, album, trackNo, fileHandle}
  albumsById: new Map(),
};

const PLAY_LATER_ID = "playlist:play-later";
let playLaterTracks = [];

const PLAY_LATER_COLOR_PALETTE = [
  "#7B5CE6",
  "#F58F39",
  "#2EA69B",
  "#D74B74",
  "#4E80F0",
  "#C7BA3A",
  "#5ECCA6",
  "#D16FDB",
  "#4A556A",
];

let queue = [];        // array of trackIds
let queueIndex = 0;
let isPlaying = false;
let currentAlbumId = null;
let activeQueueAlbumId = null;

const STATE_KEY = "playerState";
const SETTINGS_KEY = "settings";
const LIBRARY_CACHE_KEY = "libraryCacheV1";
const IMPORT_MODE_DIRECT = "direct";
const IMPORT_MODE_OPFS = "opfs";
const OPFS_IMPORTED_PATHS_KEY = "opfsImportedPaths";
const OPFS_LIBRARY_DIR = "opfsMusic";

let fastRebuildEnabled = true;
let easyAccessEnabled = false;
let libraryImportMode = IMPORT_MODE_DIRECT;

let opfsRootHandle = null;

async function savePlayerState() {
  const currentTrackId = queue[queueIndex] ?? null;
  const state = {
    currentAlbumId: activeQueueAlbumId,
    queue,
    queueIndex,
    currentTrackId,
    position: audio.currentTime || 0,
    wasPlaying: !audio.paused,
    playLaterTracks: playLaterTracks.map(id => {
      const track = library.tracksById.get(id);
      const path = track?.path || trackIdToPath(id);
      return {
        id,
        title: track?.title ?? null,
        artist: track?.artist ?? null,
        album: track?.album ?? null,
        path: path ?? null,
      };
    }),
  };
  await idbSet(STATE_KEY, state);
}

async function loadPlayerState() {
  return await idbGet(STATE_KEY);
}

async function loadSettings() {
  const saved = await idbGet(SETTINGS_KEY);
  if (saved && typeof saved.fastRebuildEnabled === "boolean") {
    fastRebuildEnabled = saved.fastRebuildEnabled;
  }
  if (saved && typeof saved.easyAccessEnabled === "boolean") {
    easyAccessEnabled = saved.easyAccessEnabled;
  }
  if (saved && saved.libraryImportMode === IMPORT_MODE_OPFS && isOpfsSupported()) {
    libraryImportMode = IMPORT_MODE_OPFS;
  }
  updateRebuildModeUI();
  updateStorageModeUI();
  updateEasyAccessUI();
}

async function persistSettings() {
  await idbSet(SETTINGS_KEY, { fastRebuildEnabled, easyAccessEnabled, libraryImportMode });
}

async function loadLibraryCache() {
  const cache = await idbGet(LIBRARY_CACHE_KEY);
  if (!cache) return { tracks: [], coversByAlbumKey: {} };
  return {
    tracks: Array.isArray(cache.tracks) ? cache.tracks : [],
    coversByAlbumKey: cache.coversByAlbumKey || {},
  };
}

async function persistLibraryCache(cache) {
  await idbSet(LIBRARY_CACHE_KEY, cache);
}

async function loadOpfsImportedPaths() {
  const saved = await idbGet(OPFS_IMPORTED_PATHS_KEY);
  return Array.isArray(saved) ? saved : [];
}

async function persistOpfsImportedPaths(paths) {
  await idbSet(OPFS_IMPORTED_PATHS_KEY, Array.from(paths));
}

async function getOpfsRootDir() {
  if (!isOpfsSupported()) throw new Error("OPFS not supported in this browser");
  if (!opfsRootHandle) {
    opfsRootHandle = await navigator.storage.getDirectory();
  }
  return opfsRootHandle;
}

async function getOpfsLibraryDir() {
  const root = await getOpfsRootDir();
  return await root.getDirectoryHandle(OPFS_LIBRARY_DIR, { create: true });
}

async function opfsFileExists(dir, relativePath) {
  const parts = (relativePath || "").split("/").filter(Boolean);
  let current = dir;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    const isFile = i === parts.length - 1;
    try {
      if (isFile) {
        await current.getFileHandle(part);
      } else {
        current = await current.getDirectoryHandle(part);
      }
    } catch (err) {
      return false;
    }
  }
  return true;
}

async function ensureOpfsFileHandle(dir, relativePath) {
  const parts = (relativePath || "").split("/").filter(Boolean);
  let current = dir;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    const isFile = i === parts.length - 1;
    if (isFile) {
      current = await current.getFileHandle(part, { create: true });
    } else {
      current = await current.getDirectoryHandle(part, { create: true });
    }
  }
  return current;
}

async function clearOpfsLibraryData() {
  if (!isOpfsSupported()) return;
  try {
    const root = await getOpfsRootDir();
    await root.removeEntry(OPFS_LIBRARY_DIR, { recursive: true });
  } catch (err) {
    console.warn("Could not clear OPFS library", err);
  }
  await persistOpfsImportedPaths([]);
}

// ===== Small helpers =====
function escapeHtml(s) {
  return (s ?? "").replace(/[&<>"']/g, c => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"
  })[c]);
}

function setStatus(msg) { statusEl.textContent = msg; }

function updatePlayerVisibility(hasTrack) {
  hasActiveTrack = hasTrack;
  const hidden = !hasActiveTrack;
  document.body.classList.toggle("player-hidden", hidden);

  if (playerEl) {
    const playerHidden = hidden || easyAccessEnabled;
    playerEl.setAttribute("aria-hidden", playerHidden ? "true" : "false");
  }
  if (easyPlayerEl) {
    const easyHidden = hidden || !easyAccessEnabled;
    easyPlayerEl.setAttribute("aria-hidden", easyHidden ? "true" : "false");
  }
}

function updateRebuildModeUI() {
  if (!rebuildModeButton) return;
  rebuildModeButton.textContent = fastRebuildEnabled ? "Fast" : "Full check";
  rebuildModeDescEl.textContent = fastRebuildEnabled
    ? "Fast rebuild (default) uses cached tags and only scans new files."
    : "Full check re-reads every file, tags, and cover.";
}

function updateEasyAccessUI() {
  const toggleBtn = document.getElementById("btnToggleEasyAccess");
  if (toggleBtn) {
    toggleBtn.textContent = easyAccessEnabled ? "On" : "Off";
  }
  document.body.classList.toggle("easy-access", easyAccessEnabled);
  updatePlayerVisibility(hasActiveTrack);
}

function updateStorageModeUI() {
  if (!storageModeButton || !storageModeDescEl) return;
  const usingOpfs = libraryImportMode === IMPORT_MODE_OPFS;
  storageModeButton.textContent = usingOpfs ? "Import once" : "Keep links";
  storageModeDescEl.textContent = usingOpfs
    ? "Copy picked folders into app storage (OPFS)."
    : "Keep permanent access to picked folders.";
}

function isOpfsSupported() {
  return !!navigator?.storage?.getDirectory;
}

function toggleRebuildMode() {
  fastRebuildEnabled = !fastRebuildEnabled;
  updateRebuildModeUI();
  persistSettings().catch(() => {});
  setStatus(fastRebuildEnabled
    ? "Fast rebuild enabled (uses saved tags where possible)."
    : "Full rebuild enabled (re-reads all files).");
}

function toggleEasyAccessMode() {
  easyAccessEnabled = !easyAccessEnabled;
  updateEasyAccessUI();
  persistSettings().catch(() => {});
  setStatus(easyAccessEnabled
    ? "Easy access mode on. Tiles are larger with big controls."
    : "Easy access mode off.");
}

async function toggleStorageMode() {
  const switchingToOpfs = libraryImportMode !== IMPORT_MODE_OPFS;
  if (switchingToOpfs && !isOpfsSupported()) {
    setStatus("OPFS not supported in this browser. Stay on linked folders.");
    return;
  }

  if (switchingToOpfs) {
    const importedBefore = await loadOpfsImportedPaths();

    setStatus("Switching to import-once mode. Copying linked music into app storage…");

    let copiedCount = 0;
    let skippedCount = 0;
    let importedFromLinked = false;
    try {
      const result = await importLinkedLibraryToOpfs();
      copiedCount = result.copiedCount;
      skippedCount = result.skippedCount;
      importedFromLinked = result.imported;
    } catch (err) {
      console.warn("Could not copy linked folders into OPFS:", err);
    }

    libraryImportMode = IMPORT_MODE_OPFS;
    updateStorageModeUI();
    persistSettings().catch(() => {});

    const skippedMsg = skippedCount ? ` Skipped ${skippedCount} duplicate file(s).` : "";
    const importedMsg = importedFromLinked
      ? `Imported ${copiedCount} new file(s) into OPFS.${skippedMsg}`
      : "Switched to import-once mode. Add music to copy folders into app storage.";

    const hasOpfsData = importedBefore.length || importedFromLinked;
    if (hasOpfsData) {
      try {
        const libraryDir = await getOpfsLibraryDir();
        libInfoEl.textContent = "Using stored library in app storage. Rebuilding…";
        await scanAndBuildLibraryFromDirs([libraryDir]);
        setStatus(importedMsg);
      } catch (err) {
        console.warn(err);
        setStatus("Switched to import-once mode, but stored library is unavailable. Try importing again.");
      }
    } else {
      libInfoEl.textContent = "No imported music yet. Tap Add Music to import into app storage.";
      setStatus(importedMsg);
    }
    return;
  }

  libraryImportMode = IMPORT_MODE_DIRECT;
  updateStorageModeUI();
  persistSettings().catch(() => {});
  setStatus("Linked folder mode: keep permanent access to the picked folders.");
}

async function importLinkedLibraryToOpfs() {
  const saved = await loadSavedDirectories();
  if (!saved.length) return { copiedCount: 0, skippedCount: 0, imported: false };

  const granted = [];
  for (const handle of saved) {
    let perm = await handle.queryPermission({ mode: "read" });
    if (perm !== "granted") perm = await handle.requestPermission({ mode: "read" });
    if (perm === "granted") granted.push(handle);
  }

  if (!granted.length) return { copiedCount: 0, skippedCount: 0, imported: false };

  let copiedCount = 0;
  let skippedCount = 0;
  for (const handle of granted) {
    const { copiedCount: copied, skippedCount: skipped } = await importDirectoryOnce(handle);
    copiedCount += copied;
    skippedCount += skipped;
  }

  return { copiedCount, skippedCount, imported: true };
}

function trackIdToPath(trackId) {
  if (!trackId?.startsWith("track:")) return null;
  return trackId.slice("track:".length);
}

function normalizeTrackPath(path) {
  if (!path) return null;
  // Remove directory labels like "Music:" or legacy "dir0:" prefixes
  const withoutPrefix = path.toString().replace(/^[^/]+:/, "");
  return withoutPrefix;
}

function stripRootFolder(path) {
  const normalized = normalizeTrackPath(path);
  if (!normalized) return null;
  const parts = normalized.split("/").filter(Boolean);
  if (parts.length <= 1) return normalized;
  return parts.slice(1).join("/");
}

function pathVariants(path) {
  const variants = new Set();
  const normalized = normalizeTrackPath(path);
  if (normalized) variants.add(normalized);
  const noRoot = stripRootFolder(normalized);
  if (noRoot) variants.add(noRoot);
  return [...variants];
}

function buildDirectoryLabels(dirs) {
  const counts = new Map();
  return dirs.map((dir, idx) => {
    const base = (dir?.name || `dir${idx + 1}`).toString();
    const count = counts.get(base) || 0;
    counts.set(base, count + 1);
    return count ? `${base}#${count + 1}` : base;
  });
}

function metadataKeyForTrack({ title, artist, album }) {
  const t = (title ?? "").toString().trim().toLowerCase();
  const ar = (artist ?? "").toString().trim().toLowerCase();
  const al = (album ?? "").toString().trim().toLowerCase();
  if (!t && !ar && !al) return null;
  return `${t}|||${ar}|||${al}`;
}

function toggleDrawer() {
  drawerEl.classList.toggle("open");
  drawerEl.setAttribute("aria-hidden", drawerEl.classList.contains("open") ? "false" : "true");
}
function closeDrawer() {
  drawerEl.classList.remove("open");
  drawerEl.setAttribute("aria-hidden", "true");
}

async function loadSavedDirectories() {
  const list = await idbGet(MUSIC_DIRS_KEY);
  if (Array.isArray(list)) return list;

  // Legacy single-folder key
  const legacy = await idbGet("musicDir");
  return legacy ? [legacy] : [];
}

async function persistDirectories(handles) {
  await idbSet(MUSIC_DIRS_KEY, handles);
}

// ===== Rendering =====
function getAlbumCoverUrl(albumId) {
  const album = albumId ? library.albumsById.get(albumId) : null;
  if (!album) return null;
  if (Array.isArray(album.coverUrls) && album.coverUrls.length) return album.coverUrls[0];
  return album.coverUrl || null;
}

function buildPlayLaterCollageHtml() {
  const seenAlbumIds = new Set();
  const coverSources = [];

  for (const trackId of playLaterTracks) {
    const track = library.tracksById.get(trackId);
    const albumId = track?.albumId;
    if (!albumId || seenAlbumIds.has(albumId)) continue;
    seenAlbumIds.add(albumId);

    const coverUrl = getAlbumCoverUrl(albumId);
    coverSources.push(coverUrl || null);

    if (coverSources.length >= 9) break;
  }

  const cells = [];
  for (let i = 0; i < 9; i++) {
    const src = coverSources[i] || null;
    if (src) {
      cells.push(`<div class="collageCell img"><img alt="" src="${src}"></div>`);
    } else {
      const color = PLAY_LATER_COLOR_PALETTE[i % PLAY_LATER_COLOR_PALETTE.length];
      cells.push(`<div class="collageCell color" style="background:${color};"></div>`);
    }
  }

  return `<div class="playLaterCover"><div class="playLaterCollage">${cells.join("")}</div></div>`;
}

function getPlayLaterAlbum() {
  return {
    id: PLAY_LATER_ID,
    title: "Play later",
    artist: playLaterTracks.length ? `${playLaterTracks.length} track(s)` : "Add albums with Play later",
    coverUrl: "",
    tracks: [...playLaterTracks],
    isPlayLater: true,
  };
}

function albumsWithPlayLater(albums) {
  return [getPlayLaterAlbum(), ...albums];
}

function renderAlbums(albums) {
  gridEl.innerHTML = "";

  const allAlbums = albumsWithPlayLater(albums);

  for (const a of allAlbums) {
    const tile = document.createElement("div");
    const hasCover = !!a.coverUrl || a.isPlayLater;
    tile.className = "tile"
      + (a.isPlayLater ? " playLaterTile" : "")
      + (!a.isPlayLater && !hasCover ? " noCover" : "");

    // obvious tap to play overlay:
    const cover = a.isPlayLater
      ? buildPlayLaterCollageHtml()
      : (a.coverUrl
        ? `<img alt="" src="${a.coverUrl}" style="width:100%;height:100%;object-fit:cover;display:block;">`
        : "");

    const coverSection = cover
      ? `
        <div class="cover" style="padding:0; position:relative;">
          ${cover}
          <div class="playOverlay">
            <div class="playBtn">▶</div>
          </div>
        </div>
      `
      : "";

    tile.innerHTML = `
      ${coverSection}
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

      // If music is already playing, open the album view without altering the queue
      if (!audio.paused && queue.length) {
        const activeTrackId = queue[queueIndex] ?? null;
        const activeTrack = activeTrackId ? library.tracksById.get(activeTrackId) : null;
        updateNowViewUI(activeTrack);
        openNowView();
        return;
      }

      buildQueueFromAlbum(a.id);
      queueIndex = 0;

      if (!queue.length) {
        setStatus(a.isPlayLater ? "Your Play later list is empty." : "This album has no tracks to play.");
        return;
      }

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

  if (!albums.length) {
    const emptyMsg = document.createElement("div");
    emptyMsg.style.color = "#a7a7a7";
    emptyMsg.textContent = "No albums yet. Connect a folder with MP3 files.";
    gridEl.appendChild(emptyMsg);
  }

  renderNowAlbumPreview(allAlbums);
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
    thumb.innerHTML = a.isPlayLater
      ? buildPlayLaterCollageHtml()
      : (a.coverUrl
        ? `<img alt="" src="${a.coverUrl}">`
        : "♪");
    nowAlbumPreviewEl.appendChild(thumb);
  }
}

function rerenderPlayLaterTile() {
  const tile = gridEl.querySelector(".playLaterTile");
  if (!tile) return;

  const artistEl = tile.querySelector(".artist");
  if (artistEl) {
    artistEl.textContent = playLaterTracks.length
      ? `${playLaterTracks.length} track(s)`
      : "Add albums with Play later";
  }

  const coverEl = tile.querySelector(".cover");
  if (coverEl) {
    const existingOverlay = coverEl.querySelector(".playOverlay");
    if (existingOverlay) existingOverlay.remove();

    coverEl.innerHTML = `
      ${buildPlayLaterCollageHtml()}
      <div class="playOverlay">
        <div class="playBtn">▶</div>
      </div>
    `;
  }
}

function renderTracklist(activeTrackId) {
  tracklistEl.innerHTML = "";

  if (!currentAlbumId) {
    tracklistEl.textContent = "No album selected yet.";
    tracklistEl.style.color = "var(--mut)";
    return;
  }

  const album = getAlbumById(currentAlbumId);
  if (!album) {
    tracklistEl.textContent = "Album not found.";
    tracklistEl.style.color = "var(--mut)";
    return;
  }

  tracklistEl.style.color = "";

  const actions = document.createElement("div");
  actions.className = "albumActions";

  if (!album.isPlayLater) {
    const playLaterBtn = document.createElement("button");
    playLaterBtn.type = "button";
    playLaterBtn.textContent = "Play later";
    playLaterBtn.onclick = () => queueAlbumLater(album.id);
    actions.appendChild(playLaterBtn);
  }

  if (album.isPlayLater) {
    const clearBtn = document.createElement("button");
    clearBtn.type = "button";
    clearBtn.textContent = "Clear Play later";
    clearBtn.onclick = clearPlayLater;
    actions.appendChild(clearBtn);
  }

  tracklistEl.appendChild(actions);

  const rows = document.createElement("div");
  rows.className = "trackRows";
  tracklistEl.appendChild(rows);

  if (!album.tracks.length) {
    const empty = document.createElement("div");
    empty.textContent = album.isPlayLater ? "Play later is empty." : "No tracks in this album.";
    empty.style.color = "var(--mut)";
    rows.appendChild(empty);
    return;
  }

  album.tracks.forEach((trackId, idx) => {
    const track = library.tracksById.get(trackId);
    const row = document.createElement("div");
    row.className = "trackRow" + (trackId === activeTrackId ? " active" : "");
    row.setAttribute("role", "button");
    row.tabIndex = 0;

    const playTrack = () => {
      activeQueueAlbumId = album.id;
      queue = [...album.tracks];
      queueIndex = idx;
      playCurrent().catch(e => console.warn(e));
    };

    row.onclick = playTrack;
    row.onkeydown = (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        playTrack();
      }
    };

    const num = document.createElement("span");
    num.className = "num";
    const trackNumber = track?.trackNo || idx + 1;
    num.textContent = trackNumber.toString().padStart(2, "0");
    row.appendChild(num);

    const meta = document.createElement("div");
    meta.className = "meta";
    const titleEl = document.createElement("div");
    titleEl.className = "title";
    titleEl.textContent = track?.title || "Unknown title";
    const artistEl = document.createElement("div");
    artistEl.className = "artist";
    artistEl.textContent = track?.artist || "Unknown artist";
    meta.appendChild(titleEl);
    meta.appendChild(artistEl);
    row.appendChild(meta);

    const state = document.createElement("span");
    state.className = "state";
    state.textContent = trackId === activeTrackId ? "▶" : "";
    row.appendChild(state);

    const actions = document.createElement("div");
    actions.className = "actions";

    if (!album.isPlayLater) {
      const addBtn = document.createElement("button");
      addBtn.type = "button";
      addBtn.textContent = "Play later";
      addBtn.title = "Add this track to Play later";
      addBtn.onclick = (e) => {
        e.stopPropagation();
        queueTrackLater(trackId);
      };
      actions.appendChild(addBtn);
    } else {
      const removeBtn = document.createElement("button");
      removeBtn.type = "button";
      removeBtn.textContent = "Remove";
      removeBtn.title = "Remove from Play later";
      removeBtn.onclick = (e) => {
        e.stopPropagation();
        removeFromPlayLater(trackId);
      };
      actions.appendChild(removeBtn);
    }

    row.appendChild(actions);

    rows.appendChild(row);
  });
}

function setNowPlayingUI(track) {
  if (!track) {
    nowTitleEl.textContent = "Nothing playing";
    nowSubEl.textContent = "Pick an album tile";
    if (easyTitleEl) easyTitleEl.textContent = "Nothing playing";
    if (easySubEl) easySubEl.textContent = "Pick an album tile";
    spectrogramVisible = false;
    stopSpectrogram();
    updatePlayerVisibility(false);
    updateNowViewUI(null);
    return;
  }
  nowTitleEl.textContent = track.title || "Unknown title";
  nowSubEl.textContent = `${track.artist || "Unknown artist"} • ${track.album || "Unknown album"}`;
  if (easyTitleEl) easyTitleEl.textContent = track.title || "Unknown title";
  if (easySubEl) easySubEl.textContent = `${track.artist || "Unknown artist"} • ${track.album || "Unknown album"}`;

  updatePlayerVisibility(true);
  updateNowViewUI(track);
}

// ===== Folder connect / persist across reloads =====
async function importDirectoryOnce(handle) {
  if (!isOpfsSupported()) {
    throw new Error("OPFS not supported in this browser");
  }

  const libraryDir = await getOpfsLibraryDir();
  const importedPaths = new Set(await loadOpfsImportedPaths());
  let copiedCount = 0;
  let skippedCount = 0;

  for await (const item of walkDirectory(handle)) {
    if (!isMp3Name(item.path) && !isImageName(item.path)) continue;
    const destPath = `${handle.name}/${item.path}`;

    const alreadyImported = importedPaths.has(destPath)
      || await opfsFileExists(libraryDir, destPath);
    if (alreadyImported) {
      importedPaths.add(destPath);
      skippedCount++;
      continue;
    }

    const destFileHandle = await ensureOpfsFileHandle(libraryDir, destPath);
    const srcFile = await item.fileHandle.getFile();
    const writable = await destFileHandle.createWritable();
    await srcFile.stream().pipeTo(writable);
    importedPaths.add(destPath);
    copiedCount++;
  }

  await persistOpfsImportedPaths(importedPaths);
  return { copiedCount, skippedCount };
}

async function connectFolder() {
  if (!window.showDirectoryPicker) {
    setStatus("This browser doesn’t support folder picking. Use Chrome/Edge/Chromium.");
    return;
  }
  try {
    if (libraryImportMode === IMPORT_MODE_OPFS && !isOpfsSupported()) {
      setStatus("OPFS not supported in this browser. Switch storage mode to keep links.");
      return;
    }

    const handle = await window.showDirectoryPicker();
    if (libraryImportMode === IMPORT_MODE_OPFS) {
      setStatus("Importing music into app storage…");
      const { copiedCount, skippedCount } = await importDirectoryOnce(handle);
      const libraryDir = await getOpfsLibraryDir();
      dirHandles = [];
      libInfoEl.textContent = "Library stored in app storage. Rebuilding…";
      await scanAndBuildLibraryFromDirs([libraryDir]);
      const skippedMsg = skippedCount ? ` Skipped ${skippedCount} duplicate file(s).` : "";
      setStatus(`Imported ${copiedCount} new file(s) into OPFS.${skippedMsg}`);
    } else {
      const saved = await loadSavedDirectories();
      const granted = [];
      for (const h of saved) {
        let perm = await h.queryPermission({ mode: "read" });
        if (perm !== "granted") perm = await h.requestPermission({ mode: "read" });
        if (perm === "granted") granted.push(h);
      }

      dirHandles = [...granted, handle];
      await persistDirectories([...saved, handle]);
      await idbSet("musicDirConnectedAt", Date.now());
      libInfoEl.textContent = `Connected ${dirHandles.length} folder(s). Scanning…`;
      setStatus("Folder added. Scanning music…");
      await scanAndBuildLibraryFromDirs(dirHandles);
    }
  } catch (e) {
    console.warn(e);
    setStatus("Folder connect canceled or failed.");
  }
}

async function reconnectFolder() {
  if (libraryImportMode === IMPORT_MODE_OPFS) {
    const imported = await loadOpfsImportedPaths();
    if (!imported.length) {
      setStatus("No imported music yet. Tap “Add Music” to import into app storage.");
      libInfoEl.textContent = "No OPFS imports found. Tap Add Music.";
      return;
    }
    try {
      const libraryDir = await getOpfsLibraryDir();
      libInfoEl.textContent = "Using stored library in app storage. Rebuilding…";
      setStatus("Rebuilding library from imported files…");
      await scanAndBuildLibraryFromDirs([libraryDir]);
      setStatus("Rebuilt library from OPFS. Ready to play.");
    } catch (e) {
      console.warn(e);
      setStatus("Could not read OPFS library. Try importing again.");
    }
    return;
  }

  const saved = await loadSavedDirectories();
  if (!saved.length) {
    setStatus("No saved folders yet. Click “Add Music”.");
    return;
  }
  try {
    const granted = [];
    for (const handle of saved) {
      let perm = await handle.queryPermission({ mode: "read" });
      if (perm !== "granted") perm = await handle.requestPermission({ mode: "read" });
      if (perm === "granted") granted.push(handle);
    }

    if (granted.length) {
      dirHandles = granted;
      await persistDirectories(saved);
      libInfoEl.textContent = `Reconnected ${dirHandles.length} folder(s). Scanning…`;
      setStatus("Reconnected to saved folders. Scanning music…");
      await scanAndBuildLibraryFromDirs(dirHandles);
    } else {
      libInfoEl.textContent = "Saved folders exist, but permission not granted.";
      setStatus("Permission not granted. Tap “Add Music” to pick them again.");
    }
  } catch (e) {
    console.warn(e);
    setStatus("Could not reconnect. Tap “Add Music” to pick folders again.");
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

function isImageName(name) {
  return /\.(jpe?g|png|webp)$/i.test(name);
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

function coverDataUrlFromTags(tags) {
  const pic = tags?.picture;
  if (!pic?.data?.length) return null;
  const mime = pic.format || "image/jpeg";
  let binary = "";
  for (const b of pic.data) binary += String.fromCharCode(b);
  return `data:${mime};base64,${btoa(binary)}`;
}

function normalizeText(s, fallback) {
  s = (s ?? "").toString().trim();
  return s.length ? s : fallback;
}

function parseYear(value) {
  const yearNum = parseInt((value ?? "").toString().slice(0, 4), 10);
  return Number.isFinite(yearNum) && yearNum > 0 ? yearNum : null;
}

// ===== Build library =====
async function scanAndBuildLibraryFromDirs(dirs) {
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
  const cacheTracks = [];

  const { tracks: cachedTracks, coversByAlbumKey: cachedCovers } = fastRebuildEnabled
    ? await loadLibraryCache()
    : { tracks: [], coversByAlbumKey: {} };
  const cachedByPath = new Map(cachedTracks.map(t => [t.path, t]));
  const cachedByVariant = new Map();
  for (const track of cachedTracks) {
    for (const variant of pathVariants(track.path)) {
      if (!cachedByVariant.has(variant)) cachedByVariant.set(variant, track);
    }
  }
  const coversByAlbumKey = { ...cachedCovers };
  const canUseCache = fastRebuildEnabled && cachedByPath.size > 0;

  const albumImagesByFolder = new Map();

  const directoryLabels = buildDirectoryLabels(dirs);

  let mp3Count = 0;
  let readCount = 0;
  let processedCount = 0;
  const sourceLabel = libraryImportMode === IMPORT_MODE_OPFS
    ? "imported library"
    : `${dirs.length} folder(s)`;

  // First pass: count MP3s quickly for nicer progress across all folders
  for (const dir of dirs) {
    for await (const item of walkDirectory(dir)) {
      if (isMp3Name(item.path)) mp3Count++;
    }
  }

  if (mp3Count === 0) {
    setStatus(`No MP3 files found in ${sourceLabel}.`);
    libInfoEl.textContent = libraryImportMode === IMPORT_MODE_OPFS
      ? "Imported library is empty. Tap Add Music to import files."
      : "Connected, but no MP3s found.";
    renderAlbums([]);
    return;
  }

  if (canUseCache) {
    setStatus(`Fast rebuild: restoring saved tags for ${mp3Count} track(s). New files will be fully scanned.`);
  } else if (fastRebuildEnabled) {
    setStatus(`Fast rebuild was selected, but no saved tags exist yet. Reading tags (titles, artists, albums, covers) so the library can be rebuilt…`);
  } else {
    setStatus(`Found ${mp3Count} MP3 files across ${sourceLabel}. Reading tags (titles, artists, albums, covers) so the library can be rebuilt…`);
  }

  // Second pass: read tags + build albums
  for (const [dirIdx, dir] of dirs.entries()) {
    const pathPrefix = dirs.length > 1 ? `${directoryLabels[dirIdx]}:` : "";

    for await (const item of walkDirectory(dir)) {
      if (isImageName(item.path)) {
        const fullPath = `${pathPrefix}${item.path}`;
        const folderPath = fullPath.includes("/") ? fullPath.slice(0, fullPath.lastIndexOf("/")) : "";
        const list = albumImagesByFolder.get(folderPath) || [];
        list.push({ path: fullPath, fileHandle: item.fileHandle });
        albumImagesByFolder.set(folderPath, list);
        continue;
      }

      if (!isMp3Name(item.path)) continue;

      processedCount++;
      const fullPath = `${pathPrefix}${item.path}`;
      const cached = canUseCache ? (cachedByPath.get(fullPath)
        || pathVariants(fullPath).map(v => cachedByVariant.get(v)).find(Boolean)) : null;

      if (canUseCache && cached && (processedCount % 10 === 0 || processedCount === mp3Count)) {
        setStatus(`Fast rebuild: restored ${processedCount}/${mp3Count} from saved tags…`);
      }

      let title = null;
      const folderPath = fullPath.includes("/") ? fullPath.slice(0, fullPath.lastIndexOf("/")) : "";
      let artist = null;
      let albumArtist = null;
      let album = null;
      let safeTrackNo = 0;
      let year = null;
      let coverDataUrlForCache = null;
      let coverUrlForAlbum = null;

      if (cached) {
        title = normalizeText(cached.title, item.fileHandle.name || item.path.replace(/\.mp3$/i, ""));
        artist = normalizeText(cached.artist, "Unknown artist");
        albumArtist = normalizeText(cached.albumArtist, "");
        album = normalizeText(cached.album, "Unknown album");
        const cachedTrackNo = parseInt((cached.trackNo ?? 0).toString(), 10);
        safeTrackNo = Number.isFinite(cachedTrackNo) ? cachedTrackNo : 0;
        year = parseYear(cached.year);
      } else {
        readCount++;
        if (readCount % 5 === 0 || readCount === mp3Count) {
          setStatus(`Opening music files to extract metadata and covers… ${readCount}/${mp3Count}`);
        } else if (canUseCache && processedCount % 10 === 0) {
          setStatus(`Fast rebuild: restored ${processedCount}/${mp3Count} (scanning new files)…`);
        }

        let file;
        try {
          file = await getFileWithTimeout(item.fileHandle);
        } catch (e) {
          console.warn("Could not open file:", item.path, e);
          if (e.name === "TimeoutError") setStatus("A file is temporarily unavailable (network timeout). Skipping…");
          continue;
        }

        const tagRes = await readTagsFromFile(file);
        const tags = tagRes.ok ? tagRes.tags : {};

        album = normalizeText(tags?.album, "Unknown album");
        artist = normalizeText(tags?.artist, "Unknown artist");
        albumArtist = normalizeText(tags?.albumartist ?? tags?.albumArtist, "");
        title = normalizeText(tags?.title, file.name.replace(/\.mp3$/i, ""));
        const trackNoRaw = tags?.track; // can be "3/12" or number
        const trackNo = parseInt((trackNoRaw ?? "").toString().split("/")[0], 10);
        safeTrackNo = Number.isFinite(trackNo) ? trackNo : 0;
        year = parseYear(tags?.year);
        coverDataUrlForCache = coverDataUrlFromTags(tags);
        coverUrlForAlbum = coverDataUrlForCache || coverUrlFromTags(tags);
      }

      const albumArtistKey = albumArtist || "";
      const albumArtistDisplay = albumArtist || artist || "Unknown artist";
      const albumKey = `${albumArtistKey}|||${album}`;
      if (!coverDataUrlForCache && coversByAlbumKey[albumKey]) {
        coverDataUrlForCache = coversByAlbumKey[albumKey];
      }
      if (!coverUrlForAlbum && coverDataUrlForCache) coverUrlForAlbum = coverDataUrlForCache;
      let albumId = albumKeyToAlbumId.get(albumKey);

      if (!albumId) {
        albumId = `album:${albumKey}`;
        albumKeyToAlbumId.set(albumKey, albumId);

        const albumObj = {
          id: albumId,
          title: album,
          artist: albumArtistDisplay,
          albumArtist: albumArtistDisplay,
          albumArtistTag: albumArtist || "",
          coverUrl: coverUrlForAlbum || null,
          coverUrls: coverUrlForAlbum ? [coverUrlForAlbum] : [],
          folderPaths: [],
          tracks: [],
          year: year || null,
        };
        library.albumsById.set(albumId, albumObj);
      } else {
        const a = library.albumsById.get(albumId);
        if (a && !a.coverUrl && coverUrlForAlbum) a.coverUrl = coverUrlForAlbum;
        if (a && coverUrlForAlbum && Array.isArray(a.coverUrls) && !a.coverUrls.includes(coverUrlForAlbum)) {
          a.coverUrls.push(coverUrlForAlbum);
        }
        if (a && !a.albumArtistTag && albumArtist) a.albumArtistTag = albumArtist;
        if (a && !a.albumArtist && albumArtistDisplay) a.albumArtist = albumArtistDisplay;
        const parsedYear = year || null;
        if (a && parsedYear && (!a.year || parsedYear < a.year)) a.year = parsedYear;
      }

      const albumObj = library.albumsById.get(albumId);
      if (albumObj) {
        if (!Array.isArray(albumObj.folderPaths)) albumObj.folderPaths = [];
        if (!albumObj.folderPaths.includes(folderPath)) albumObj.folderPaths.push(folderPath);
      }

      const trackId = `track:${fullPath}`;
      const trackObj = {
        id: trackId,
        path: fullPath,
        folderPath,
        title,
        artist,
        albumArtist,
        album,
        albumId,
        trackNo: safeTrackNo,
        year: year || null,
        fileHandle: item.fileHandle,
      };

      library.tracksById.set(trackId, trackObj);
      library.albumsById.get(albumId).tracks.push(trackId);

      cacheTracks.push({ path: trackObj.path, title, artist, albumArtist, album, trackNo: safeTrackNo, year: year || null });
      if (coverDataUrlForCache && !coversByAlbumKey[albumKey]) coversByAlbumKey[albumKey] = coverDataUrlForCache;
    }
  }

  // Attach additional covers from album folders
  for (const album of library.albumsById.values()) {
    if (!Array.isArray(album.coverUrls)) album.coverUrls = album.coverUrl ? [album.coverUrl] : [];
    const seen = new Set(album.coverUrls);
    const folders = Array.isArray(album.folderPaths) ? album.folderPaths : [];

    for (const folderPath of folders) {
      const images = albumImagesByFolder.get(folderPath) || [];
      for (const image of images) {
        try {
          const file = await getFileWithTimeout(image.fileHandle);
          const url = URL.createObjectURL(file);
          if (!seen.has(url)) {
            seen.add(url);
            album.coverUrls.push(url);
          }
        } catch (err) {
          console.warn("Could not read cover image:", image.path, err);
          if (err.name === "TimeoutError") setStatus("Skipping a cover image because the network is slow…");
        }
      }
    }

    if (!album.coverUrl && album.coverUrls.length) album.coverUrl = album.coverUrls[0];
  }

  // Derive an informative album artist when no album artist tag exists
  for (const album of library.albumsById.values()) {
    if (album.albumArtistTag) continue;

    const artists = [];
    for (const trackId of album.tracks || []) {
      const trackArtist = normalizeText(library.tracksById.get(trackId)?.artist ?? "", "");
      if (trackArtist) artists.push(trackArtist);
    }

    const uniqueArtists = [...new Set(artists)];
    const displayArtist = uniqueArtists.length > 1
      ? "Various artists"
      : (uniqueArtists[0] || album.artist || "Unknown artist");

    album.artist = displayArtist;
    album.albumArtist = displayArtist;
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

  await persistLibraryCache({ tracks: cacheTracks, coversByAlbumKey });

  renderAlbums(library.albums);
  libInfoEl.textContent = libraryImportMode === IMPORT_MODE_OPFS
    ? `Using imported library. ${library.albums.length} albums found. Tap an album cover to play.`
    : `Connected to ${dirs.length} folder(s). ${library.albums.length} albums found. Tap an album cover to play.`;
  setStatus(`Ready: ${library.albums.length} albums across ${sourceLabel}. Tap an album cover to start.`);

  const savedState = await loadPlayerState();
  if (savedState?.queue?.length) {
    queue = savedState.queue.filter(id => library.tracksById.has(id));
    queueIndex = Math.min(savedState.queueIndex ?? 0, Math.max(0, queue.length - 1));
    currentAlbumId = savedState.currentAlbumId ?? null;
    activeQueueAlbumId = savedState.currentAlbumId ?? null;
  
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

  await reconcilePlayLaterAfterLibraryReload(savedState);
}

// ===== Queue + playback =====
function buildQueueFromAlbum(albumId) {
  const album = getAlbumById(albumId);
  if (!album) return;
  activeQueueAlbumId = album.id;
  queue = [...album.tracks];
}

function dedupePlayLaterTracks() {
  const seen = new Set();
  const dedupedList = [];
  let removedCount = 0;

  for (const id of playLaterTracks) {
    if (seen.has(id)) {
      removedCount++;
      continue;
    }
    seen.add(id);
    dedupedList.push(id);
  }

  playLaterTracks = dedupedList;
  return { existingSet: seen, removedCount };
}

function normalizeSavedPlayLaterEntry(entry) {
  if (typeof entry === "string") return { id: entry };
  if (entry && typeof entry === "object") {
    const { id = null, title = null, artist = null, album = null, path = null } = entry;
    return { id, title, artist, album, path };
  }
  return { id: null };
}

function remapPlayLaterEntries(savedEntries) {
  const restored = [];
  const used = new Set();
  let missingCount = 0;

  const tracksByFullPath = new Map();
  const tracksByNormalizedPath = new Map();
  const tracksByVariantPath = new Map();
  const tracksByMetadata = new Map();

  for (const track of library.tracksById.values()) {
    const fullPath = track.path || trackIdToPath(track.id);
    if (fullPath) {
      tracksByFullPath.set(fullPath, track.id);
      const norm = normalizeTrackPath(fullPath);
      if (norm) tracksByNormalizedPath.set(norm, track.id);
      for (const variant of pathVariants(fullPath)) {
        if (!tracksByVariantPath.has(variant)) tracksByVariantPath.set(variant, track.id);
      }
    }

    const metaKey = metadataKeyForTrack(track);
    if (metaKey) tracksByMetadata.set(metaKey, track.id);
  }

  for (const rawEntry of savedEntries || []) {
    const entry = normalizeSavedPlayLaterEntry(rawEntry);
    const candidates = [];

    if (entry.id && library.tracksById.has(entry.id)) candidates.push(entry.id);

    const savedPath = entry.path || trackIdToPath(entry.id);
    const normSavedPath = normalizeTrackPath(savedPath);
    if (savedPath && tracksByFullPath.has(savedPath)) candidates.push(tracksByFullPath.get(savedPath));
    if (normSavedPath && tracksByNormalizedPath.has(normSavedPath)) candidates.push(tracksByNormalizedPath.get(normSavedPath));
    for (const variant of pathVariants(savedPath)) {
      const mapped = tracksByVariantPath.get(variant);
      if (mapped) candidates.push(mapped);
    }

    const metaKey = metadataKeyForTrack(entry);
    if (metaKey && tracksByMetadata.has(metaKey)) candidates.push(tracksByMetadata.get(metaKey));

    const match = candidates.find(id => !used.has(id));
    if (match) {
      restored.push(match);
      used.add(match);
    } else {
      missingCount++;
    }
  }

  return { restored, missingCount };
}

async function reconcilePlayLaterAfterLibraryReload(savedState) {
  const savedEntries = Array.isArray(savedState?.playLaterTracks) ? savedState.playLaterTracks : [];
  const { restored, missingCount } = remapPlayLaterEntries(savedEntries);

  playLaterTracks = restored;
  renderAlbums(library.albums);
  rerenderPlayLaterTile();

  if (missingCount) {
    setStatus(`Restored Play later list, but ${missingCount} item(s) could not be matched and were removed.`);
  }

  await savePlayerState();
}

function getAlbumById(albumId) {
  if (albumId === PLAY_LATER_ID) return getPlayLaterAlbum();
  return library.albumsById.get(albumId);
}

function playAlbumNow(albumId) {
  const album = getAlbumById(albumId);
  if (!album || !album.tracks.length) {
    setStatus("This album has no tracks to play.");
    return;
  }

  currentAlbumId = album.id;
  buildQueueFromAlbum(album.id);
  queueIndex = 0;
  playCurrent().then(() => openNowView()).catch(err => {
    console.warn(err);
    setStatus("Could not play this album. Try another one or reconnect folder.");
  });
}

function queueAlbumLater(albumId) {
  const album = getAlbumById(albumId);
  if (!album || !album.tracks.length) {
    setStatus("This album has no tracks to add.");
    return;
  }

  const { existingSet: existing, removedCount } = dedupePlayLaterTracks();

  const newTracks = [];
  for (const id of album.tracks) {
    if (existing.has(id)) continue;
    newTracks.push(id);
    existing.add(id);
  }

  if (!newTracks.length) {
    const duplicateNotice = removedCount
      ? ` Removed ${removedCount} duplicate(s) already in Play later.`
      : "";
    setStatus(`All tracks already in Play later.${duplicateNotice}`.trim());
    rerenderPlayLaterTile();
    savePlayerState().catch(() => {});
    return;
  }

  playLaterTracks = [...playLaterTracks, ...newTracks];

  const duplicateNotice = removedCount
    ? ` Removed ${removedCount} duplicate(s) already in Play later.`
    : "";
  setStatus(`Added ${newTracks.length} track(s) to Play later.${duplicateNotice}`);
  rerenderPlayLaterTile();
  renderAlbums(library.albums);
  if (currentAlbumId === PLAY_LATER_ID) {
    const activeTrackId = queue[queueIndex] ?? null;
    renderTracklist(activeTrackId);
  }
  savePlayerState().catch(() => {});
}

function queueTrackLater(trackId) {
  if (!trackId || !library.tracksById.has(trackId)) {
    setStatus("Track not found.");
    return;
  }

  const { existingSet, removedCount } = dedupePlayLaterTracks();

  if (existingSet.has(trackId)) {
    const parts = [];
    if (removedCount) parts.push(`Removed ${removedCount} duplicate(s) already in Play later.`);
    parts.push("Track already in Play later; keeping existing spot.");
    setStatus(parts.join(" "));
    rerenderPlayLaterTile();
    renderAlbums(library.albums);
    if (currentAlbumId === PLAY_LATER_ID) {
      const activeTrackId = queue[queueIndex] ?? null;
      renderTracklist(activeTrackId);
    }
    savePlayerState().catch(() => {});
    return;
  }

  playLaterTracks.push(trackId);
  const duplicateNotice = removedCount
    ? ` Removed ${removedCount} duplicate(s) already in Play later.`
    : "";
  setStatus(`Added to Play later.${duplicateNotice}`);
  renderAlbums(library.albums);
  if (currentAlbumId === PLAY_LATER_ID) {
    const activeTrackId = queue[queueIndex] ?? null;
    renderTracklist(activeTrackId);
  }
  savePlayerState().catch(() => {});
}

function clearPlayLater() {
  if (!playLaterTracks.length) {
    setStatus("Play later is already empty.");
    return;
  }

  playLaterTracks = [];
  setStatus("Play later cleared.");
  renderAlbums(library.albums);
  if (currentAlbumId === PLAY_LATER_ID) {
    const activeTrackId = queue[queueIndex] ?? null;
    renderTracklist(activeTrackId);
  }
  savePlayerState().catch(() => {});
}

function removeFromPlayLater(trackId) {
  const idx = playLaterTracks.indexOf(trackId);
  if (idx === -1) {
    setStatus("Track not found in Play later.");
    return;
  }

  playLaterTracks.splice(idx, 1);
  setStatus("Removed from Play later.");
  renderAlbums(library.albums);
  if (currentAlbumId === PLAY_LATER_ID) {
    const activeTrackId = queue[queueIndex] ?? null;
    renderTracklist(activeTrackId);
  }
  savePlayerState().catch(() => {});
}

async function clearLibrary() {
  dirHandles = [];
  if (libraryImportMode === IMPORT_MODE_OPFS) {
    await clearOpfsLibraryData();
  }
  await persistDirectories([]);

  audio.pause();
  audio.currentTime = 0;
  isPlaying = false;
  queue = [];
  queueIndex = 0;
  currentAlbumId = null;
  activeQueueAlbumId = null;
  playLaterTracks = [];

  library = {
    albums: [],
    tracksById: new Map(),
    albumsById: new Map(),
  };

  renderAlbums([]);
  setNowPlayingUI(null);
  goToAlbumsView();
  libInfoEl.textContent = "No folder connected yet. Tap “Add Music”.";
  setStatus("Library cleared. Use Add Music to connect folders again.");
  savePlayerState().catch(() => {});
}

function stopAndReturnToAlbums() {
  audio.pause();
  audio.currentTime = 0;
  isPlaying = false;
  queue = [];
  queueIndex = 0;
  currentAlbumId = null;
  activeQueueAlbumId = null;
  setNowPlayingUI(null);
  goToAlbumsView();
  setStatus("Playback stopped.");
}

async function playTrackById(trackId) {
  const track = library.tracksById.get(trackId);
  if (!track) return;

  const loadRequestId = ++currentTrackRequestId;
  // Recreate a fresh object URL each time (safe across reloads)
  let file;
  try {
    file = await getFileWithTimeout(track.fileHandle, FILE_READ_TIMEOUT_MS);
  } catch (err) {
    if (loadRequestId !== currentTrackRequestId) return; // superseded
    console.warn("Could not open track file:", track.path, err);
    const msg = err.name === "TimeoutError"
      ? "Track unavailable: network drive not responding. Try again or skip to another track."
      : "Could not open track (file unavailable).";
    setStatus(msg);
    isPlaying = false;
    return;
  }

  if (loadRequestId !== currentTrackRequestId) return; // superseded

  const url = URL.createObjectURL(file);

  // Clean up previous URL to avoid memory leaks
  if (audio.src && audio.src.startsWith("blob:")) {
    try { URL.revokeObjectURL(audio.src); } catch {}
  }

  audio.src = url;
  try {
    await audio.play();
  } catch (err) {
    if (loadRequestId !== currentTrackRequestId) return;
    console.warn(err);
    setStatus("Could not start playback (permission/gesture needed). Tap Play again.");
    return;
  }
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

  await loadSettings();

  if (libraryImportMode === IMPORT_MODE_OPFS) {
    const imported = await loadOpfsImportedPaths();
    if (imported.length) {
      try {
        libInfoEl.textContent = "Using imported music stored in app storage…";
        await reconnectFolder();
      } catch (err) {
        console.warn(err);
        libInfoEl.textContent = "Imported music found but unavailable. Try Add Music again.";
        setStatus("Could not read stored music. Try importing again.");
      }
    } else {
      libInfoEl.textContent = "No imported music yet. Tap “Add Music” to import into app storage.";
      setStatus("Not connected. Tap “Add Music” to import into app storage.");
    }
  } else {
    // Auto-try reconnect on startup
    const saved = await loadSavedDirectories();
    if (saved.length) {
      dirHandles = saved;
      libInfoEl.textContent = "Saved folder(s) found. Reconnecting…";
      await reconnectFolder();
    } else {
      libInfoEl.textContent = "No folder connected yet. Tap “Add Music”.";
      setStatus("Not connected. Tap “Add Music”.");
    }
  }
})();
