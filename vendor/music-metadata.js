let jsMediaTagsPromise = null;

function loadJsMediaTags() {
  if (!jsMediaTagsPromise) {
    jsMediaTagsPromise = import("./jsmediatags.min.js").then(() => window.jsmediatags);
  }
  return jsMediaTagsPromise;
}

function toCommonTags(tags) {
  const picture = tags?.picture
    ? { data: tags.picture.data, format: tags.picture.format }
    : null;
  const disc = tags?.TPOS ?? tags?.discnumber ?? tags?.disk ?? tags?.disc;
  return {
    title: tags?.title,
    artist: tags?.artist,
    album: tags?.album,
    albumartist: tags?.albumartist ?? tags?.albumArtist,
    year: tags?.year,
    track: tags?.track,
    disk: disc,
    picture,
  };
}

export async function parseBlob(file) {
  const jsMediaTags = await loadJsMediaTags();
  return new Promise((resolve, reject) => {
    if (!jsMediaTags?.read) {
      reject(new Error("jsmediatags not available"));
      return;
    }
    jsMediaTags.read(file, {
      onSuccess: (res) => resolve({ common: toCommonTags(res?.tags) }),
      onError: (err) => reject(err || new Error("tag read error")),
    });
  });
}
