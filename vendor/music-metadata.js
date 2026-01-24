const MUSIC_METADATA_VERSION = "10.3.2";
let cachedModule = null;

async function loadModule() {
  if (!cachedModule) {
    cachedModule = import(`https://cdn.jsdelivr.net/npm/music-metadata@${MUSIC_METADATA_VERSION}/+esm`);
  }
  return cachedModule;
}

export async function parseBlob(file, options = {}) {
  const module = await loadModule();
  return module.parseBlob(file, options);
}

export { MUSIC_METADATA_VERSION };
