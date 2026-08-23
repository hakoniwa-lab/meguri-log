/*
  storage.js — 保存層（IndexedDB）

  ★重要な設計方針★
  アプリ本体（app.js）は、このファイルが公開する関数以外からデータに触らない。
  そうしておくと、将来クラウド同期に切り替えるときに
  このファイルの中身だけを差し替えればよく、画面側は一行も直さずに済む。

  localStorage は使わない。上限が約5MBしかなく、御朱印の写真を数枚入れただけで破綻するため。
*/
const Store = (() => {
  const DB_NAME = 'meguri-log';
  const DB_VERSION = 1;
  let db = null;

  // spots  … ユーザーが自分で追加した地点（御朱印・マイナーな城跡・廃駅など）
  //          都道府県などのマスタ地点はGeoJSON側が持つのでここには入れない
  // visits … 訪問記録。1つの地点に複数の訪問を持てる（再訪の記録）
  // photos … 写真のBlob本体。visits からIDで参照する
  function open() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (e) => {
        const d = e.target.result;
        if (!d.objectStoreNames.contains('spots')) {
          const s = d.createObjectStore('spots', { keyPath: 'id' });
          s.createIndex('category', 'category', { unique: false });
        }
        if (!d.objectStoreNames.contains('visits')) {
          const v = d.createObjectStore('visits', { keyPath: 'id' });
          v.createIndex('spotId', 'spotId', { unique: false });
          v.createIndex('visitedAt', 'visitedAt', { unique: false });
        }
        if (!d.objectStoreNames.contains('photos')) {
          d.createObjectStore('photos', { keyPath: 'id' });
        }
      };
      req.onsuccess = () => { db = req.result; resolve(db); };
      req.onerror = () => reject(req.error);
    });
  }

  function tx(names, mode) {
    return db.transaction(names, mode);
  }

  function reqToPromise(req) {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  function newId(prefix) {
    return prefix + '-' + Date.now().toString(36) + '-' +
      Math.random().toString(36).slice(2, 8);
  }

  return {
    async init() {
      if (!db) await open();
      return db;
    },

    // ---- 訪問記録 ----
    async addVisit(visit) {
      const rec = Object.assign({ id: newId('v'), createdAt: new Date().toISOString() }, visit);
      const t = tx(['visits'], 'readwrite');
      await reqToPromise(t.objectStore('visits').put(rec));
      return rec;
    },

    async updateVisit(visit) {
      const t = tx(['visits'], 'readwrite');
      await reqToPromise(t.objectStore('visits').put(visit));
      return visit;
    },

    async deleteVisit(id) {
      const v = await this.getVisit(id);
      const t = tx(['visits'], 'readwrite');
      await reqToPromise(t.objectStore('visits').delete(id));
      // ぶら下がっている写真も一緒に消す（孤児レコードを残さない）
      if (v && v.photoIds && v.photoIds.length) {
        const pt = tx(['photos'], 'readwrite');
        const ps = pt.objectStore('photos');
        v.photoIds.forEach((pid) => ps.delete(pid));
      }
    },

    async getVisit(id) {
      const t = tx(['visits'], 'readonly');
      return reqToPromise(t.objectStore('visits').get(id));
    },

    async getVisitsBySpot(spotId) {
      const t = tx(['visits'], 'readonly');
      const idx = t.objectStore('visits').index('spotId');
      return reqToPromise(idx.getAll(IDBKeyRange.only(spotId)));
    },

    async getAllVisits() {
      const t = tx(['visits'], 'readonly');
      return reqToPromise(t.objectStore('visits').getAll());
    },

    // 訪問済みの spotId の集合を返す（地図の塗り分けで毎回使う）
    async getVisitedSpotIds() {
      const all = await this.getAllVisits();
      return new Set(all.map((v) => v.spotId));
    },

    // ---- ユーザーが追加した地点 ----
    async addSpot(spot) {
      const rec = Object.assign({ id: newId('s'), source: 'user' }, spot);
      const t = tx(['spots'], 'readwrite');
      await reqToPromise(t.objectStore('spots').put(rec));
      return rec;
    },

    async getSpots(category) {
      const t = tx(['spots'], 'readonly');
      const s = t.objectStore('spots');
      if (!category) return reqToPromise(s.getAll());
      return reqToPromise(s.index('category').getAll(IDBKeyRange.only(category)));
    },

    async deleteSpot(id) {
      const t = tx(['spots'], 'readwrite');
      await reqToPromise(t.objectStore('spots').delete(id));
    },

    // ---- 写真 ----
    async putPhoto(blob) {
      const rec = { id: newId('p'), blob, size: blob.size, type: blob.type };
      const t = tx(['photos'], 'readwrite');
      await reqToPromise(t.objectStore('photos').put(rec));
      return rec.id;
    },

    async getPhoto(id) {
      const t = tx(['photos'], 'readonly');
      return reqToPromise(t.objectStore('photos').get(id));
    },

    // ---- 書き出し / 読み込み ----
    // 写真はBase64にしてJSONに同梱する。1ファイルで完結させ、
    // バックアップの取り違えが起きないようにする。
    async exportAll() {
      const [visits, spots] = await Promise.all([this.getAllVisits(), this.getSpots()]);
      const photos = [];
      for (const v of visits) {
        for (const pid of (v.photoIds || [])) {
          const p = await this.getPhoto(pid);
          if (p) photos.push({ id: p.id, type: p.type, data: await blobToBase64(p.blob) });
        }
      }
      return {
        app: 'meguri-log',
        version: 1,
        exportedAt: new Date().toISOString(),
        visits, spots, photos,
      };
    },

    async importAll(data, { merge = true } = {}) {
      if (!data || data.app !== 'meguri-log') {
        throw new Error('このファイルは めぐりログ の書き出しデータではありません');
      }
      if (!merge) {
        const t = tx(['visits', 'spots', 'photos'], 'readwrite');
        t.objectStore('visits').clear();
        t.objectStore('spots').clear();
        t.objectStore('photos').clear();
        await new Promise((r) => { t.oncomplete = r; });
      }
      const t = tx(['visits', 'spots', 'photos'], 'readwrite');
      (data.spots || []).forEach((s) => t.objectStore('spots').put(s));
      (data.visits || []).forEach((v) => t.objectStore('visits').put(v));
      for (const p of (data.photos || [])) {
        t.objectStore('photos').put({ id: p.id, blob: base64ToBlob(p.data, p.type), type: p.type });
      }
      await new Promise((res, rej) => { t.oncomplete = res; t.onerror = () => rej(t.error); });
      return {
        visits: (data.visits || []).length,
        spots: (data.spots || []).length,
        photos: (data.photos || []).length,
      };
    },

    async clearAll() {
      const t = tx(['visits', 'spots', 'photos'], 'readwrite');
      t.objectStore('visits').clear();
      t.objectStore('spots').clear();
      t.objectStore('photos').clear();
      await new Promise((r) => { t.oncomplete = r; });
    },

    // 使用容量の目安（設定画面で表示する）
    async estimate() {
      if (navigator.storage && navigator.storage.estimate) {
        return navigator.storage.estimate();
      }
      return null;
    },
  };

  function blobToBase64(blob) {
    return new Promise((resolve) => {
      const fr = new FileReader();
      fr.onload = () => resolve(String(fr.result).split(',')[1]);
      fr.readAsDataURL(blob);
    });
  }

  function base64ToBlob(b64, type) {
    const bin = atob(b64);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return new Blob([arr], { type: type || 'image/jpeg' });
  }
})();
