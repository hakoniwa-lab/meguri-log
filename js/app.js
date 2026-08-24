/*
  app.js — めぐりログ 本体

  Phase 1: 都道府県 / 市区町村の制覇 ＋ 町丁目の記録
  データの読み書きは storage.js の Store 経由でしか行わない（クラウド差し替えのため）。
*/
(() => {
  'use strict';

  // sw.js の VERSION と必ず揃えること。設定画面に表示され、
  // 端末に届いている版を目視で確認できるようにしている。
  const APP_VERSION = 'v14';

  // 国土地理院の逆ジオコーディング（APIキー不要）。
  // 町丁目・大字は約20万区域あり、境界データを配ると100MB超になって実用にならない。
  // 「塗る」のをあきらめて「記録する」だけにすれば、データ量ゼロで丁目まで扱える。
  const REVGEO = 'https://mreversegeocoder.gsi.go.jp/reverse-geocoder/LonLatToAddress';

  // 8地方区分。コードの範囲で持つと、市区町村コードの先頭2桁からそのまま引ける。
  const REGIONS = [
    { key: 'all',  label: 'すべて', min: 1,  max: 47 },
    { key: 'hok',  label: '北海道', min: 1,  max: 1  },
    { key: 'toh',  label: '東北',   min: 2,  max: 7  },
    { key: 'kan',  label: '関東',   min: 8,  max: 14 },
    { key: 'chu',  label: '中部',   min: 15, max: 23 },
    { key: 'kin',  label: '近畿',   min: 24, max: 30 },
    { key: 'cgk',  label: '中国',   min: 31, max: 35 },
    { key: 'sik',  label: '四国',   min: 36, max: 39 },
    { key: 'kyu',  label: '九州・沖縄', min: 40, max: 47 },
  ];

  // 訪問の目的タグ。「何で行ったか」を一目で分かるようにするためのもの。
  // 項目を増やすと記録が億劫になるので、1つだけ・任意入力にしている。
  const TAGS = [
    { key: '',      mark: '📍', label: '未設定' },
    { key: 'work',  mark: '💼', label: '仕事' },
    { key: 'play',  mark: '🎡', label: '遊び' },
    { key: 'castle',mark: '🏯', label: '城' },
    { key: 'statn', mark: '🚉', label: '駅' },
    { key: 'shrine',mark: '⛩️', label: '神社' },
    { key: 'temple',mark: '🛕', label: 'お寺' },
    { key: 'food',  mark: '🍽️', label: '食事' },
    { key: 'home',  mark: '🏠', label: '帰省' },
    { key: 'other', mark: '✳️', label: 'その他' },
  ];
  const tagOf = (k) => TAGS.find((t) => t.key === (k || '')) || TAGS[0];

  const LEVELS = {
    pref: { label: '都道府県', file: './data/prefectures.geojson', total: 47 },
    city: { label: '市区町村', file: './data/municipalities.geojson', total: 1902 },
  };

  const state = {
    level: 'pref',
    geo: { pref: null, city: null },   // 読み込んだGeoJSON（cityは初回切替時に取得）
    layer: null,
    map: null,
    here: null,
    selected: null,
    pending: [],
    visited: { pref: new Set(), city: new Set() },
    chomeCount: 0,
    loadingCity: false,
    pins: null,         // 記録ピンのレイヤー
    pinsOn: true,
    region: 'all',
    openGroups: new Set(),   // 一覧で開いている都道府県
    editing: null,      // 編集中の記録（nullなら新規記録）
    histMode: 'visits', // 記録タブの表示（visits / chome / stats）
    histShown: 0,
  };

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.prototype.slice.call(document.querySelectorAll(sel));

  const spotIdOf = (level, code) => level + '-' + code;

  // 配布元のGeoJSONはコード順に並んでいるとは限らない（都道府県版は京都府が先頭だった）。
  // 一覧の見出しは「並んでいること」が前提なので、読み込んだ直後に必ず並べ替える。
  function sortByCode(gj) {
    if (gj && Array.isArray(gj.features)) {
      gj.features.sort((a, b) =>
        parseInt(a.properties.code, 10) - parseInt(b.properties.code, 10));
    }
    return gj;
  }

  // 都道府県コード（1〜47）を取り出す。市区町村コードは先頭2桁がそれにあたる。
  const prefCodeOf = (level, code) =>
    level === 'pref' ? parseInt(code, 10) : parseInt(String(code).slice(0, 2), 10);

  function regionOf(prefCode) {
    return REGIONS.find((r) => r.key !== 'all' && prefCode >= r.min && prefCode <= r.max);
  }

  // ---------------------------------------------------------------
  // 起動
  // ---------------------------------------------------------------
  async function boot() {
    await Store.init();
    state.geo.pref = sortByCode(await fetch(LEVELS.pref.file).then((r) => r.json()));
    await refreshVisited();

    initMap();
    initTabs();
    initLevelSwitch();
    initSheet();
    initHistory();
    initSettings();
    renderList();
    renderProgress();
    initServiceWorker();
  }

  // 訪問済みの集合を作り直す。
  // 市区町村を記録していれば、その都道府県も当然訪れているので合成する
  // （幻の記録を作らず、集計だけで導く）。
  async function refreshVisited() {
    const all = await Store.getAllVisits();
    const pref = new Set();
    const city = new Set();
    const chome = new Set();
    for (const v of all) {
      if (v.category === 'pref') pref.add(v.spotId);
      if (v.category === 'city') {
        city.add(v.spotId);
        const code = String(v.spotId).replace(/^city-/, '');
        if (code.length >= 2) pref.add('pref-' + parseInt(code.slice(0, 2), 10));
      }
      if (v.address && v.address.lv01Nm) {
        chome.add((v.address.muniCd || '') + '/' + v.address.lv01Nm);
      }
    }
    state.visited.pref = pref;
    state.visited.city = city;
    state.chomeCount = chome.size;
  }

  // ---------------------------------------------------------------
  // 地図
  // ---------------------------------------------------------------
  function initMap() {
    state.map = L.map('map', { zoomControl: true }).setView([37.5, 137.5], 5);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 18,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    }).addTo(state.map);

    drawLayer();
    renderPins();
    $('#btn-pins').addEventListener('click', () => {
      state.pinsOn = !state.pinsOn;
      $('#btn-pins').classList.toggle('is-off', !state.pinsOn);
      renderPins();
    });
    $('#btn-here').addEventListener('click', () => locate(false));
    $('#btn-here-record').addEventListener('click', () => locate(true));
  }

  function styleFor(feat) {
    const done = state.visited[state.level].has(spotIdOf(state.level, feat.properties.code));
    return {
      color: '#2c3e62',
      weight: state.level === 'city' ? 0.5 : 1,
      fillColor: done ? '#e8a33d' : '#c9d2e0',
      fillOpacity: done ? 0.75 : 0.35,
    };
  }

  function drawLayer() {
    if (state.layer) {
      state.map.removeLayer(state.layer);
      state.layer = null;
    }
    const gj = state.geo[state.level];
    if (!gj) return;
    state.layer = L.geoJSON(gj, {
      style: styleFor,
      onEachFeature: (feat, layer) => {
        layer.on('click', () => openSheet(state.level, feat.properties.code));
        layer.bindTooltip(feat.properties.name, { sticky: true });
      },
    }).addTo(state.map);
  }

  function refreshMap() {
    if (state.layer) state.layer.setStyle(styleFor);
    renderPins();
  }

  // 記録のピン。座標を持つ記録だけを、タグの記号つきで置く。
  async function renderPins() {
    if (!state.map) return;
    if (state.pins) { state.map.removeLayer(state.pins); state.pins = null; }
    if (!state.pinsOn) return;

    const all = await Store.getAllVisits();
    const withCoords = all.filter((v) => v.coords && typeof v.coords.lat === 'number');
    if (!withCoords.length) return;

    const group = L.layerGroup();
    for (const v of withCoords) {
      const t = tagOf(v.tag);
      const icon = L.divIcon({
        className: 'pin',
        html: '<span class="pin__mark">' + t.mark + '</span>',
        iconSize: [34, 34],
        iconAnchor: [17, 34],
        popupAnchor: [0, -30],
      });
      const m = L.marker([v.coords.lat, v.coords.lng], { icon });
      const lines = [
        '<b>' + escapeHtml(v.name || '') + '</b>',
        escapeHtml(v.visitedAt || '') + (t.key ? ' ・ ' + t.label : ''),
      ];
      if (v.address && v.address.lv01Nm) lines.push(escapeHtml(v.address.lv01Nm));
      if (v.memo) lines.push(escapeHtml(v.memo));
      m.bindPopup(lines.join('<br>'));
      group.addLayer(m);
    }
    state.pins = group.addTo(state.map);
  }

  function escapeHtml(t) {
    return String(t).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  // 2MBあるので起動時には読まない。市区町村に切り替えたときだけ取りに行く。
  async function ensureLevelData(level) {
    if (state.geo[level]) return true;
    if (level === 'city' && state.loadingCity) return false;
    if (level === 'city') state.loadingCity = true;
    toast('市区町村の地図を読み込んでいます…');
    try {
      state.geo[level] = sortByCode(await fetch(LEVELS[level].file).then((r) => r.json()));
      return true;
    } catch (e) {
      toast('地図データを読み込めませんでした');
      return false;
    } finally {
      state.loadingCity = false;
    }
  }

  function initLevelSwitch() {
    $$('.lvbtn').forEach((b) => {
      b.addEventListener('click', async () => {
        const lv = b.dataset.level;
        if (lv === state.level) return;
        if (!(await ensureLevelData(lv))) return;
        state.level = lv;
        $$('.lvbtn').forEach((x) => x.classList.toggle('is-active', x.dataset.level === lv));
        drawLayer();
        renderList();
        renderProgress();
      });
    });
  }

  // ---------------------------------------------------------------
  // 現在地
  // ---------------------------------------------------------------
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
      async (pos) => {
        restore();
        const { latitude: lat, longitude: lng } = pos.coords;
        if (state.here) state.map.removeLayer(state.here);
        state.here = L.circleMarker([lat, lng], {
          radius: 8, color: '#c0392b', fillColor: '#e74c3c', fillOpacity: 0.9, weight: 2,
        }).addTo(state.map);
        state.map.setView([lat, lng], openRecord ? (state.level === 'city' ? 11 : 9) : 12);

        if (openRecord) {
          // ★常に市区町村（いちばん細かい単位）で記録する★
          // 都道府県の表示のまま記録すると市区町村側に何も残らなかった。
          // 市区町村さえ記録すれば都道府県は集計で埋まるので、一度で両方そろう。
          const ok = await ensureLevelData('city');
          const cityFeat = ok ? findAt('city', lat, lng) : null;
          if (cityFeat) {
            openSheet('city', cityFeat.properties.code, { lat, lng });
            return;
          }
          // 市区町村を特定できなかったとき（読み込み失敗・離島など）は表示中の単位で記録する
          const fb = findAt(state.level, lat, lng);
          if (fb) openSheet(state.level, fb.properties.code, { lat, lng });
          else toast('現在地は日本の範囲外のようです');
          return;
        }

        {
          const feat = findAt(state.level, lat, lng);
          if (!feat) {
            toast('現在地は日本の範囲外のようです');
            return;
          }
          const done = state.visited[state.level].has(spotIdOf(state.level, feat.properties.code));
          toast(feat.properties.name + (done ? '（記録済み）' : '（未記録）'));
        }
      },
      (err) => {
        restore();
        toast(err.code === 1
          ? '位置情報の利用が許可されていません。ブラウザの設定から許可してください'
          : '現在地を取得できませんでした');
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
      if (((yi > lat) !== (yj > lat)) &&
          (lng < (xj - xi) * (lat - yi) / (yj - yi) + xi)) inside = !inside;
    }
    return inside;
  }

  function findAt(level, lat, lng) {
    const gj = state.geo[level];
    if (!gj) return null;
    for (const f of gj.features) {
      for (const poly of f.geometry.coordinates) {
        if (pointInRing(lng, lat, poly[0])) return f;
      }
    }
    return null;
  }

  // 町丁目・大字を住所文字列として取得する。通信できないときは何も返さない。
  async function reverseGeocode(lat, lng) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 8000);
      const r = await fetch(`${REVGEO}?lat=${lat}&lon=${lng}`, { signal: ctrl.signal });
      clearTimeout(t);
      const j = await r.json();
      const res = j && j.results;
      if (res && res.lv01Nm) return { muniCd: res.muniCd || '', lv01Nm: res.lv01Nm };
    } catch (e) { /* 圏外・失敗時は住所なしで記録する */ }
    return null;
  }

  // ---------------------------------------------------------------
  // 記録シート
  // ---------------------------------------------------------------
  function featureByCode(level, code) {
    const gj = state.geo[level];
    if (!gj) return null;
    return gj.features.find((f) => String(f.properties.code) === String(code));
  }

  async function openSheet(level, code, coords) {
    const feat = featureByCode(level, code);
    if (!feat) return;
    state.selected = {
      level, code: String(code), name: feat.properties.name,
      coords: coords || null, address: null,
    };

    $('#sheet-title').textContent = feat.properties.name;
    $('#sheet-sub').textContent = LEVELS[level].label +
      (feat.properties.pref ? ' / ' + feat.properties.pref : '') +
      (level === 'city' && feat.properties.pref ? '（都道府県もあわせて記録されます）' : '');
    $('#visit-date').value = new Date().toISOString().slice(0, 10);
    $('#visit-memo').value = '';
    setTagValue('');
    clearPending();
    $('#sheet-coords').textContent = coords
      ? `現在地: ${coords.lat.toFixed(4)}, ${coords.lng.toFixed(4)}`
      : '座標は記録されません（地図から選択）';

    await renderVisitList(spotIdOf(level, code));
    $('#sheet').classList.add('is-open');

    // 住所の取得は画面表示を待たせない（取れたら後から差し込む）
    if (coords) {
      $('#sheet-address').textContent = '町丁目を調べています…';
      const addr = await reverseGeocode(coords.lat, coords.lng);
      if (state.selected && state.selected.code === String(code)) {
        state.selected.address = addr;
        $('#sheet-address').textContent = addr
          ? '町丁目: ' + addr.lv01Nm
          : '町丁目: 取得できませんでした（圏外でも記録はできます）';
      }
    } else {
      $('#sheet-address').textContent = '';
    }
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
      head.innerHTML = `<b>${tagOf(v.tag).mark} ${v.visitedAt}</b>`;
      const del = document.createElement('button');
      del.className = 'linkbtn';
      del.textContent = '削除';
      del.addEventListener('click', async () => {
        if (!confirm('この記録を削除しますか？')) return;
        await Store.deleteVisit(v.id);
        await refreshVisited();
        refreshMap(); renderList(); renderProgress();
        await renderVisitList(spotId);
      });
      const edit = document.createElement('button');
      edit.className = 'linkbtn linkbtn--edit';
      edit.textContent = '編集';
      edit.addEventListener('click', () => startEdit(v));
      head.appendChild(edit);
      head.appendChild(del);
      row.appendChild(head);

      if (v.address && v.address.lv01Nm) {
        const a = document.createElement('p');
        a.className = 'visit__addr';
        a.textContent = v.address.lv01Nm;
        row.appendChild(a);
      }
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
    state.editing = null;
    const bar = $('#edit-bar'); if (bar) bar.classList.remove('is-on');
    const sv = $('#visit-save'); if (sv) sv.textContent = 'この訪問を記録する';
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

  // 既存の記録を読み込んで編集モードに入る。
  // その場で書いたメモしか残せないと後から直せないため、日付・メモ・写真を後編集できるようにする。
  async function startEdit(visit) {
    clearPending();                       // 先に new/edit 状態をまっさらにする
    state.editing = visit;

    $('#visit-date').value = visit.visitedAt || new Date().toISOString().slice(0, 10);
    $('#visit-memo').value = visit.memo || '';
    setTagValue(visit.tag || '');

    // 既存の写真は existingId 付きで pending に載せる。
    // 触らなければ同じIDのまま保存され、×を押したものだけが外れる。
    for (const pid of (visit.photoIds || [])) {
      const ph = await Store.getPhoto(pid);
      if (!ph) continue;
      state.pending.push({ blob: ph.blob, url: URL.createObjectURL(ph.blob), existingId: pid });
    }
    renderPending();

    $('#visit-save').textContent = 'この内容で更新する';
    const bar = $('#edit-bar');
    if (bar) {
      bar.classList.add('is-on');
      $('#edit-bar-text').textContent = (visit.visitedAt || '') + ' の記録を編集中';
    }
    $('.sheet__body').scrollTop = 0;
  }

  async function addPending(fileList) {
    for (const f of fileList) {
      if (!f || !f.type.startsWith('image/')) continue;
      const blob = await shrinkImage(f, 1600, 0.82);
      state.pending.push({ blob, url: URL.createObjectURL(blob) });
    }
    renderPending();
  }

  // ---- 目的タグ ----
  function initTagPicker() {
    const box = $('#tag-picker');
    if (!box || box.childElementCount) return;
    TAGS.forEach((t) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'tagbtn' + (t.key === '' ? ' is-active' : '');
      b.dataset.tag = t.key;
      b.innerHTML = '<span>' + t.mark + '</span>' + t.label;
      b.addEventListener('click', () => setTagValue(t.key));
      box.appendChild(b);
    });
  }

  function setTagValue(key) {
    $$('#tag-picker .tagbtn').forEach((b) =>
      b.classList.toggle('is-active', b.dataset.tag === (key || '')));
  }

  function getTagValue() {
    const on = $('#tag-picker .tagbtn.is-active');
    return on ? on.dataset.tag : '';
  }

  function initSheet() {
    initTagPicker();
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

    $('#edit-cancel').addEventListener('click', () => {
      clearPending();
      $('#visit-date').value = new Date().toISOString().slice(0, 10);
      $('#visit-memo').value = '';
    });

    $('#visit-save').addEventListener('click', async () => {
      if (!state.selected) return;
      const sel = state.selected;
      const spotId = spotIdOf(sel.level, sel.code);

      // 既存写真は元のIDを使い回し、新しく足したものだけ保存する
      const photoIds = [];
      for (const p of state.pending) {
        photoIds.push(p.existingId || await Store.putPhoto(p.blob));
      }

      if (state.editing) {
        const v = state.editing;
        // 編集で外された写真は本体からも消す（孤児レコードを残さない）
        for (const old of (v.photoIds || [])) {
          if (!photoIds.includes(old)) await Store.deletePhoto(old);
        }
        await Store.updateVisit(Object.assign({}, v, {
          visitedAt: $('#visit-date').value || v.visitedAt,
          memo: $('#visit-memo').value.trim(),
          tag: getTagValue(),
          photoIds,
          updatedAt: new Date().toISOString(),
        }));
      } else {
        await Store.addVisit({
          spotId,
          category: sel.level,
          name: sel.name,
          visitedAt: $('#visit-date').value || new Date().toISOString().slice(0, 10),
          memo: $('#visit-memo').value.trim(),
          tag: getTagValue(),
          coords: sel.coords,
          address: sel.address,
          photoIds,
        });
      }
      await refreshVisited();
      refreshMap(); renderList(); renderProgress();
      await renderVisitList(spotId);
      const wasEditing = !!state.editing;
      $('#visit-memo').value = '';
      clearPending();
      toast(sel.name + (wasEditing ? ' の記録を更新しました' : ' を記録しました'));
    });
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

  // ---- 写真の取り出し ----
  function photoFileName(visit) {
    return `meguri-${(visit.name || 'photo')}-${visit.visitedAt || ''}.jpg`
      .replace(/[\\/:*?"<>|]/g, '_');
  }

  function canSharePhoto(photo, visit) {
    if (!navigator.canShare || !navigator.share) return false;
    try {
      const f = new File([photo.blob], photoFileName(visit), { type: photo.type || 'image/jpeg' });
      return navigator.canShare({ files: [f] });
    } catch (e) { return false; }
  }

  async function sharePhoto(photo, visit) {
    if (!canSharePhoto(photo, visit)) {
      toast('この端末は写真の共有に対応していません。「端末に保存」を使ってください');
      return;
    }
    const file = new File([photo.blob], photoFileName(visit), { type: photo.type || 'image/jpeg' });
    try {
      await navigator.share({ files: [file], title: visit.name || 'めぐりログ' });
    } catch (e) {
      if (e && e.name === 'AbortError') return;
      toast('共有できませんでした。「端末に保存」を使ってください');
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

  // ---------------------------------------------------------------
  // 一覧・進捗
  // ---------------------------------------------------------------
  function renderProgress() {
    const lv = state.level;
    const total = state.geo[lv] ? state.geo[lv].features.length : LEVELS[lv].total;
    const done = state.visited[lv].size;
    const pct = total ? Math.round((done / total) * 100) : 0;
    $('#progress-text').textContent =
      `${LEVELS[lv].label} ${done} / ${total} 制覇（${pct}%）`;
    $('#progress-bar').style.width = pct + '%';

    const sub = [];
    sub.push(`都道府県 ${state.visited.pref.size}/47`);
    sub.push(`市区町村 ${state.visited.city.size}/${LEVELS.city.total}`);
    sub.push(`町丁目 ${state.chomeCount}`);
    $('#progress-sub').textContent = sub.join(' ・ ');
  }

  function renderRegionChips() {
    const box = $('#regions');
    if (!box || box.childElementCount) return;
    REGIONS.forEach((r) => {
      const b = document.createElement('button');
      b.className = 'rgbtn' + (r.key === state.region ? ' is-active' : '');
      b.dataset.region = r.key;
      b.textContent = r.label;
      b.addEventListener('click', () => {
        state.region = r.key;
        $$('.rgbtn').forEach((x) => x.classList.toggle('is-active', x.dataset.region === r.key));
        renderList();
      });
      box.appendChild(b);
    });
  }

  function renderList() {
    renderRegionChips();
    const box = $('#list');
    const gj = state.geo[state.level];
    box.innerHTML = '';
    if (!gj) {
      box.innerHTML = '<p class="muted" style="padding:12px">地図データを読み込んでください。</p>';
      return;
    }
    const q = (($('#list-filter') || {}).value || '').trim();
    const onlyTodo = !!(($('#only-todo') || {}).checked);
    const reg = REGIONS.find(function (r) { return r.key === state.region; }) || REGIONS[0];

    const feats = gj.features.filter(function (f) {
      const pc = prefCodeOf(state.level, f.properties.code);
      if (!(pc >= reg.min && pc <= reg.max)) return false;
      if (q && !((f.properties.name || '').includes(q) ||
                 (f.properties.pref || '').includes(q))) return false;
      if (onlyTodo && state.visited[state.level].has(spotIdOf(state.level, f.properties.code))) return false;
      return true;
    });

    if (!feats.length) {
      box.innerHTML = '<p class="muted" style="padding:12px">該当がありません。</p>';
      return;
    }

    // 都道府県の一覧は47件しかないので、そのまま地方の見出しで区切って全部出す。
    if (state.level === 'pref') {
      let last = null;
      for (const f of feats) {
        const r = regionOf(prefCodeOf('pref', f.properties.code));
        const g = r ? r.label : '';
        if (g !== last) {
          box.appendChild(groupHeader(g, feats.filter(function (x) {
            const rr = regionOf(prefCodeOf('pref', x.properties.code));
            return (rr ? rr.label : '') === g;
          })));
          last = g;
        }
        box.appendChild(makeRow(f));
      }
      return;
    }

    // 市区町村は1,902件あるので、都道府県ごとに畳んで出す。
    // 県名だけが並ぶので「関東にどの県があるか」がひと目で分かり、
    // 見たい県をタップしたときだけ中身が開く。
    const byPref = new Map();
    for (const f of feats) {
      const k = f.properties.pref || '';
      if (!byPref.has(k)) byPref.set(k, []);
      byPref.get(k).push(f);
    }

    // 検索中は隠れていると見つけられないので、該当する県は自動で開く
    const autoOpen = !!q;

    byPref.forEach(function (items, pref) {
      const opened = autoOpen || state.openGroups.has(pref);
      const head = groupHeader(pref, items, true, opened);
      box.appendChild(head);

      const wrap = document.createElement('div');
      wrap.className = 'group__body';
      if (!opened) wrap.style.display = 'none';
      else items.forEach(function (f) { wrap.appendChild(makeRow(f)); });
      box.appendChild(wrap);

      head.addEventListener('click', function () {
        const isOpen = wrap.style.display !== 'none';
        if (isOpen) {
          wrap.style.display = 'none';
          wrap.innerHTML = '';
          state.openGroups.delete(pref);
          head.classList.remove('is-open');
        } else {
          items.forEach(function (f) { wrap.appendChild(makeRow(f)); });
          wrap.style.display = '';
          state.openGroups.add(pref);
          head.classList.add('is-open');
        }
      });
    });
  }

  function groupHeader(label, items, foldable, opened) {
    const h = document.createElement('div');
    h.className = 'group' + (foldable ? ' group--fold' : '') + (opened ? ' is-open' : '');
    const done = items.filter(function (x) {
      return state.visited[state.level].has(spotIdOf(state.level, x.properties.code));
    }).length;
    const left = document.createElement('span');
    left.className = 'group__label';
    if (foldable) {
      const caret = document.createElement('i');
      caret.className = 'group__caret';
      left.appendChild(caret);
    }
    left.appendChild(document.createTextNode(label));
    const right = document.createElement('small');
    right.textContent = done + ' / ' + items.length;
    h.appendChild(left);
    h.appendChild(right);
    return h;
  }

  function makeRow(f) {
    const lv = state.level;
    const id = spotIdOf(lv, f.properties.code);
    const done = state.visited[lv].has(id);
    const row = document.createElement('button');
    row.className = 'row' + (done ? ' row--done' : '');
    const sub = lv === 'city' ? `<small class="row__pref">${f.properties.pref || ''}</small>` : '';
    row.innerHTML = `<span class="row__mark">${done ? '●' : '○'}</span>
                     <span class="row__name">${f.properties.name}${sub}</span>
                     <span class="row__go">記録</span>`;
    row.addEventListener('click', () => {
      switchTab('map');
      state.map.fitBounds(L.geoJSON(f).getBounds(), { padding: [20, 20] });
      openSheet(lv, f.properties.code);
    });
    return row;
  }

  // ---------------------------------------------------------------
  // 記録タブ（見返し）
  // 地点を選ばないと記録が見えず、集めたものを振り返れなかったので独立させた。
  // ---------------------------------------------------------------
  const HIST_PAGE = 30;   // 写真を伴うので少なめに出し、「続きを表示」で伸ばす

  async function renderHistory(reset) {
    const box = $('#history');
    if (reset) state.histShown = 0;
    const all = await Store.getAllVisits();

    if (state.histMode === 'chome') { renderChomeList(box, all); return; }
    if (state.histMode === 'stats') { renderStats(box, all); return; }

    const q = (($('#hist-filter') || {}).value || '').trim();
    const photoOnly = !!(($('#hist-photo-only') || {}).checked);

    let visits = all.filter(function (v) {
      if (photoOnly && !(v.photoIds && v.photoIds.length)) return false;
      if (!q) return true;
      const hay = [v.name, v.memo, v.address && v.address.lv01Nm, v.visitedAt]
        .filter(Boolean).join(' ');
      return hay.includes(q);
    });
    // 新しい順。同じ日なら後から登録したものを上に。
    visits.sort(function (a, b) {
      return (b.visitedAt || '').localeCompare(a.visitedAt || '') ||
             (b.createdAt || '').localeCompare(a.createdAt || '');
    });

    const photos = all.reduce(function (n, v) { return n + (v.photoIds || []).length; }, 0);
    $('#hist-summary').textContent = all.length
      ? '記録 ' + all.length + '件 ・ 写真 ' + photos + '枚' +
        ((q || photoOnly) ? '（表示 ' + visits.length + '件）' : '')
      : '';

    box.innerHTML = '';
    if (!visits.length) {
      box.innerHTML = all.length
        ? '<p class="muted" style="padding:12px">該当がありません。</p>'
        : '<p class="muted" style="padding:12px">まだ記録がありません。地図から場所をタップして記録してみてください。</p>';
      return;
    }

    // 月が変わるところに見出しを挟む。件数が増えたときに時期で辿れるようにするため。
    let lastMonth = null;
    const monthOf = function (v) { return (v.visitedAt || '').slice(0, 7); };
    const draw = async function (before) {
      const frag = document.createDocumentFragment();
      const slice = visits.slice(state.histShown, state.histShown + HIST_PAGE);
      for (const v of slice) {
        const mo = monthOf(v);
        if (mo && mo !== lastMonth) {
          const h = document.createElement('div');
          h.className = 'group';
          const cnt = visits.filter(function (x) { return monthOf(x) === mo; }).length;
          const sp = document.createElement('span');
          sp.textContent = mo.replace('-', '年') + '月';
          const sm = document.createElement('small');
          sm.textContent = cnt + '件';
          h.appendChild(sp); h.appendChild(sm);
          frag.appendChild(h);
          lastMonth = mo;
        }
        frag.appendChild(await makeHistCard(v));
      }
      state.histShown += slice.length;
      if (before) box.insertBefore(frag, before); else box.appendChild(frag);
    };
    await draw(null);

    if (state.histShown < visits.length) {
      const more = document.createElement('button');
      more.className = 'btn btn--sub more';
      more.textContent = '続きを表示（残り ' + (visits.length - state.histShown) + ' 件）';
      more.addEventListener('click', async function () {
        await draw(more);
        if (state.histShown >= visits.length) more.remove();
        else more.textContent = '続きを表示（残り ' + (visits.length - state.histShown) + ' 件）';
      });
      box.appendChild(more);
    }
  }

  async function makeHistCard(v) {
    const card = document.createElement('div');
    card.className = 'hcard';

    const head = document.createElement('div');
    head.className = 'hcard__head';
    const b = document.createElement('b');
    b.textContent = tagOf(v.tag).mark + ' ' + (v.name || '');
    const sm = document.createElement('small');
    sm.textContent = v.visitedAt || '';
    head.appendChild(b);
    head.appendChild(sm);
    card.appendChild(head);

    const label = LEVELS[v.category] ? LEVELS[v.category].label : (v.category || '');
    const tg = tagOf(v.tag);
    const metaText = [label, tg.key ? tg.label : null, v.address && v.address.lv01Nm]
      .filter(Boolean).join(' ・ ');
    if (metaText) {
      const meta = document.createElement('p');
      meta.className = 'hcard__meta';
      meta.textContent = metaText;
      card.appendChild(meta);
    }

    if (v.memo) {
      const m = document.createElement('p');
      m.className = 'hcard__memo';
      m.textContent = v.memo;
      card.appendChild(m);
    }

    if (v.photoIds && v.photoIds.length) {
      const strip = document.createElement('div');
      strip.className = 'hcard__photos';
      for (const pid of v.photoIds) {
        const ph = await Store.getPhoto(pid);
        if (!ph) continue;
        const img = document.createElement('img');
        img.src = URL.createObjectURL(ph.blob);
        img.addEventListener('load', function () { URL.revokeObjectURL(img.src); }, { once: true });
        strip.appendChild(img);
      }
      card.appendChild(strip);
    }

    // カードから、その地点の記録シートへ直接飛べるようにする
    card.addEventListener('click', async function () {
      const lv = v.category;
      if (!LEVELS[lv]) return;
      const ok = await ensureLevelData(lv);
      if (!ok) return;
      const code = String(v.spotId).slice(lv.length + 1);
      if (state.level !== lv) {
        state.level = lv;
        $$('.lvbtn').forEach(function (x) {
          x.classList.toggle('is-active', x.dataset.level === lv);
        });
        drawLayer();
        renderProgress();
      }
      switchTab('map');
      const f = featureByCode(lv, code);
      if (f) state.map.fitBounds(L.geoJSON(f).getBounds(), { padding: [20, 20] });
      openSheet(lv, code);
    });
    return card;
  }

  // 町丁目は塗り分けができない代わりに、行った場所を一覧で見られるようにする
  function renderChomeList(box, all) {
    const map = new Map();
    for (const v of all) {
      if (!(v.address && v.address.lv01Nm)) continue;
      const key = (v.address.muniCd || '') + '/' + v.address.lv01Nm;
      const rec = map.get(key) || { name: v.address.lv01Nm, city: v.name || '', dates: [] };
      rec.dates.push(v.visitedAt || '');
      map.set(key, rec);
    }
    const q = (($('#hist-filter') || {}).value || '').trim();
    let items = Array.from(map.values());
    if (q) items = items.filter(function (it) { return (it.name + it.city).includes(q); });
    items.sort(function (a, b) {
      return (a.city + a.name).localeCompare(b.city + b.name, 'ja');
    });

    $('#hist-summary').textContent = map.size
      ? '町丁目 ' + map.size + '件' + (q ? '（表示 ' + items.length + '件）' : '')
      : '';

    box.innerHTML = '';
    if (!items.length) {
      box.innerHTML = '<p class="muted" style="padding:12px">町丁目の記録がありません。「ここを記録」で現在地から記録すると自動で入ります（通信が必要です）。</p>';
      return;
    }
    let lastCity = null;
    for (const it of items) {
      if (it.city !== lastCity) {
        const h = document.createElement('div');
        h.className = 'group';
        const cnt = items.filter(function (x) { return x.city === it.city; }).length;
        const sp = document.createElement('span');
        sp.textContent = it.city;
        const sm = document.createElement('small');
        sm.textContent = cnt + '件';
        h.appendChild(sp);
        h.appendChild(sm);
        box.appendChild(h);
        lastCity = it.city;
      }
      const row = document.createElement('div');
      row.className = 'hrow';
      const n = document.createElement('span');
      n.className = 'hrow__name';
      n.textContent = it.name;
      row.appendChild(n);
      if (it.dates.length > 1) {
        const t = document.createElement('small');
        t.textContent = it.dates.length + '回';
        row.appendChild(t);
      }
      box.appendChild(row);
    }
  }

  // まとめ。集めたものが数字で見えると続けやすくなる。
  function renderStats(box, all) {
    $('#hist-summary').textContent = '';
    box.innerHTML = '';
    if (!all.length) {
      box.innerHTML = '<p class="muted" style="padding:12px">まだ記録がありません。</p>';
      return;
    }

    const photos = all.reduce(function (n, v) { return n + (v.photoIds || []).length; }, 0);
    const chome = new Set();
    const months = new Map();
    const tags = new Map();
    let withCoords = 0;
    let first = null, last = null;
    for (const v of all) {
      if (v.address && v.address.lv01Nm) chome.add((v.address.muniCd || '') + '/' + v.address.lv01Nm);
      const mo = (v.visitedAt || '').slice(0, 7);
      if (mo) months.set(mo, (months.get(mo) || 0) + 1);
      const tk = v.tag || '';
      tags.set(tk, (tags.get(tk) || 0) + 1);
      if (v.coords) withCoords++;
      const d = v.visitedAt || '';
      if (d && (!first || d < first)) first = d;
      if (d && (!last || d > last)) last = d;
    }

    const card = function (title, rows) {
      const c = document.createElement('div');
      c.className = 'card';
      const h = document.createElement('h2');
      h.textContent = title;
      c.appendChild(h);
      rows.forEach(function (r) {
        const line = document.createElement('div');
        line.className = 'diag__row';
        const a = document.createElement('span'); a.textContent = r[0];
        const b = document.createElement('b'); b.textContent = r[1];
        line.appendChild(a); line.appendChild(b);
        c.appendChild(line);
      });
      box.appendChild(c);
      return c;
    };

    card('集めたもの', [
      ['都道府県', state.visited.pref.size + ' / 47'],
      ['市区町村', state.visited.city.size + ' / ' + LEVELS.city.total],
      ['町丁目', chome.size + ' か所'],
      ['記録', all.length + ' 件'],
      ['写真', photos + ' 枚'],
      ['位置つきの記録', withCoords + ' 件'],
    ]);

    if (first && last) {
      card('期間', [['最初の記録', first], ['最新の記録', last]]);
    }

    // 目的タグの内訳（多い順・0件は出さない）
    const tagRows = TAGS
      .filter(function (t) { return tags.get(t.key); })
      .sort(function (a, b) { return tags.get(b.key) - tags.get(a.key); })
      .map(function (t) { return [t.mark + ' ' + t.label, tags.get(t.key) + ' 件']; });
    if (tagRows.length) card('何で行ったか', tagRows);

    // 月別（新しい順に12か月分）
    const moRows = Array.from(months.entries())
      .sort(function (a, b) { return b[0].localeCompare(a[0]); })
      .slice(0, 12)
      .map(function (e) { return [e[0].replace('-', '年') + '月', e[1] + ' 件']; });
    if (moRows.length) card('月ごとの記録', moRows);
  }

  function initHistory() {
    $$('#hist-modes .rgbtn').forEach(function (b) {
      b.addEventListener('click', function () {
        state.histMode = b.dataset.hmode;
        $$('#hist-modes .rgbtn').forEach(function (x) {
          x.classList.toggle('is-active', x.dataset.hmode === state.histMode);
        });
        const only = $('#hist-photo-only').closest('.filter__only');
        if (only) only.style.display = (state.histMode === 'visits') ? '' : 'none';
        const fil = $('#hist-filter');
        if (fil) fil.style.display = (state.histMode === 'stats') ? 'none' : '';
        renderHistory(true);
      });
    });
    let t = null;
    $('#hist-filter').addEventListener('input', function () {
      clearTimeout(t);
      t = setTimeout(function () { renderHistory(true); }, 180);
    });
    $('#hist-photo-only').addEventListener('change', function () { renderHistory(true); });
  }

  // ---------------------------------------------------------------
  // タブ
  // ---------------------------------------------------------------
  function switchTab(name) {
    $$('.tab').forEach((b) => b.classList.toggle('is-active', b.dataset.tab === name));
    $$('.panel').forEach((p) => p.classList.toggle('is-active', p.id === 'panel-' + name));
    if (name === 'map' && state.map) setTimeout(() => state.map.invalidateSize(), 50);
    if (name === 'history') renderHistory(true);
  }

  function initTabs() {
    $$('.tab').forEach((b) => b.addEventListener('click', () => switchTab(b.dataset.tab)));

    let timer = null;
    const onFilter = () => { clearTimeout(timer); timer = setTimeout(renderList, 180); };
    const fi = $('#list-filter');
    if (fi) fi.addEventListener('input', onFilter);
    const ot = $('#only-todo');
    if (ot) ot.addEventListener('change', renderList);
  }

  // ---------------------------------------------------------------
  // 設定
  // ---------------------------------------------------------------
  function initSettings() {
    $('#btn-export').addEventListener('click', async () => {
      const data = await Store.exportAll();
      const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `meguri-log-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    });

    $('#btn-import').addEventListener('click', () => $('#import-file').click());

    $('#import-file').addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      try {
        const data = JSON.parse(await file.text());
        const r = await Store.importAll(data, { merge: true });
        await refreshVisited();
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
      await refreshVisited();
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
        '端末に残すときは「端末に保存」を押してください。ダウンロードフォルダに入ります。' +
        'カメラロールに確実に入れたい場合は、端末の標準カメラで撮ってから「写真から選ぶ」が確実です。';
    } else if (!canFiles) {
      advice = 'この端末は写真の共有に対応していません。「端末に保存」を使ってください。';
    } else {
      advice = '「共有」か「端末に保存」のどちらかで写真を取り出せます。';
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
  // ---------------------------------------------------------------
  function initServiceWorker() {
    if (!('serviceWorker' in navigator)) return;

    navigator.serviceWorker.register('./sw.js').then((reg) => {
      reg.update().catch(() => {});
      document.addEventListener('visibilitychange', () => {
        if (!document.hidden) reg.update().catch(() => {});
      });
      if (reg.waiting) showUpdateBar(reg.waiting);
      reg.addEventListener('updatefound', () => {
        const sw = reg.installing;
        if (!sw) return;
        sw.addEventListener('statechange', () => {
          if (sw.state === 'installed' && navigator.serviceWorker.controller) showUpdateBar(sw);
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
  });
})();
