/* めぐログ — ZIPの読み書き（無圧縮）
   ★なぜ自前で書くか★
   写真をバックアップに入れる方法は3つある。
     1. JSONにBase64で埋める … 今までの方法。★1.33倍に膨らむ★
        写真1,000枚（300MB）で400MBのJSONになり、書き出しも読み込みもできない。
     2. ライブラリでZIP        … 圧縮ライブラリを1つ抱えることになる。
        JPEGは既に圧縮済みなので、縮めても数%しか減らない。割に合わない。
     3. 無圧縮ZIPを自前で作る  … ★1.0倍★。中身はただのJPEGなので、
        パソコンでも普通に開ける。書くコードは200行ほど。
   3を選んだ。

   使い方:
     const blob = await Zip.write([{ name: 'p-1.jpg', blob: photoBlob }, ...]);
     const list = await Zip.read(blob);   // [{ name, blob }]
*/
window.Zip = (function () {
  'use strict';

  // ★中身が変わらないので表を1回だけ作る★
  let TABLE = null;
  function crcTable() {
    if (TABLE) return TABLE;
    TABLE = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      TABLE[n] = c >>> 0;
    }
    return TABLE;
  }

  function crc32(u8) {
    const t = crcTable();
    let c = 0xFFFFFFFF;
    for (let i = 0; i < u8.length; i++) c = t[(c ^ u8[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  // ZIPの日時は MS-DOS 形式（2秒きざみ・1980年起点）
  function dosTime(d) {
    return ((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)) & 0xFFFF;
  }
  function dosDate(d) {
    return (((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xFFFF;
  }

  function u8of(len) { return new Uint8Array(len); }
  function put16(a, o, v) { a[o] = v & 0xFF; a[o + 1] = (v >>> 8) & 0xFF; }
  function put32(a, o, v) {
    a[o] = v & 0xFF; a[o + 1] = (v >>> 8) & 0xFF;
    a[o + 2] = (v >>> 16) & 0xFF; a[o + 3] = (v >>> 24) & 0xFF;
  }
  function get16(a, o) { return a[o] | (a[o + 1] << 8); }
  function get32(a, o) {
    return ((a[o] | (a[o + 1] << 8) | (a[o + 2] << 16)) + (a[o + 3] * 0x1000000)) >>> 0;
  }

  const ENC = new TextEncoder();
  const DEC = new TextDecoder();

  // ★4GBと65535個を超えたら作らない★
  // それを超えると ZIP64 という別の書き方が要る。写真6万枚は現実に無いので、
  // 対応するより「無理です」と言う方がよい（黙って壊れたファイルを作らない）。
  const MAX_TOTAL = 3.5 * 1024 * 1024 * 1024;
  const MAX_FILES = 60000;

  async function write(files, onProgress) {
    if (files.length > MAX_FILES) {
      throw new Error('写真が多すぎます（' + MAX_FILES + '枚まで）');
    }
    const now = new Date();
    const time = dosTime(now), date = dosDate(now);
    const parts = [];        // Blobに渡す断片。写真そのものは読み込まずに参照で置く
    const central = [];
    let offset = 0, total = 0;

    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      const nameBytes = ENC.encode(f.name);
      const buf = new Uint8Array(await f.blob.arrayBuffer());
      const crc = crc32(buf);
      const size = buf.length;
      total += size;
      if (total > MAX_TOTAL) throw new Error('写真の合計が大きすぎます（3.5GBまで）');

      const lh = u8of(30 + nameBytes.length);
      put32(lh, 0, 0x04034B50);
      put16(lh, 4, 20);
      put16(lh, 6, 0x0800);        // 名前はUTF-8
      put16(lh, 8, 0);             // 無圧縮
      put16(lh, 10, time); put16(lh, 12, date);
      put32(lh, 14, crc); put32(lh, 18, size); put32(lh, 22, size);
      put16(lh, 26, nameBytes.length); put16(lh, 28, 0);
      lh.set(nameBytes, 30);
      parts.push(lh, buf);

      const ch = u8of(46 + nameBytes.length);
      put32(ch, 0, 0x02014B50);
      put16(ch, 4, 20); put16(ch, 6, 20);
      put16(ch, 8, 0x0800); put16(ch, 10, 0);
      put16(ch, 12, time); put16(ch, 14, date);
      put32(ch, 16, crc); put32(ch, 20, size); put32(ch, 24, size);
      put16(ch, 28, nameBytes.length);
      put32(ch, 42, offset);
      ch.set(nameBytes, 46);
      central.push(ch);

      offset += lh.length + size;
      if (onProgress && (i % 20 === 0 || i === files.length - 1)) onProgress(i + 1, files.length);
    }

    let cdSize = 0;
    for (const c of central) cdSize += c.length;
    const end = u8of(22);
    put32(end, 0, 0x06054B50);
    put16(end, 8, files.length); put16(end, 10, files.length);
    put32(end, 12, cdSize); put32(end, 16, offset);
    return new Blob(parts.concat(central, [end]), { type: 'application/zip' });
  }

  async function read(blob) {
    const size = blob.size;
    // 末尾から EOCD（終わりの印）を探す。コメントは付けていないので末尾22バイトのはず
    const tailLen = Math.min(size, 66000);
    const tail = new Uint8Array(await blob.slice(size - tailLen).arrayBuffer());
    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (get32(tail, i) === 0x06054B50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('ZIPとして読めませんでした');
    const count = get16(tail, eocd + 10);
    const cdSize = get32(tail, eocd + 12);
    const cdOff = get32(tail, eocd + 16);

    const cd = new Uint8Array(await blob.slice(cdOff, cdOff + cdSize).arrayBuffer());
    const out = [];
    let p = 0;
    for (let n = 0; n < count && p + 46 <= cd.length; n++) {
      if (get32(cd, p) !== 0x02014B50) break;
      const method = get16(cd, p + 10);
      const csize = get32(cd, p + 20);
      const nameLen = get16(cd, p + 28);
      const extraLen = get16(cd, p + 30);
      const cmtLen = get16(cd, p + 32);
      const lho = get32(cd, p + 42);
      const name = DEC.decode(cd.subarray(p + 46, p + 46 + nameLen));
      p += 46 + nameLen + extraLen + cmtLen;
      if (method !== 0) {
        // ★圧縮されたZIPは読めない★ 自分で作ったものは必ず無圧縮。
        // 他所で作り直されたファイルを黙って捨てないよう、名前を添えて知らせる。
        throw new Error('圧縮されたZIPは読めません（' + name + '）');
      }
      // 中身の位置は、そのファイルの見出しを読まないと分からない（名前と付加情報の長さが要る）
      const lh = new Uint8Array(await blob.slice(lho, lho + 30).arrayBuffer());
      const dataOff = lho + 30 + get16(lh, 26) + get16(lh, 28);
      out.push({ name: name, blob: blob.slice(dataOff, dataOff + csize) });
    }
    return out;
  }

  return { write: write, read: read, crc32: crc32 };
})();
