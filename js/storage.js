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
  const DB_VERSION = 2;
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
        // meta … 最後にバックアップを取った時点など、記録そのものではない覚え書き
        if (!d.objectStoreNames.contains('meta')) {
          d.createObjectStore('meta', { keyPath: 'key' });
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
    // name … 元のファイル名。★どの写真か見分ける手がかりになる★
    // クラウドから入れると「御朱印_浅草寺.jpg」のように中身が名前に入っていることが多い。
    async putPhoto(blob, name) {
      const rec = { id: newId('p'), blob, size: blob.size, type: blob.type };
      if (name) rec.name = String(name).slice(0, 120);
      const t = tx(['photos'], 'readwrite');
      await reqToPromise(t.objectStore('photos').put(rec));
      return rec.id;
    },

    // 写真の名前だけを書き換える。★中身は触らない★
    async renamePhoto(id, name) {
      const rec = await this.getPhoto(id);
      if (!rec) return false;
      if (name) rec.name = String(name).slice(0, 120);
      else delete rec.name;
      const t = tx(['photos'], 'readwrite');
      await reqToPromise(t.objectStore('photos').put(rec));
      return true;
    },

    // 編集で写真を外したときに本体も消す。参照が切れたBlobを溜めないため。
    async deletePhoto(id) {
      const t = tx(['photos'], 'readwrite');
      await reqToPromise(t.objectStore('photos').delete(id));
    },

    async getPhoto(id) {
      const t = tx(['photos'], 'readonly');
      return reqToPromise(t.objectStore('photos').get(id));
    },

    // ---- 書き出し / 読み込み ----
    // 写真はBase64にしてJSONに同梱する。1ファイルで完結させ、
    // バックアップの取り違えが起きないようにする。
    //
    // visitFilter … 書き出す記録を選ぶ（人に渡すときにタグで絞るため）。
    //               null なら全部＝バックアップ。
    // withPhotos  … false なら写真の中身を入れない。渡す相手に写真まで
    //               持たせたくない場面があるため（既定は入れる＝バックアップ）。
    async exportAll({ visitFilter = null, withPhotos = true } = {}) {
      const [all, allSpots] = await Promise.all([this.getAllVisits(), this.getSpots()]);
      const visits = visitFilter ? all.filter(visitFilter) : all;
      const photos = [];
      if (withPhotos) {
        for (const v of visits) {
          for (const pid of (v.photoIds || [])) {
            const p = await this.getPhoto(pid);
            if (p) photos.push({ id: p.id, type: p.type, data: await blobToBase64(p.blob) });
          }
        }
      }
      // 自分で追加した地点は、書き出す記録が指しているものだけに絞る。
      // 絞らないと「仕事のぶんだけ」と言いながら全部の地点名が付いてくる。
      let spots = allSpots;
      if (visitFilter) {
        const need = new Set(visits.map((v) => v.spotId));
        spots = allSpots.filter((sp) => need.has(sp.id));
      }
      // ★覚え書き(meta)も全部の書き出しには入れる★
      // 通った市区町村・集めるリストの手チェック・自分で作ったリストは meta にある。
      // 入れないと、機種変したときにそれだけ消える（実際に抜けていた）。
      // 一部だけの書き出し（人に渡す用）には入れない。設定まで渡す必要はない。
      const out = {
        app: 'meguri-log',
        version: 1,
        exportedAt: new Date().toISOString(),
        visits, spots, photos,
      };
      if (!visitFilter) out.meta = await this.exportMeta();
      return out;
    },

    // ★写真だけを取り出す★ バックアップを「記録」と「写真」に分けるため。
    // 記録のJSONは写真を含まないので数百KBで済み、機種変更で確実に運べる。
    // 写真はZIPにまとめる（Base64だと1.33倍に膨らむ）。
    async photosOf(visits) {
      const out = [];
      const seen = new Set();
      for (const v of visits) {
        for (const pid of (v.photoIds || [])) {
          if (seen.has(pid)) continue;
          seen.add(pid);
          const p = await this.getPhoto(pid);
          if (p) out.push(p);
        }
      }
      return out;
    },

    // ZIPから戻した写真を書き戻す。★元のidのまま入れる★
    // 記録が photoIds で id を指しているので、id が変わると結びつきが切れる。
    async putPhotosRaw(list, onProgress) {
      let n = 0;
      for (const it of list) {
        const t = tx(['photos'], 'readwrite');
        await reqToPromise(t.objectStore('photos').put(it));
        n++;
        if (onProgress && (n % 5 === 0 || n === list.length)) onProgress(n, list.length);
      }
      return n;
    },

    // 持ち出す覚え書き。lastBackup はその端末の事情なので持ち出さない。
    // ★通った道は日ごとのキー（trackDay:YYYY-MM-DD）にも入っている★（v93〜）
    // 決め打ちの一覧だけだと、前の日の道がバックアップから抜ける。
    async exportMeta() {
      // ★collectHide（リストの対象から外した場所）が抜けていた★（v94で足した）
      const keys = ['passed', 'passedCounts', 'track', 'trackDays', 'trackLineOn',
                    'collectDone', 'collectExtra', 'collectHide',
                    'collections', 'hiddenTags', 'mapStyle'];
      keys.push(...await this.metaKeys('trackDay:'));
      const out = {};
      for (const k of keys) {
        const v = await this.getMeta(k);
        if (v !== null && v !== undefined) out[k] = v;
      }
      return out;
    },

    async metaKeys(prefix) {
      const keys = await reqToPromise(tx(['meta'], 'readonly').objectStore('meta').getAllKeys());
      return keys.map(String).filter((k) => k.indexOf(prefix) === 0).sort();
    },

    async delMeta(key) {
      const t = tx(['meta'], 'readwrite');
      t.objectStore('meta').delete(key);
      await new Promise((res, rej) => { t.oncomplete = res; t.onerror = () => rej(t.error); });
    },

    async importAll(data, { merge = true } = {}) {
      if (!data || data.app !== 'meguri-log') {
        throw new Error('このファイルは めぐログ の書き出しデータではありません');
      }
      if (!merge) {
        const t = tx(['visits', 'spots', 'photos'], 'readwrite');
        t.objectStore('visits').clear();
        t.objectStore('spots').clear();
        t.objectStore('photos').clear();
        await new Promise((r) => { t.oncomplete = r; });
      }
      // ★別の端末の記録と1つにまとめられるように★（v94〜）
      // 記録の id は端末ごとに違うので、別の端末の記録はそのまま足される。
      // ★同じ記録が両方にあるときは、新しく直した方を残す★
      // 以前はファイル側で上書きしていたので、古いバックアップや、前に渡し合った端末のファイルを読むと、
      // その後にこの端末で直した内容（メモ・住所など）が古い内容に戻っていた。
      // 直した時刻（updatedAt、無ければ作った時刻）で比べ、同じならこの端末の方を残す。
      // ※ 取引の途中で読みに行くと古いSafariで取引が閉じるので、先に全部読んでおく
      const existing = new Map((await this.getAllVisits()).map((v) => [v.id, v]));
      const stamp = (v) => String(v.updatedAt || v.createdAt || '');
      let added = 0, replaced = 0, kept = 0;
      const t = tx(['visits', 'spots', 'photos'], 'readwrite');
      (data.spots || []).forEach((s) => t.objectStore('spots').put(s));
      for (const v of (data.visits || [])) {
        const cur = existing.get(v.id);
        if (!cur) { t.objectStore('visits').put(v); added++; }
        else if (stamp(v) > stamp(cur)) { t.objectStore('visits').put(v); replaced++; }
        else kept++;
      }
      for (const p of (data.photos || [])) {
        t.objectStore('photos').put({ id: p.id, blob: base64ToBlob(p.data, p.type), type: p.type });
      }
      await new Promise((res, rej) => { t.oncomplete = res; t.onerror = () => rej(t.error); });

      // ★覚え書きも上書きしない★
      // - 通った道・通った市区町村: 取り出して返し、アプリ側（mergeImportedRoute）でつなぎ合わせる（v93〜）
      //   古いバックアップを読むと、その後に走った道がまるごと巻き戻っていた
      // - 集めるリストの「行った」の印・自分で足した場所・外した場所・自分のリスト: 両方を合わせる（v94〜）
      //   以前は読み込んだ側の内容で上書きしていたので、別の端末のファイルを読むと、この端末で付けた印が消えた
      // - 設定（使うタグ・地図の種類など）: この端末にまだ無いときだけ入れる。機種変の新しい端末には入る
      const meta = data.meta;
      const routeIn = [];
      let passedIn = [];
      if (meta && typeof meta === 'object') {
        const cur = {};
        for (const k of Object.keys(meta)) cur[k] = await this.getMeta(k);
        const mt = tx(['meta'], 'readwrite');
        const ms = mt.objectStore('meta');
        Object.keys(meta).forEach((k) => {
          const v = meta[k];
          const have = cur[k];
          if (k === 'track' || k.indexOf('trackDay:') === 0) {
            if (Array.isArray(v)) v.forEach((p) => routeIn.push(p));
          } else if (k === 'passed') {
            if (Array.isArray(v)) passedIn = v;
          } else if (k === 'trackDays') {
            // 目次はアプリ側で作り直す
          } else if (k === 'collectDone' || k === 'collectHide') {
            ms.put({ key: k, value: mergeNameLists(have, v, (x) => String(x)) });
          } else if (k === 'collectExtra') {
            ms.put({ key: k, value: mergeNameLists(have, v, placeKey) });
          } else if (k === 'collections') {
            ms.put({ key: k, value: mergeCollections(have, v) });
          } else if (have === null || have === undefined) {
            ms.put({ key: k, value: v });
          }
        });
        await new Promise((res) => { mt.oncomplete = res; });
      }
      return {
        visits: (data.visits || []).length,
        added, replaced, kept,
        spots: (data.spots || []).length,
        photos: (data.photos || []).length,
        routeIn, passedIn,
      };
    },

    // ---- 覚え書き（meta） ----
    async getMeta(key) {
      const r = await reqToPromise(tx(['meta'], 'readonly').objectStore('meta').get(key));
      return r ? r.value : null;
    },

    async setMeta(key, value) {
      const t = tx(['meta'], 'readwrite');
      t.objectStore('meta').put({ key, value });
      await new Promise((res, rej) => { t.oncomplete = res; t.onerror = () => rej(t.error); });
    },

    // ---- 保存の永続化 ----
    // これを宣言しておかないと、ブラウザは容量が足りなくなったときに
    // 断りなく記録を消すことがある。バックアップ以前の防衛線。
    async persist() {
      if (!navigator.storage || !navigator.storage.persist) return null;
      try {
        if (await navigator.storage.persisted()) return true;
        return await navigator.storage.persist();
      } catch (e) { return null; }
    },

    async persisted() {
      if (!navigator.storage || !navigator.storage.persisted) return null;
      try { return await navigator.storage.persisted(); } catch (e) { return null; }
    },

    // 最後のバックアップから記録がどれだけ増えたか
    async backupStatus() {
      const [visits, last] = await Promise.all([this.getAllVisits(), this.getMeta('lastBackup')]);
      const now = visits.length;
      if (!last) return { never: true, total: now, unsaved: now, at: null };
      return { never: false, total: now, unsaved: Math.max(0, now - (last.visits || 0)), at: last.at };
    },

    async markBackedUp(counts) {
      await this.setMeta('lastBackup', {
        at: new Date().toISOString(),
        visits: counts.visits, photos: counts.photos,
      });
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

  // ---- 読み込みで2つの端末の覚え書きを合わせる（v94〜） ----
  // 場所の見分け: 名前と位置（小数4桁、約10m）。「トイレ」のような同じ名前が別の所にあるため
  function placeKey(it) {
    if (!it || typeof it !== 'object') return String(it);
    const r = (x) => (typeof x === 'number' ? x.toFixed(4) : '');
    return (it.name || '') + '|' + r(it.lat) + '|' + r(it.lng);
  }

  // { リストのid: [名前 or 場所, ...] } どうしを合わせる。今の方を先に並べ、無いものだけ足す
  function mergeNameLists(have, add, keyOf) {
    const out = {};
    const a = (have && typeof have === 'object') ? have : {};
    const b = (add && typeof add === 'object') ? add : {};
    for (const id of new Set(Object.keys(a).concat(Object.keys(b)))) {
      const list = Array.isArray(a[id]) ? a[id].slice() : [];
      const seen = new Set(list.map(keyOf));
      for (const x of (Array.isArray(b[id]) ? b[id] : [])) {
        const k = keyOf(x);
        if (!seen.has(k)) { seen.add(k); list.push(x); }
      }
      out[id] = list;
    }
    return out;
  }

  // 自分のリスト（配られたリストを取り込んだものも含む）を合わせる。
  // 同じidのリストは今の方を元にし、中身は無い場所だけ足す
  function mergeCollections(have, add) {
    const out = Array.isArray(have) ? have.map((c) => Object.assign({}, c)) : [];
    const byId = new Map(out.map((c) => [c.id, c]));
    for (const c of (Array.isArray(add) ? add : [])) {
      if (!c || !c.id) continue;
      const cur = byId.get(c.id);
      if (!cur) { const n = Object.assign({}, c); out.push(n); byId.set(n.id, n); continue; }
      const items = Array.isArray(cur.items) ? cur.items.slice() : [];
      const seen = new Set(items.map(placeKey));
      for (const it of (Array.isArray(c.items) ? c.items : [])) {
        const k = placeKey(it);
        if (!seen.has(k)) { seen.add(k); items.push(it); }
      }
      cur.items = items;
    }
    return out;
  }

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
