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
     const list = await Zip.read(blob, (done, all) => {});   // [{ name, blob }]
     const ents = await Zip.list(blob);   // [{ name, size }] 目次だけ。数えるときはこちら（速い）
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

  function crcUpdate(c, u8) {
    const t = crcTable();
    for (let i = 0; i < u8.length; i++) c = t[(c ^ u8[i]) & 0xFF] ^ (c >>> 8);
    return c;
  }

  function crc32(u8) {
    return (crcUpdate(0xFFFFFFFF, u8) ^ 0xFFFFFFFF) >>> 0;
  }

  // ★大きいものは少しずつ読んで数える★（v103）
  // 動画を2分（300MB）まで入れられるようにしたので、1本まるごとメモリに読むとスマホのブラウザが落ちる。
  const CRC_STEP = 8 * 1024 * 1024;
  async function crcOfBlob(blob) {
    let c = 0xFFFFFFFF;
    for (let off = 0; off < blob.size; off += CRC_STEP) {
      c = crcUpdate(c, new Uint8Array(await blob.slice(off, off + CRC_STEP).arrayBuffer()));
    }
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
      // ★中身は読み込まずに参照で置く★ 数えるときだけ少しずつ読む。
      // 前は1枚ずつ丸ごと読んで並べていたので、写真全部（数百MB）がメモリに残っていた
      const crc = await crcOfBlob(f.blob);
      const size = f.blob.size;
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
      parts.push(lh, f.blob);

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

  // ★中身の一覧だけを出す（目次を読むだけ）★
  // 読み込む前の「◯枚入っています」はこれで数える。read() は写真1枚ごとに見出しを
  // 読みに行くので、スマホでは1,000枚で1分以上かかり、その間何も出ずに何度も押された。
  async function list(blob) {
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
      out.push({ name: name, size: csize, lho: lho });
    }
    return out;
  }

  // 中身を取り出す。onProgress(何個目, 全部) で進み具合を返す。
  // only … list() の結果から選んだものだけ取り出すときに渡す（省略で全部）
  async function read(blob, onProgress, only) {
    const ents = only || await list(blob);
    const out = [];
    for (let i = 0; i < ents.length; i++) {
      const e = ents[i];
      // 中身の位置は、そのファイルの見出しを読まないと分からない（名前と付加情報の長さが要る）
      const lh = new Uint8Array(await blob.slice(e.lho, e.lho + 30).arrayBuffer());
      const dataOff = e.lho + 30 + get16(lh, 26) + get16(lh, 28);
      out.push({ name: e.name, blob: blob.slice(dataOff, dataOff + e.size) });
      if (onProgress && (i % 20 === 0 || i === ents.length - 1)) onProgress(i + 1, ents.length);
    }
    return out;
  }

  // ★近くの写真をまとめて大きく読む★（v102）
  // read() は写真1枚ごとに見出し（30バイト）を読みに行く。スマホ、特にGoogleドライブから
  // 選んだファイルは1回ごとの読み込みに手間がかかり、枚数ぶん待たされた。
  // 近くに並んでいる写真を1回で読み、その中から見出しと中身を切り出す。
  // ents … list() の結果（から選んだもの）。onChunk([{ ent, blob }]) をかたまりごとに待つ
  // （呼ぶ側はそこで保存する。全部読んでから保存すると写真が全部メモリに残る）。
  const CHUNK = 8 * 1024 * 1024;   // 1回に読む大きさの上限
  const SLACK = 4096;              // 見出しの名前・付加情報の分（目次の長さと違うことがある）
  const GAP = 4 * 1024 * 1024;     // 読まない写真がこれより長く続いたら、かたまりを分ける（読みすぎより回数の方が重い）

  async function one(blob, e) {
    const lh = new Uint8Array(await blob.slice(e.lho, e.lho + 30).arrayBuffer());
    if (get32(lh, 0) !== 0x04034B50) throw new Error('ZIPの中身が読めませんでした（' + e.name + '）');
    const off = e.lho + 30 + get16(lh, 26) + get16(lh, 28);
    return blob.slice(off, off + e.size);
  }

  async function extract(blob, ents, onChunk) {
    const sorted = ents.slice().sort((a, b) => a.lho - b.lho);
    let i = 0;
    while (i < sorted.length) {
      const first = sorted[i];
      // 1つで大きいもの（動画など）は、見出しだけ読んで中身は参照のまま渡す
      if (first.size + SLACK > CHUNK) {
        await onChunk([{ ent: first, blob: await one(blob, first) }]);
        i++;
        continue;
      }
      let j = i, end = first.lho;
      while (j < sorted.length) {
        const e = sorted[j];
        const eEnd = e.lho + 30 + SLACK + e.size;
        if (j > i && (e.size + SLACK > CHUNK || eEnd - first.lho > CHUNK || e.lho - end > GAP)) break;
        end = Math.max(end, eEnd);
        j++;
      }
      const start = first.lho;
      const buf = new Uint8Array(await blob.slice(start, Math.min(end, blob.size)).arrayBuffer());
      const out = [];
      for (let k = i; k < j; k++) {
        const e = sorted[k];
        const p = e.lho - start;
        let got = null;
        if (p + 30 <= buf.length && get32(buf, p) === 0x04034B50) {
          const off = p + 30 + get16(buf, p + 26) + get16(buf, p + 28);
          // ★切り出しは写しを作る★ 元のかたまりを手放せるように
          if (off + e.size <= buf.length) got = new Blob([buf.subarray(off, off + e.size)]);
        }
        // 見出しが思ったより長く、かたまりからはみ出したものは1つずつ読む
        out.push({ ent: e, blob: got || await one(blob, e) });
      }
      await onChunk(out);
      i = j;
    }
  }

  return { write: write, read: read, list: list, extract: extract, crc32: crc32 };
})();
