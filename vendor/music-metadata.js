const TEXT_DECODER = new TextDecoder("utf-8");

function readUint32BE(view, offset) {
  return view.getUint32(offset, false);
}

function readUint32LE(view, offset) {
  return view.getUint32(offset, true);
}

function readUint16LE(view, offset) {
  return view.getUint16(offset, true);
}

function readSyncSafeInt(view, offset) {
  return (
    (view.getUint8(offset) << 21) |
    (view.getUint8(offset + 1) << 14) |
    (view.getUint8(offset + 2) << 7) |
    view.getUint8(offset + 3)
  );
}

function decodeText(bytes, encoding) {
  if (!bytes.length) return "";
  if (encoding === 0 || encoding === 3) {
    return TEXT_DECODER.decode(bytes).replace(/\0/g, "").trim();
  }
  if (encoding === 1 || encoding === 2) {
    const decoder = new TextDecoder(encoding === 1 ? "utf-16" : "utf-16be");
    return decoder.decode(bytes).replace(/\0/g, "").trim();
  }
  return TEXT_DECODER.decode(bytes).replace(/\0/g, "").trim();
}

function parseId3v2Frames(buffer, offset, size, version) {
  const view = new DataView(buffer, offset, size);
  let pos = 0;
  const tags = {};
  let picture = null;
  while (pos + 10 <= size) {
    const frameId = String.fromCharCode(
      view.getUint8(pos),
      view.getUint8(pos + 1),
      view.getUint8(pos + 2),
      view.getUint8(pos + 3)
    );
    if (!frameId.trim()) break;
    const frameSize = version === 4
      ? readSyncSafeInt(view, pos + 4)
      : readUint32BE(view, pos + 4);
    if (frameSize <= 0 || pos + 10 + frameSize > size) break;
    const frameData = new Uint8Array(buffer, offset + pos + 10, frameSize);
    if (frameId[0] === "T") {
      const encoding = frameData[0];
      const text = decodeText(frameData.slice(1), encoding);
      if (frameId === "TIT2") tags.title = text;
      if (frameId === "TPE1") tags.artist = text;
      if (frameId === "TALB") tags.album = text;
      if (frameId === "TPE2") tags.albumartist = text;
      if (frameId === "TRCK") tags.track = text;
      if (frameId === "TPOS") tags.disc = text;
      if (frameId === "TYER" || frameId === "TDRC") tags.year = text;
    } else if (frameId === "APIC") {
      let idx = 0;
      const encoding = frameData[idx++];
      while (idx < frameData.length && frameData[idx] !== 0) idx++;
      const mime = decodeText(frameData.slice(1, idx), 3) || "image/jpeg";
      idx++;
      idx++;
      while (idx < frameData.length && frameData[idx] !== 0) idx++;
      idx++;
      const data = frameData.slice(idx);
      if (data.length) {
        picture = { format: mime, data };
      }
    }
    pos += 10 + frameSize;
  }
  return { tags, picture };
}

function parseFlacMetadata(buffer) {
  const view = new DataView(buffer);
  let pos = 4;
  let isLast = false;
  const tags = {};
  let picture = null;
  while (!isLast && pos + 4 <= buffer.byteLength) {
    const header = view.getUint8(pos);
    isLast = (header & 0x80) !== 0;
    const blockType = header & 0x7f;
    const blockSize = (view.getUint8(pos + 1) << 16) | (view.getUint8(pos + 2) << 8) | view.getUint8(pos + 3);
    const blockStart = pos + 4;
    if (blockStart + blockSize > buffer.byteLength) break;
    if (blockType === 4) {
      const blockView = new DataView(buffer, blockStart, blockSize);
      let offset = 0;
      const vendorLength = readUint32LE(blockView, offset);
      offset += 4 + vendorLength;
      const commentCount = readUint32LE(blockView, offset);
      offset += 4;
      for (let i = 0; i < commentCount; i += 1) {
        if (offset + 4 > blockSize) break;
        const length = readUint32LE(blockView, offset);
        offset += 4;
        if (offset + length > blockSize) break;
        const comment = decodeText(new Uint8Array(buffer, blockStart + offset, length), 3);
        offset += length;
        const [key, ...rest] = comment.split("=");
        const value = rest.join("=").trim();
        const normalizedKey = key.toLowerCase();
        if (normalizedKey === "title") tags.title = value;
        if (normalizedKey === "artist") tags.artist = value;
        if (normalizedKey === "album") tags.album = value;
        if (normalizedKey === "albumartist") tags.albumartist = value;
        if (normalizedKey === "tracknumber") tags.track = value;
        if (normalizedKey === "discnumber") tags.disc = value;
        if (normalizedKey === "date" || normalizedKey === "year") tags.year = value;
      }
    } else if (blockType === 6) {
      const blockView = new DataView(buffer, blockStart, blockSize);
      let offset = 0;
      offset += 4;
      const mimeLength = readUint32BE(blockView, offset);
      offset += 4;
      const mime = decodeText(new Uint8Array(buffer, blockStart + offset, mimeLength), 3) || "image/jpeg";
      offset += mimeLength;
      const descLength = readUint32BE(blockView, offset);
      offset += 4 + descLength;
      offset += 16;
      const dataLength = readUint32BE(blockView, offset);
      offset += 4;
      if (offset + dataLength <= blockSize) {
        const data = new Uint8Array(buffer, blockStart + offset, dataLength);
        picture = { format: mime, data };
      }
    }
    pos = blockStart + blockSize;
  }
  return { tags, picture };
}

function parseId3v1(buffer) {
  if (buffer.byteLength < 128) return null;
  const view = new DataView(buffer, buffer.byteLength - 128, 128);
  const tag = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2));
  if (tag !== "TAG") return null;
  const text = (offset, length) => TEXT_DECODER.decode(new Uint8Array(buffer, buffer.byteLength - 128 + offset, length)).replace(/\0/g, "").trim();
  const trackByte = view.getUint8(126);
  return {
    title: text(3, 30),
    artist: text(33, 30),
    album: text(63, 30),
    year: text(93, 4),
    track: trackByte ? trackByte.toString() : ""
  };
}

function buildCommon(tags, picture) {
  const common = {
    title: tags.title || null,
    artist: tags.artist || null,
    album: tags.album || null,
    albumartist: tags.albumartist || null,
    year: tags.year || null,
    track: tags.track ? { no: parseInt(tags.track, 10) || null } : null,
    disk: tags.disc ? { no: parseInt(tags.disc, 10) || null } : null,
    picture: picture ? [picture] : []
  };
  return { common };
}

export async function parseBlob(blob) {
  const buffer = await blob.arrayBuffer();
  const signature = new Uint8Array(buffer, 0, Math.min(4, buffer.byteLength));
  let result = { tags: {}, picture: null };
  if (signature[0] === 0x66 && signature[1] === 0x4c && signature[2] === 0x61 && signature[3] === 0x43) {
    result = parseFlacMetadata(buffer);
  } else {
    const view = new DataView(buffer);
    if (signature[0] === 0x49 && signature[1] === 0x44 && signature[2] === 0x33) {
      const majorVersion = view.getUint8(3);
      const flags = view.getUint8(5);
      let tagSize = readSyncSafeInt(view, 6);
      let tagOffset = 10;
      if (flags & 0x40) {
        const extendedHeaderSize = majorVersion === 4
          ? readSyncSafeInt(view, tagOffset)
          : readUint32BE(view, tagOffset);
        tagOffset += extendedHeaderSize;
        tagSize -= extendedHeaderSize;
      }
      const { tags, picture } = parseId3v2Frames(buffer, tagOffset, tagSize, majorVersion);
      result = { tags, picture };
    } else {
      const id3v1 = parseId3v1(buffer);
      if (id3v1) result = { tags: id3v1, picture: null };
    }
  }
  return buildCommon(result.tags, result.picture);
}

export async function parseBuffer(uint8Array) {
  const blob = new Blob([uint8Array]);
  return parseBlob(blob);
}

export function getSupportedMimeTypes() {
  return ["audio/mpeg", "audio/flac"];
}
