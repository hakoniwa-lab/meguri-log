/*
  app.js — めぐりログ 本体

  Phase 1: 都道府県制覇
  データの読み書きは storage.js の Store 経由でしか行わない（クラウド差し替えのため）。
*/
(() => {
  'use strict';

  // sw.js の VERSION と必ず揃えること。設定画面に表示され、
  // 端末に届いている版を目視で確認できるようにしている。
  const APP_VERSION = 'v8';

  const CATEGORY = 'pref';
  const state = {
    features: [],        // GeoJSONのfeature配列（マスタ地点）
    visited: new Set(),  // 訪問済みの spotId
    layer: null,
    map: null,
    here: null,          // 現在地マーカー
    selected: null,      // 記録シートで開いている spot
    pending: [],         // 保存前に添付した写真 [{blob, url}]
  };

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.prototype.slice.call(document.querySelectorAll(sel));

  const spotIdOf = (code) => CATEGORY + '-' + code;

  // ---------------------------------------------------------------
  // 起動
  // ---------------------------------------------------------------
  async function boot() {
    await Store.init();
    const res = await fetch('./data/prefectures.geojson');
    const gj = await res.json();
    state.features = gj.features;
    state.visited = await Store.getVisitedSpotIds();

    initMap(gj);
    initTabs();
    initSheet();
    initSettings();
    renderList();
    renderProgress();
  }

  // ---------------------------------------------------------------
  // 地図
  // ---------------------------------------------------------------
  function initMap(gj) {
    state.map = L.map('map', { zoomControl: true }).setView([37.5, 137.5], 5);

    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 18,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    }).addTo(state.map);

    state.layer = L.geoJSON(gj, {
      style: styleFor,
      onEachFeature: (feat, layer) => {
        layer.on('click', () => openSheet(feat.properties.code));
        layer.bindTooltip(feat.properties.name, { sticky: true });
      },
    }).addTo(state.map);

    $('#btn-here').addEventListener('click', () => locate(false));
    $('#btn-here-record').addEventListener('click', () => locate(true));
  }

  function styleFor(feat) {
    const done = state.visited.has(spotIdOf(feat.properties.code));
    return {
      color: '#2c3e62',
      weight: 1,
      fillColor: done ? '#e8a33d' : '#c9d2e0',
      fillOpacity: done ? 0.75 : 0.35,
    };
  }

  function refreshMap() {
    if (state.layer) state.layer.setStyle(styleFor);
  }

  // ---------------------------------------------------------------
  // 現在地 → いまいる都道府県を判定
  // ---------------------------------------------------------------
  // openRecord=false … 現在地へ地図を動かすだけ（記録シートは開かない）
  // openRecord=true  … 現在地を判定して、その都道府県の記録シートを開く
  function locate(openRecord) {
    const btn = openRecord ? $('#btn-here-record') : $('#btn-here');
    const label = btn.textContent;
    if (!navigator.geolocation) {
      toast('この端末では現在地を取得できません');
      return;
    }
    btn.disabled = true;
    btn.textContent = '取得中…';
    const restore = () => { btn.disabled = false; btn.textContent = label; };

    navigator.geolocation.getCurrentPosition(
      (pos) => {
        restore();
        const { latitude: lat, longitude: lng } = pos.coords;
        if (state.here) state.map.removeLayer(state.here);
        state.here = L.circleMarker([lat, lng], {
          radius: 8, color: '#c0392b', fillColor: '#e74c3c', fillOpacity: 0.9, weight: 2,
        }).addTo(state.map);
        // 記録するときは県全体が見える程度、移動だけのときは少し寄る
        state.map.setView([lat, lng], openRecord ? 9 : 11);

        const feat = findPrefectureAt(lat, lng);
        if (!feat) {
          toast('現在地は日本の都道府県の範囲外のようです');
          return;
        }
        if (openRecord) {
          openSheet(feat.properties.code, { lat, lng });
        } else {
          // 記録は割り込ませない。今どこにいるかだけ知らせる。
          const done = state.visited.has(spotIdOf(feat.properties.code));
          toast(feat.properties.name + (done ? '（記録済み）' : '（未記録）'));
        }
      },
      (err) => {
        restore();
        const msg = err.code === 1
          ? '位置情報の利用が許可されていません。ブラウザの設定から許可してください'
          : '現在地を取得できませんでした';
        toast(msg);
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 }
    );
  }

  // 点が多角形の内側にあるか（レイキャスティング法）
  function pointInRing(lng, lat, ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const xi = ring[i][0], yi = ring[i][1];
      const xj = ring[j][0], yj = ring[j][1];
      const hit = ((yi > lat) !== (yj > lat)) &&
        (lng < (xj - xi) * (lat - yi) / (yj - yi) + xi);
      if (hit) inside = !inside;
    }
    return inside;
  }

  function findPrefectureAt(lat, lng) {
    for (const f of state.features) {
      for (const poly of f.geometry.coordinates) {
        if (pointInRing(lng, lat, poly[0])) return f;
      }
    }
    return null;
  }

  // ---------------------------------------------------------------
  // 記録シート
  // ---------------------------------------------------------------
  function featureByCode(code) {
    return state.features.find((f) => f.properties.code === code);
  }

  async function openSheet(code, coords) {
    const feat = featureByCode(code);
    if (!feat) return;
    state.selected = { code, name: feat.properties.name, coords: coords || null };

    $('#sheet-title').textContent = feat.properties.name;
    $('#visit-date').value = new Date().toISOString().slice(0, 10);
    $('#visit-memo').value = '';
    clearPending();
    $('#sheet-coords').textContent = coords
      ? `現在地: ${coords.lat.toFixed(4)}, ${coords.lng.toFixed(4)}`
      : '座標は記録されません（地図から選択）';

    await renderVisitList(spotIdOf(code));
    $('#sheet').classList.add('is-open');
  }

  function closeSheet() {
    $('#sheet').classList.remove('is-open');
    state.selected = null;
    clearPending();
  }

  async function renderVisitList(spotId) {
    const visits = await Store.getVisitsBySpot(spotId);
    visits.sort((a, b) => (a.visitedAt < b.visitedAt ? 1 : -1));
    const box = $('#visit-list');
    if (!visits.length) {
      box.innerHTML = '<p class="muted">まだ記録がありません。</p>';
      return;
    }
    box.innerHTML = '';
    for (const v of visits) {
      const row = document.createElement('div');
      row.className = 'visit';
      const head = document.createElement('div');
      head.className = 'visit__head';
      head.innerHTML = `<b>${v.visitedAt}</b>`;
      const del = document.createElement('button');
      del.className = 'linkbtn';
      del.textContent = '削除';
      del.addEventListener('click', async () => {
        if (!confirm('この記録を削除しますか？')) return;
        await Store.deleteVisit(v.id);
        state.visited = await Store.getVisitedSpotIds();
        refreshMap(); renderList(); renderProgress();
        await renderVisitList(spotId);
      });
      head.appendChild(del);
      row.appendChild(head);
      if (v.memo) {
        const m = document.createElement('p');
        m.className = 'visit__memo';
        m.textContent = v.memo;
        row.appendChild(m);
      }
      for (const pid of (v.photoIds || [])) {
        const p = await Store.getPhoto(pid);
        if (!p) continue;
        const fig = document.createElement('div');
        fig.className = 'shot';
        const img = document.createElement('img');
        img.className = 'visit__photo';
        img.src = URL.createObjectURL(p.blob);
        img.addEventListener('load', () => URL.revokeObjectURL(img.src), { once: true });
        fig.appendChild(img);

        // アプリ内カメラで撮った写真は端末のライブラリには残らない
        // （ブラウザから写真ライブラリへ書き込むAPIは存在しないため）。
        // 端末に残したい人向けに、共有シート経由の保存口をここに用意する。
        // 共有と保存は端末で挙動が違うので、1つのボタンにまとめない。
        // iPhone: 共有シートに「画像を保存」が出る
        // Android: 共有シートはアプリ一覧で「画像を保存」は無い → ダウンロードを使う
        const acts = document.createElement('div');
        acts.className = 'shot__acts';

        const shareBtn = document.createElement('button');
        shareBtn.type = 'button';
        shareBtn.className = 'shot__btn';
        shareBtn.textContent = '共有';
        shareBtn.addEventListener('click', () => sharePhoto(p, v));
        acts.appendChild(shareBtn);

        const dlBtn = document.createElement('button');
        dlBtn.type = 'button';
        dlBtn.className = 'shot__btn';
        dlBtn.textContent = '端末に保存';
        dlBtn.addEventListener('click', () => downloadPhoto(p, v));
        acts.appendChild(dlBtn);

        fig.appendChild(acts);
        row.appendChild(fig);
      }
      box.appendChild(row);
    }
  }

  // ---- 添付写真（保存前の一時置き場）----
  function clearPending() {
    state.pending.forEach((p) => URL.revokeObjectURL(p.url));
    state.pending = [];
    const c = $('#photo-camera'); if (c) c.value = '';
    const l = $('#photo-library'); if (l) l.value = '';
    renderPending();
  }

  function renderPending() {
    const box = $('#photo-preview');
    if (!box) return;
    box.innerHTML = '';
    state.pending.forEach((p, i) => {
      const cell = document.createElement('div');
      cell.className = 'preview__item';
      const img = document.createElement('img');
      img.src = p.url;
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'preview__del';
      del.textContent = '×';
      del.setAttribute('aria-label', 'この写真を外す');
      del.addEventListener('click', () => {
        URL.revokeObjectURL(p.url);
        state.pending.splice(i, 1);
        renderPending();
      });
      cell.appendChild(img);
      cell.appendChild(del);
      box.appendChild(cell);
    });
  }

  async function addPending(fileList) {
    for (const f of fileList) {
      if (!f || !f.type.startsWith('image/')) continue;
      const blob = await shrinkImage(f, 1600, 0.82);
      state.pending.push({ blob, url: URL.createObjectURL(blob) });
    }
    renderPending();
  }

  function initSheet() {
    $('#sheet-close').addEventListener('click', closeSheet);
    $('#sheet-backdrop').addEventListener('click', closeSheet);

    // 端末差を避けるため、カメラとライブラリの入口を分けて明示的に開く
    $('#btn-camera').addEventListener('click', () => $('#photo-camera').click());
    $('#btn-library').addEventListener('click', () => $('#photo-library').click());
    $('#photo-camera').addEventListener('change', async (e) => {
      await addPending(e.target.files); e.target.value = '';
    });
    $('#photo-library').addEventListener('change', async (e) => {
      await addPending(e.target.files); e.target.value = '';
    });

    $('#visit-save').addEventListener('click', async () => {
      if (!state.selected) return;
      const spotId = spotIdOf(state.selected.code);
      const photoIds = [];
      for (const p of state.pending) {
        photoIds.push(await Store.putPhoto(p.blob));
      }
      await Store.addVisit({
        spotId,
        category: CATEGORY,
        name: state.selected.name,
        visitedAt: $('#visit-date').value || new Date().toISOString().slice(0, 10),
        memo: $('#visit-memo').value.trim(),
        coords: state.selected.coords,
        photoIds,
      });
      state.visited = await Store.getVisitedSpotIds();
      refreshMap(); renderList(); renderProgress();
      await renderVisitList(spotId);
      $('#visit-memo').value = '';
      clearPending();
      toast(state.selected.name + ' を記録しました');
    });
  }

  // 写真を端末側に残す。
  // Webから写真ライブラリへ直接書き込むAPIは存在しないので、
  // ①共有シート（実機のiOS/Androidはこれが使える。「画像を保存」でカメラロールに入る）
  // ②ダウンロード（共有が無い環境のフォールバック。iOSは"ファイル"、Androidはダウンロードへ）
  // の順で試す。
  function photoFileName(visit) {
    return `meguri-${(visit.name || 'photo')}-${visit.visitedAt || ''}.jpg`
      .replace(/[\\/:*?"<>|]/g, '_');
  }

  function canSharePhoto(photo, visit) {
    if (!navigator.canShare || !navigator.share) return false;
    try {
      const f = new File([photo.blob], photoFileName(visit),
        { type: photo.type || 'image/jpeg' });
      return navigator.canShare({ files: [f] });
    } catch (e) { return false; }
  }

  async function sharePhoto(photo, visit) {
    if (!canSharePhoto(photo, visit)) {
      toast('この端末は写真の共有に対応していません。「保存」を使ってください');
      return;
    }
    const file = new File([photo.blob], photoFileName(visit),
      { type: photo.type || 'image/jpeg' });
    try {
      await navigator.share({ files: [file], title: visit.name || 'めぐりログ' });
    } catch (e) {
      if (e && e.name === 'AbortError') return;   // ユーザーが閉じただけ
      toast('共有できませんでした。「保存」を使ってください');
    }
  }

  function downloadPhoto(photo, visit) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(photo.blob);
    a.download = photoFileName(visit);
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    toast('保存しました。端末の「ダウンロード」を確認してください');
  }

  // 写真は長辺1600pxまで縮めてから保存する。
  // 原寸のままだと1枚5MB前後になり、端末の保存容量をすぐ使い切るため。
  function shrinkImage(file, maxSide, quality) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
        const w = Math.round(img.width * scale);
        const h = Math.round(img.height * scale);
        const cv = document.createElement('canvas');
        cv.width = w; cv.height = h;
        cv.getContext('2d').drawImage(img, 0, 0, w, h);
        cv.toBlob((b) => resolve(b || file), 'image/jpeg', quality);
        URL.revokeObjectURL(img.src);
      };
      img.onerror = () => resolve(file);
      img.src = URL.createObjectURL(file);
    });
  }

  // ---------------------------------------------------------------
  // 一覧・進捗
  // ---------------------------------------------------------------
  function renderProgress() {
    const total = state.features.length;
    const done = state.features.filter((f) => state.visited.has(spotIdOf(f.properties.code))).length;
    const pct = total ? Math.round((done / total) * 100) : 0;
    $('#progress-text').textContent = `${done} / ${total} 制覇（${pct}%）`;
    $('#progress-bar').style.width = pct + '%';
  }

  function renderList() {
    const box = $('#list');
    box.innerHTML = '';
    const sorted = state.features.slice().sort((a, b) => a.properties.code - b.properties.code);
    for (const f of sorted) {
      const id = spotIdOf(f.properties.code);
      const done = state.visited.has(id);
      const row = document.createElement('button');
      row.className = 'row' + (done ? ' row--done' : '');
      row.innerHTML = `<span class="row__mark">${done ? '●' : '○'}</span>
                       <span class="row__name">${f.properties.name}</span>
                       <span class="row__go">記録</span>`;
      row.addEventListener('click', () => {
        switchTab('map');
        const b = L.geoJSON(f).getBounds();
        state.map.fitBounds(b, { padding: [20, 20] });
        openSheet(f.properties.code);
      });
      box.appendChild(row);
    }
  }

  // ---------------------------------------------------------------
  // タブ
  // ---------------------------------------------------------------
  function switchTab(name) {
    $$('.tab').forEach((b) => b.classList.toggle('is-active', b.dataset.tab === name));
    $$('.panel').forEach((p) => p.classList.toggle('is-active', p.id === 'panel-' + name));
    if (name === 'map' && state.map) setTimeout(() => state.map.invalidateSize(), 50);
  }

  function initTabs() {
    $$('.tab').forEach((b) => b.addEventListener('click', () => switchTab(b.dataset.tab)));
  }

  // ---------------------------------------------------------------
  // 設定（書き出し・読み込み）
  // ---------------------------------------------------------------
  function initSettings() {
    $('#btn-export').addEventListener('click', async () => {
      const data = await Store.exportAll();
      const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `meguri-log-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    });

    $('#btn-import').addEventListener('click', () => $('#import-file').click());

    $('#import-file').addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      try {
        const data = JSON.parse(await file.text());
        const r = await Store.importAll(data, { merge: true });
        state.visited = await Store.getVisitedSpotIds();
        refreshMap(); renderList(); renderProgress();
        toast(`読み込みました（記録${r.visits}件・写真${r.photos}枚）`);
      } catch (err) {
        toast('読み込めませんでした: ' + err.message);
      }
      e.target.value = '';
    });

    $('#btn-clear').addEventListener('click', async () => {
      if (!confirm('すべての記録を削除します。よろしいですか？\nこの操作は取り消せません。')) return;
      if (!confirm('本当に削除しますか？ 先に「書き出し」でバックアップを取ることを強くおすすめします。')) return;
      await Store.clearAll();
      state.visited = new Set();
      refreshMap(); renderList(); renderProgress();
      toast('削除しました');
    });

    renderDeviceInfo();

    Store.estimate().then((est) => {
      if (!est) return;
      const mb = (n) => (n / 1024 / 1024).toFixed(1) + ' MB';
      $('#storage-info').textContent = `使用量の目安: ${mb(est.usage || 0)} / 空き ${mb(est.quota || 0)}`;
    });
  }

  // 端末の対応状況。写真保存がうまくいかないときの切り分けに使う。
  function renderDeviceInfo() {
    const box = $('#device-info');
    if (!box) return;
    let canFiles = false;
    try {
      const f = new File([new Blob(['x'], { type: 'image/jpeg' })], 't.jpg', { type: 'image/jpeg' });
      canFiles = !!(navigator.canShare && navigator.canShare({ files: [f] }));
    } catch (e) { canFiles = false; }

    const ua = navigator.userAgent;
    const isIOS = /iPhone|iPad|iPod/.test(ua) ||
      (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    const isAndroid = /Android/.test(ua);
    const osName = isIOS ? 'iPhone / iPad' : (isAndroid ? 'Android' : 'パソコンなど');

    const rows = [
      ['アプリのバージョン', APP_VERSION],
      ['端末の種類', osName],
      ['写真の共有', canFiles ? '使えます' : '使えません'],
      ['位置情報', ('geolocation' in navigator) ? '使えます' : '使えません'],
      ['オフライン起動', ('serviceWorker' in navigator) ? '使えます' : '使えません'],
    ];

    let advice;
    if (isIOS && canFiles) {
      advice = '「共有」を押すと共有シートが開きます。その中の「画像を保存」でカメラロールに入ります。';
    } else if (isAndroid) {
      advice = 'Androidの共有シートには「画像を保存」という項目がありません。' +
        '端末に残すときは「保存」を押してください。ダウンロードフォルダに入ります。' +
        'カメラロールに確実に入れたい場合は、端末の標準カメラで撮ってから「写真から選ぶ」が確実です。';
    } else if (!canFiles) {
      advice = 'この端末は写真の共有に対応していません。「保存」を使ってください。';
    } else {
      advice = '「共有」か「保存」のどちらかで写真を取り出せます。';
    }

    box.innerHTML = '';
    rows.forEach(([k, v]) => {
      const r = document.createElement('div');
      r.className = 'diag__row';
      r.innerHTML = `<span>${k}</span><b>${v}</b>`;
      box.appendChild(r);
    });
    const p = document.createElement('p');
    p.className = 'diag__advice';
    p.textContent = advice;
    box.appendChild(p);
  }

  // ---------------------------------------------------------------
  // 更新の受け取り
  // 端末に古い画面が残り続ける事故を防ぐため、
  // ①起動時に更新を確認 ②画面に戻るたびに確認 ③新版が来たら画面上で知らせて即適用
  // の3段構えにする。
  // ---------------------------------------------------------------
  function initServiceWorker() {
    if (!('serviceWorker' in navigator)) return;

    navigator.serviceWorker.register('./sw.js').then((reg) => {
      reg.update().catch(() => {});

      // 表示に戻ったときにも更新を確認する（アプリを開きっぱなしの人向け）
      document.addEventListener('visibilitychange', () => {
        if (!document.hidden) reg.update().catch(() => {});
      });

      if (reg.waiting) showUpdateBar(reg.waiting);

      reg.addEventListener('updatefound', () => {
        const sw = reg.installing;
        if (!sw) return;
        sw.addEventListener('statechange', () => {
          // 既に動いている版がある状態で新版が待機に入った＝更新あり
          if (sw.state === 'installed' && navigator.serviceWorker.controller) {
            showUpdateBar(sw);
          }
        });
      });
    }).catch(() => {});

    let reloaded = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (reloaded) return;
      reloaded = true;
      location.reload();
    });
  }

  function showUpdateBar(worker) {
    if ($('#update-bar')) return;
    const bar = document.createElement('div');
    bar.id = 'update-bar';
    bar.className = 'updatebar';
    const msg = document.createElement('span');
    msg.textContent = '新しいバージョンがあります';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'updatebar__btn';
    btn.textContent = '更新する';
    btn.addEventListener('click', () => {
      btn.disabled = true;
      btn.textContent = '更新中…';
      worker.postMessage('skip-waiting');
    });
    bar.appendChild(msg);
    bar.appendChild(btn);
    document.body.appendChild(bar);
  }

  // ---------------------------------------------------------------
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.add('is-on');
    clearTimeout(toast._timer);
    toast._timer = setTimeout(() => t.classList.remove('is-on'), 2600);
  }

  window.addEventListener('DOMContentLoaded', () => {
    boot().catch((e) => {
      console.error(e);
      alert('起動に失敗しました: ' + e.message);
    });
    initServiceWorker();
  });
})();
