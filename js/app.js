/*
  app.js — めぐログ 本体

  Phase 1: 都道府県 / 市区町村の制覇 ＋ 町丁目の記録
  データの読み書きは storage.js の Store 経由でしか行わない（クラウド差し替えのため）。
*/
(() => {
  'use strict';

  // sw.js の VERSION と必ず揃えること。設定画面に表示され、
  // 端末に届いている版を目視で確認できるようにしている。
  const APP_VERSION = 'v34';

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
  // ★key は保存済みの記録が参照している。key は変えない（label だけなら安全に変えられる）★
  // 並び順は表示の順。既存のタグは位置を動かさず、新しいものを近い仲間の隣に足している
  // （並びが変わると、いつも押している場所が変わって押し間違える）。
  // ⚠ `mtn` `onsen` は MARK_KINDS にも同じ key がある。一括置換をすると
  //    片方だけ直すつもりがもう片方に入り、気づきにくい。
  const TAGS = [
    { key: '',      mark: '📍', label: '未設定' },
    { key: 'work',  mark: '💼', label: '仕事' },
    { key: 'play',  mark: '🎡', label: '遊び' },
    { key: 'trip',  mark: '🧳', label: '旅行' },
    { key: 'stay',  mark: '🏨', label: '宿・ホテル' },
    { key: 'castle',mark: '🏯', label: '城' },
    { key: 'statn', mark: '🚉', label: '駅' },
    { key: 'air',   mark: '✈️', label: '空港' },
    { key: 'port',  mark: '⛴️', label: '港・フェリー' },
    { key: 'shrine',mark: '⛩️', label: '神社' },
    { key: 'temple',mark: '📿', label: 'お寺' },
    { key: 'shop',  mark: '🛍️', label: '買い物' },
    { key: 'conv',  mark: '🏪', label: 'コンビニ' },
    { key: 'food',  mark: '🍽️', label: '食事' },
    { key: 'michi', mark: '🛣️', label: '道の駅' },
    { key: 'sapa',  mark: '🅿️', label: 'SA・PA' },
    { key: 'park',  mark: '🚗', label: '駐車場' },
    { key: 'toilet',mark: '🚻', label: 'トイレ' },
    { key: 'mtn',   mark: '⛰️', label: '山・登山' },
    { key: 'dam',   mark: '🌊', label: 'ダム' },
    { key: 'onsen', mark: '♨️', label: '温泉・銭湯' },
    { key: 'home',  mark: '🏠', label: '実家・知人宅' },
    { key: 'other', mark: '✳️', label: 'その他' },
  ];
  const tagOf = (k) => TAGS.find((t) => t.key === (k || '')) || TAGS[0];

  // 地図の種類。訪問済みを塗ると標準の地図では地名が読めなくなるので、淡色を選べるようにする。
  // 国土地理院のタイルは日本の外には無いので、選ばれている間は引きの限界を 5 で止める
  // （止めないと日本の外まで引いたときに真っ白な画面になり、壊れたように見える）。
  const MAP_STYLES = [
    {
      key: 'osm', label: '標準', minZoom: 3, maxZoom: 18,
      url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
      attr: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    },
    {
      key: 'pale', label: '淡色', minZoom: 5, maxZoom: 18, maxNativeZoom: 16,
      url: 'https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png',
      attr: '<a href="https://maps.gsi.go.jp/development/ichiran.html">国土地理院</a>',
    },
    {
      key: 'photo', label: '航空写真', minZoom: 5, maxZoom: 18,
      url: 'https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/{z}/{x}/{y}.jpg',
      attr: '<a href="https://maps.gsi.go.jp/development/ichiran.html">国土地理院</a>',
    },
  ];
  const styleOf = (k) => MAP_STYLES.find((m) => m.key === k) || MAP_STYLES[0];

  const DAYS = ['月', '火', '水', '木', '金', '土', '日', '不定休'];
  // 集めるものは御朱印だけではない。御城印・御船印なども同じ枠で記録する。
  // 既存の記録には kind が無いので、未設定は「御朱印」として扱う（GS_KIND[0]）。
  const GS_KIND = ['御朱印', '御城印', '御船印', '鉄印', 'その他'];
  const gsKindOf = (g) => (g && g.kind) || GS_KIND[0];
  const GS_WRITE = ['直書き', '書き置き'];
  const GS_FORM = ['通常', '見開き', '切り絵'];

  const LEVELS = {
    pref: { label: '都道府県', file: './data/prefectures.geojson', total: 47 },
    city: { label: '市区町村', file: './data/municipalities.geojson', total: 1902 },
  };

  const state = {
    level: 'pref',
    fillOn: true,          // 訪問済みの塗り分けを出すか
    placeIndex: null,      // 場所検索の索引（GeoJSONぶん。重いので一度だけ作る）
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
    placeCache: null,   // まとめ済みの場所（ズームのたびに読み直さないため）
    tiles: null,        // 地図タイルのレイヤー
    mapStyle: 'osm',    // 地図の種類（標準／淡色／航空写真）
    layersOpen: false,  // 表示パネルを開いているか
    pickTags: new Set(),   // 「選んで書き出す」で選ばれたタグ
    pickFile: null,        // 共有用に先に作っておく、選んだ分のファイル
    pickTimer: null,
    pickSeq: 0,
    lines: null,        // 移動の線のレイヤー
    linesOn: true,
    lineDay: null,      // 表示する日（nullは全部）。既定は最新の日
    lineDayPicked: false,  // ユーザーが自分で日を選んだか
    shareType: null,       // この端末の共有シートが受け付ける形式
    backupFile: null,      // 共有用に先に作っておくバックアップ
    backupBuilding: false,
    marks: null,        // ランドマークのレイヤー
    marksOn: false,     // 通信するので既定はオフ
    marksLoading: false,
    marksKey: '',       // 直近に取得した範囲（同じ範囲を二重に取りに行かない）
    markKinds: null,    // 表示するランドマークの種類（nullなら全部）
    markCache: null,    // 取得済みの生データ（種類の切替は再取得せず描き直すだけ）
    markCacheKinds: null,
    marksPending: false,
    marksTimer: null,
    region: 'all',
    openGroups: new Set(),   // 一覧で開いている都道府県
    editing: null,      // 編集中の記録（nullなら新規記録）
    lastPlace: null,    // 同じ地点の前回の場所情報（引き継ぎ用）
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
    state.mapStyle = (await Store.getMeta('mapStyle')) || 'osm';
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
    applyMapStyle(state.mapStyle);
    buildStyleChips();

    drawLayer();
    renderPins();
    renderDayLines();
    buildMarkKindChips();
    fitMapHeight();
    watchMapHeight();
    // 上に出る行（絞り込みチップなど）が増減すると地図の高さが変わる
    window.addEventListener('resize', fitMapHeight);
    window.addEventListener('orientationchange', () => setTimeout(fitMapHeight, 250));

    initLayersPanel();
    // ズームが変わるとピンのまとめ方も変わる。読み直しはせず描き直すだけ
    state.map.on('zoomend', () => drawPins());

    $('#btn-marks').addEventListener('click', () => {
      state.marksOn = !state.marksOn;
      setToggle('#btn-marks', state.marksOn);
      $('#mark-kinds').hidden = !state.marksOn;
      showSearchArea(false);
      fitMapHeight();
      renderLandmarks(true);
      if (!state.marksOn) toast('ランドマークを隠します');
    });
    // 地図を動かしても勝手には取りに行かない。「この範囲で探す」を出して、
    // 押されたときだけ探す。いつ検索しているかが分かり、提供元への負荷も減る。
    state.map.on('moveend', () => {
      state.markCache = null;   // 範囲が変わったら取り直す
      if (state.marksOn) showSearchArea(true);
    });

    // 一覧にもOSMにも無い場所は、地図を長押しして自分で登録する。
    // Leafletは長押し・右クリックの両方で contextmenu を出す。
    state.map.on('contextmenu', (e) => {
      recordAtPoint(e.latlng.lat, e.latlng.lng);
    });

    $('#btn-lines').addEventListener('click', () => {
      state.linesOn = !state.linesOn;
      setToggle('#btn-lines', state.linesOn);
      const ld = $('#line-days');
      if (ld && !state.linesOn) ld.hidden = true;
      renderDayLines();
      fitMapHeight();
      toast(state.linesOn ? '移動の線を表示します' : '移動の線を隠します');
    });
    $('#btn-pins').addEventListener('click', () => {
      state.pinsOn = !state.pinsOn;
      setToggle('#btn-pins', state.pinsOn);
      renderPins();
      toast(state.pinsOn ? '記録のピンを表示します' : '記録のピンを隠します');
    });
    const now = $('#btn-now');
    if (now) now.addEventListener('click', () => {
      $('#visit-date').value = todayLocal();
      $('#visit-time').value = nowTimeLocal();
    });

    // 訪問済みの色を消す。地図そのものを読みたいときに使う。
    $('#btn-fill').addEventListener('click', () => {
      state.fillOn = !state.fillOn;
      setToggle('#btn-fill', state.fillOn);
      if (state.layer) state.layer.setStyle(styleFor);
      toast(state.fillOn ? '訪問済みの色を出します' : '訪問済みの色を隠します');
    });

    // 「この範囲で探す」。押したときだけランドマークを取りに行く。
    $('#btn-search-area').addEventListener('click', () => {
      showSearchArea(false);
      renderLandmarks(true);
    });

    initMapSearch();
    $('#btn-here').addEventListener('click', () => locate(false));
    $('#btn-here-record').addEventListener('click', () => locate(true));
  }

  // 表示の切り替え。オン・オフの見た目を1か所で決める（行ごとに書くとズレる）
  function setToggle(sel, on) {
    const el = $(sel);
    if (!el) return;
    el.classList.toggle('is-off', !on);
    el.setAttribute('aria-pressed', on ? 'true' : 'false');
  }

  function initLayersPanel() {
    const btn = $('#btn-layers');
    const box = $('#layers-panel');
    if (!btn || !box) return;
    ['#btn-pins', '#btn-lines', '#btn-fill'].forEach((sel) => setToggle(sel, true));
    setToggle('#btn-marks', state.marksOn);

    btn.addEventListener('click', (e) => { e.stopPropagation(); openLayers(!state.layersOpen); });
    // パネルの中を押しても閉じない。閉じるのは外を押したときだけ
    box.addEventListener('click', (e) => e.stopPropagation());
    // 地図を触ったら閉じる。開いたままだと地図の右下が隠れる
    state.map.on('click', () => openLayers(false));
    state.map.on('movestart', () => openLayers(false));
    document.addEventListener('click', () => openLayers(false));
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') openLayers(false); });
  }

  function openLayers(on) {
    const box = $('#layers-panel');
    const btn = $('#btn-layers');
    if (!box || state.layersOpen === on) return;
    state.layersOpen = on;
    box.hidden = !on;
    if (btn) btn.setAttribute('aria-expanded', on ? 'true' : 'false');
  }

  // 地図の種類を差し替える。タイルだけ入れ替え、記録のピンや塗り分けはそのまま残す。
  function applyMapStyle(key) {
    const st = styleOf(key);
    state.mapStyle = st.key;
    if (state.tiles) { state.map.removeLayer(state.tiles); state.tiles = null; }
    state.tiles = L.tileLayer(st.url, {
      minZoom: st.minZoom,
      maxZoom: st.maxZoom,
      maxNativeZoom: st.maxNativeZoom || st.maxZoom,
      attribution: st.attr,
    }).addTo(state.map);
    // 地理院のタイルは日本の外に無い。引きの限界を上げて真っ白を避ける
    state.map.setMinZoom(st.minZoom);
    if (state.map.getZoom() < st.minZoom) state.map.setZoom(st.minZoom);
    $$('#map-styles .mstyle').forEach((b) => b.classList.toggle('is-on', b.dataset.style === st.key));
  }

  function buildStyleChips() {
    const box = $('#map-styles');
    if (!box) return;
    box.innerHTML = '';
    MAP_STYLES.forEach((m) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'mstyle' + (m.key === state.mapStyle ? ' is-on' : '');
      b.dataset.style = m.key;
      b.textContent = m.label;
      b.addEventListener('click', () => {
        if (m.key === state.mapStyle) return;
        applyMapStyle(m.key);
        Store.setMeta('mapStyle', m.key);
      });
      box.appendChild(b);
    });
  }

  // 地図の高さ。固定値（100vh - 230px）にしていたため、上に出る行が増えると
  // 地図の下側が画面からはみ出していた。
  //
  // 上に並ぶ行を1つずつ数えるのではなく、「地図の下（説明文の下端）が画面の
  // 下にちょうど来るように、はみ出したぶんを足し引きする」やり方にする。
  // 数える対象が増えても数え漏らさず、行が増減しても同じ式で収まる。
  // 引数を取らない入口。イベントの listener に直接渡しても回数が壊れないようにする
  function fitMapHeight() { fitMapPass(0); }

  function fitMapPass(pass) {
    const el = $('#map');
    const panel = $('#panel-map');
    const hint = panel && panel.querySelector('.hint');
    if (!el || !hint || !panel.classList.contains('is-active')) return;
    if (!window.innerHeight) return;             // 画面が無い（裏に回った直後など）
    const cur = el.getBoundingClientRect().height;
    // ★下限はCSSの min-height から読む★
    // ここに数字を書くと、CSS側を変えたときに食い違う。min-height は height に
    // 勝つので、食い違うと「300pxにしたつもりが実際は320px」となり、
    // 収まるまで測り直す処理が永遠に終わらない。
    const floor = parseFloat(getComputedStyle(el).minHeight) || 0;
    // スクロール位置に左右されないよう、文書内の位置で測る
    const bottom = hint.getBoundingClientRect().bottom + window.scrollY;
    const h = Math.max(floor, Math.round(cur + (window.innerHeight - bottom)));
    if (Math.abs(h - cur) < 1) return;          // 収まった
    el.style.height = h + 'px';
    if (state.map) state.map.invalidateSize();
    // 高さを変えた拍子に説明文の折り返しが変わることがあり、一度では合わない。
    // 収まるまで数回だけ測り直す（収まった時点で上の return で止まる）。
    // requestAnimationFrame は画面が裏に回っていると呼ばれないので使わない
    // （裏で開き直したときに、地図の高さが合わないまま止まる）。
    if (pass < 4) setTimeout(() => fitMapPass(pass + 1), 60);
  }

  // 上の行は、文字の折り返しやフォントの読み込みで後から高さが変わる。
  // 初回に測っただけだと、その変化ぶんだけ地図がずれたままになる。
  function watchMapHeight() {
    const targets = ['.hero', '.tabs', '.levels', '#mark-kinds', '#line-days', '.mapsearch', '#panel-map .hint'];
    if (typeof ResizeObserver === 'function') {
      // 監視するのは地図より上と下の行だけ。地図自身を入れると、
      // 高さを変える→通知が来る→また変える、と回り続ける
      const ro = new ResizeObserver(() => fitMapHeight());
      targets.forEach((sel) => { const e = $(sel); if (e) ro.observe(e); });
    }
    window.addEventListener('load', fitMapHeight);
    // 裏に回っている間は画面の高さが取れず測れない。戻ってきたら測り直す
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) fitMapHeight();
    });
    // 起動直後は進捗の文字などが後から入って上の高さが変わる
    setTimeout(fitMapHeight, 120);
  }

  function styleFor(feat) {
    // 塗りを消したいとき。訪問済みが増えると地図が色で埋まって地名が読めなくなる。
    // 境界だけ薄く残す（消すとタップできる範囲が分からなくなるため）。
    if (!state.fillOn) {
      return { color: '#2c3e62', weight: 0.5, opacity: 0.3, fillOpacity: 0 };
    }
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
    renderDayLines();
  }

  // 移動の線。同じ日に記録した地点を、記録した順に結ぶ。
  // 実際の道なりではない（Webでは背面で位置を取り続けられないため）。
  // それでも「その日どこを回ったか」は十分に見える。
  async function renderDayLines() {
    if (!state.map) return;
    if (state.lines) { state.map.removeLayer(state.lines); state.lines = null; }
    if (!state.linesOn) { const b = $('#line-days'); if (b) b.hidden = true; return; }

    const all = await Store.getAllVisits();
    const byDay = new Map();
    for (const v of all) {
      if (!(v.coords && typeof v.coords.lat === 'number')) continue;
      const d = v.visitedAt || '';
      if (!d) continue;
      if (!byDay.has(d)) byDay.set(d, []);
      byDay.get(d).push(v);
    }

    // 線になる日（2か所以上）を新しい順に並べ、切り替えのチップを作る
    const dayList = Array.from(byDay.entries())
      .filter(function (e) { return e[1].length >= 2; })
      .map(function (e) { return e[0]; })
      .sort(function (a, b) { return b.localeCompare(a); });

    // 何日分も重なると「その日どこを回ったか」が読めないので、既定は最新の1日だけ。
    // 自分で日を選ぶまでは最新の日に追従する（開いたまま今日の記録を足しても線が出るように）。
    if (dayList.length) {
      if (!state.lineDayPicked) state.lineDay = dayList[0];
      else if (state.lineDay && !dayList.includes(state.lineDay)) state.lineDay = dayList[0];
    }
    buildLineDayChips(dayList);

    const group = L.layerGroup();
    let drawn = 0;
    byDay.forEach(function (items, day) {
      if (items.length < 2) return;           // 1点だけの日は線にならない
      if (state.lineDay && day !== state.lineDay) return;
      // 記録した順（createdAt）に並べる。visitedAtは日付だけなので順序を持たない。
      items.sort(function (a, b) {
        return (a.createdAt || '').localeCompare(b.createdAt || '');
      });
      const pts = items.map(function (v) { return [v.coords.lat, v.coords.lng]; });
      const line = L.polyline(pts, {
        color: '#2c3e62', weight: 3, opacity: 0.75,
        dashArray: '7 6', lineCap: 'round', lineJoin: 'round',
      });
      line.bindPopup(day + ' の移動（' + items.length + 'か所）');
      group.addLayer(line);
      drawn++;
    });
    if (drawn) state.lines = group.addTo(state.map);
  }

  // ---- ランドマーク（OpenStreetMapから取得）----
  // 城・駅・神社・お寺を地図に出す。自前でデータを持たず、表示中の範囲だけ取りに行く。
  // 公開のOverpassは混雑しやすい。1台に固執せず、順に試す。
  const OVERPASS = [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
    'https://overpass.openstreetmap.ru/api/interpreter',
    'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  ];
  const OVERPASS_TIMEOUT = 15000;
  const MARK_LIMIT = 500;                   // 1回に受け取る上限。多すぎると地図が重い
  // OSMは有志が編集しているので、タグの付け方に揺れがある。条件を厳しくすると
  // 「知っている場所が出ない」が起きるため、実際に使われている書き方を広めに拾う。
  // qs は Overpass のクエリ。同じ文字列は1回にまとめて投げる（神社とお寺は同じ問い合わせ）。
  const MARK_KINDS = [
    { key: 'castle', mark: '🏯', label: '城',   tag: 'castle',
      qs: ['nwr["historic"~"^(castle|fort)$"]', 'nwr["ruins"="castle"]'] },
    { key: 'statn',  mark: '🚉', label: '駅',   tag: 'statn',
      qs: ['nwr["railway"~"^(station|halt)$"]'] },
    // religion の付け忘れが多いので、religion では絞らずに取ってきて kindOf で振り分ける
    { key: 'shrine', mark: '⛩️', label: '神社', tag: 'shrine',
      qs: ['nwr["amenity"="place_of_worship"]'] },
    { key: 'temple', mark: '📿', label: 'お寺', tag: 'temple',
      qs: ['nwr["amenity"="place_of_worship"]'] },
    { key: 'mtn',    def: false, mark: '⛰️', label: '山',   tag: 'mtn',
      qs: ['nwr["natural"~"^(peak|volcano)$"]'] },
    { key: 'onsen',  def: false, mark: '♨️', label: '温泉・銭湯', tag: 'onsen',
      qs: ['nwr["natural"="hot_spring"]', 'nwr["amenity"="public_bath"]'] },
    { key: 'dam', def: false,    mark: '🌊', label: 'ダム', tag: 'dam',
      qs: ['nwr["waterway"="dam"]'] },
  ];

  async function fetchLandmarks(bounds) {
    const s0 = bounds.getSouth().toFixed(4), w0 = bounds.getWest().toFixed(4);
    const n0 = bounds.getNorth().toFixed(4), e0 = bounds.getEast().toFixed(4);
    const bbox = `(${s0},${w0},${n0},${e0})`;
    // 選んだ種類だけ問い合わせる。表示が減るだけでなく通信量と待ち時間も減る。
    const kinds = MARK_KINDS.filter((k) => !state.markKinds || state.markKinds.has(k.key));
    if (!kinds.length) return [];
    // 神社とお寺は同じ問い合わせなので、重複を除いて1回だけ投げる
    const qs = [];
    for (const k of kinds) for (const q of k.qs) if (!qs.includes(q)) qs.push(q);
    const body = '[out:json][timeout:25];(' +
      qs.map((q) => q + bbox + ';').join('') +
      ');out center tags ' + MARK_LIMIT + ';';

    for (const url of OVERPASS) {
      // fetchは放っておくと待ち続けるので、必ず打ち切る
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), OVERPASS_TIMEOUT);
      try {
        const r = await fetch(url, {
          method: 'POST',
          body: 'data=' + encodeURIComponent(body),
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          signal: ctrl.signal,
        });
        clearTimeout(timer);
        if (!r.ok) continue;
        const j = await r.json();
        if (j && j.elements) return j.elements;
      } catch (e) {
        clearTimeout(timer);   // タイムアウト・CORS拒否・通信断はすべて次のミラーへ
      }
    }
    return null;
  }

  // 「この範囲で探す」の出し入れ。ランドマークを消したら一緒に隠す。
  function showSearchArea(on) {
    const b = $('#btn-search-area');
    if (!b) return;
    b.hidden = !(on && state.marksOn);
    b.disabled = false;
    b.textContent = 'この範囲で探す';
  }

  // ---- 場所検索 ----
  // 手元にあるものだけを探す（通信しない）。
  //   1. 自分の記録（場所の名前・地名・メモ）
  //   2. 読み込み済みの都道府県／市区町村
  // 市区町村は初回だけ2MBを読むので、検索されたときに読みに行く。
  function initMapSearch() {
    const q = $('#map-q'), hits = $('#map-hits'), x = $('#map-q-clear');
    if (!q) return;
    let timer = null;

    let lastVisits = [];          // 探した結果に「もう行った」を出すための控え
    // ★探している途中で打ち直されたら、古い結果は捨てる★
    // 記録の読み出しもインターネットの検索も待ち時間があるので、
    // 番号を控えておかないと「松本城」の結果が「金沢城」の一覧に足される。
    let seq = 0;

    const close = () => { hits.hidden = true; hits.innerHTML = ''; };
    const clear = () => { q.value = ''; x.hidden = true; close(); };
    x.addEventListener('click', clear);

    function headRow(text) {
      const d = document.createElement('div');
      d.className = 'mapsearch__head';
      d.textContent = text;
      return d;
    }

    q.addEventListener('input', () => {
      x.hidden = !q.value;
      clearTimeout(timer);
      timer = setTimeout(() => runMapSearch(q.value.trim()), 220);
    });
    q.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { clear(); return; }
      // Enter は「インターネットでも探す」の合図。1文字ごとには投げない
      if (e.key === 'Enter') { e.preventDefault(); runOnline(q.value.trim()); }
    });
    // 地図をさわったら候補を閉じる（指で隠れて邪魔になるため）
    document.addEventListener('click', (e) => {
      if (!e.target.closest('.mapsearch')) close();
    });

    // 手元にあるものだけを探す。ここでは通信しない。
    async function runMapSearch(text) {
      const mine0 = ++seq;
      if (!text) { close(); return; }
      // 市区町村まで探せたほうが役に立つので、未読なら読みに行く
      if (!state.geo.city && !state.loadingCity) await ensureLevelData('city');
      const visits = await Store.getAllVisits();
      if (mine0 !== seq) return;                 // 待っている間に打ち直された
      lastVisits = visits;
      const list = searchPlaces(text, 6, visits);
      hits.innerHTML = '';
      // ★「行ったところ」と「まだ行っていない場所」を分けて見せる★
      // 探し方は2通りある。前に行ったあそこを出したいのか、
      // これから行く場所を探しているのか。混ぜて並べるとどちらも遅くなる。
      const mine = list.filter((it) => it.src === 'visit');
      const geo = list.filter((it) => it.src !== 'visit');
      if (mine.length) {
        hits.appendChild(headRow('行ったところ（自分の記録）'));
        mine.forEach((it) => hits.appendChild(rowFor(it)));
      }
      if (geo.length) {
        hits.appendChild(headRow('地名（都道府県・市区町村）'));
        geo.forEach((it) => hits.appendChild(rowFor(it)));
      }
      if (!list.length) {
        const n = document.createElement('div');
        n.className = 'mapsearch__none';
        n.textContent = '記録と地名の中には見つかりませんでした。';
        hits.appendChild(n);
      }
      hits.appendChild(onlineRow(text));
      hits.hidden = false;
    }

    // 「地図から探す」の行。押されたときだけ通信する。
    function onlineRow(text) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'mapsearch__net';
      b.appendChild(document.createTextNode('\ud83c\udf10 「' + text + '」を地図から探す'));
      const sm = document.createElement('small');
      sm.textContent = 'お寺・城・神社・お店など。インターネットに接続します';
      b.appendChild(sm);
      b.addEventListener('click', () => runOnline(text, b));
      return b;
    }

    async function runOnline(text, btn) {
      if (!text) return;
      const mine0 = seq;
      const b = btn || hits.querySelector('.mapsearch__net');
      if (b) { b.disabled = true; b.textContent = '探しています…'; }
      hits.hidden = false;
      let list = [];
      let err = null;
      try { list = await searchOnline(text); } catch (e) { err = e; }
      if (mine0 !== seq) return;                 // 探している間に打ち直された
      // 施設名で見つからなかったときだけ、住所として探し直す。
      // 地図に登録の無い店でも、住所が分かればその場所へ飛べる。
      if (!err && !list.length && looksAddress(text)) {
        try { list = await searchAddress(text); } catch (e) { /* 出せるものが無いだけ */ }
        if (mine0 !== seq) return;
      }
      if (b) b.remove();
      hits.appendChild(headRow(
        err ? '地図から探せませんでした（電波の状態を確かめてください）'
          : (list.length ? '地図から探した場所' : '地図にも見つかりませんでした')));
      list.forEach((it) => {
        it.been = beenThere(lastVisits, it.name, it.lat, it.lng);
        hits.appendChild(rowFor(it, true));
      });
      if (!err && !list.length) {
        // 行き止まりにしない。自分で登録する道があることをその場で伝える。
        const n = document.createElement('div');
        n.className = 'mapsearch__none';
        n.textContent = '地図に登録が無い場所は出てきません。'
          + '地図を動かして、その地点を長押しすると自分で登録できます。';
        hits.appendChild(n);
      }
      hits.hidden = false;
    }

    // 候補の1行。地図から探した結果には「記録」も付ける
    // （探した名前をもう一度打ち直させないため）。
    function rowFor(it, net) {
      const jump = document.createElement('button');
      jump.type = 'button';
      jump.className = 'mapsearch__hit';
      jump.appendChild(document.createTextNode(it.name));
      if (it.been) {
        const bad = document.createElement('b');
        bad.className = 'mapsearch__been';
        bad.textContent = it.been;
        jump.appendChild(bad);
      }
      const sm = document.createElement('small');
      sm.textContent = it.sub;
      jump.appendChild(sm);
      jump.addEventListener('click', () => {
        close();
        q.blur();
        state.map.setView([it.lat, it.lng], it.zoom);
        // 動かすと「この範囲で探す」が出るので、飛んだ先ですぐ探せる
        if (state.marksOn) showSearchArea(true);
      });
      if (!net) return jump;

      const row = document.createElement('div');
      row.className = 'mapsearch__row';
      row.appendChild(jump);
      const rec = document.createElement('button');
      rec.type = 'button';
      rec.className = 'mapsearch__rec';
      rec.textContent = '記録';
      rec.addEventListener('click', () => {
        close();
        q.blur();
        state.map.setView([it.lat, it.lng], it.zoom);
        // 住所は場所の名前にならない。名前を入れてもらう側へ回す。
        if (it.kind === 'addr') recordAtPoint(it.lat, it.lng);
        else recordLandmark(it.name, { tag: it.tag || '' }, it.lat, it.lng);
      });
      row.appendChild(rec);
      return row;
    }
  }

  // ★地図から名前で探す（通信あり）★
  // 押されたときだけ投げる。1文字ごとに投げてはいけない——提供元(Nominatim)が
  // 「入力補完には使わないこと」と明記している。ここを守らないと、同じOSM系の
  // ランドマーク取得(Overpass)まで巻き添えで使えなくなる恐れがある。
  const NOMINATIM = 'https://nominatim.openstreetmap.org/search';
  let lastOnlineAt = 0;

  async function searchOnline(text) {
    const wait = 1100 - (Date.now() - lastOnlineAt);   // 1秒に1回まで
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastOnlineAt = Date.now();
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 12000);
    try {
      const url = NOMINATIM + '?q=' + encodeURIComponent(text)
        + '&countrycodes=jp&format=jsonv2&limit=8&accept-language=ja';
      const r = await fetch(url, { signal: ctrl.signal, headers: { Accept: 'application/json' } });
      if (!r.ok) throw new Error('search failed');
      const j = await r.json();
      const out = [];
      for (const it of (Array.isArray(j) ? j : [])) {
        if (isJunk(it.category, it.type)) continue;   // 信号機・バス停など
        const name = (it.name || '').trim() || String(it.display_name || '').split(',')[0].trim();
        const lat = parseFloat(it.lat), lng = parseFloat(it.lon);
        if (!name || !isFinite(lat) || !isFinite(lng)) continue;
        // 同じ名前が同じ場所に何件も返る（本体・駐輪場・交差点など）。
        // 上位のものが一番もっともらしいので、先に出た方を残す。
        if (out.some((o) => o.name === name && distMeters(o.lat, o.lng, lat, lng) <= 300)) continue;
        const tag = netTagOf(it.category, it.type, name);
        const t2 = tagOf(tag);
        out.push({
          name: name,
          sub: t2.mark + ' ' + t2.label + (addrOf(it.display_name) ? ' ・ ' + addrOf(it.display_name) : ''),
          tag: tag,
          lat: lat, lng: lng, zoom: 17,
        });
      }
      return out;
    } finally {
      clearTimeout(t);
    }
  }

  // 住所から探す（国土地理院）。
  // Nominatim は日本の番地（広垂1-1-1）をほぼ返せないが、こちらは丁目・番・号まで当てる。
  // 逆に施設名には弱い（「金沢城」で北海道当別町金沢が返る）ので、
  // ★施設名で見つからなかったときの控えにしか使わない★。
  const GSI_SEARCH = 'https://msearch.gsi.go.jp/address-search/AddressSearch';

  // 住所らしいか。番地の数字か、丁目などの語があるものだけ送る。
  // 送りすぎると「近江町市場」で山形県近江が返るような、惜しい間違いが増える。
  function looksAddress(text) {
    return /[0-9０-９]/.test(text)
      || /(丁目|番地|字)/.test(text)
      || /^(北海道|東京都|京都府|大阪府|.{2,3}県)/.test(text);
  }

  async function searchAddress(text) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 10000);
    try {
      const r = await fetch(GSI_SEARCH + '?q=' + encodeURIComponent(text), { signal: ctrl.signal });
      if (!r.ok) throw new Error('address search failed');
      const j = await r.json();
      return (Array.isArray(j) ? j : []).slice(0, 6).map((f) => {
        const c = f.geometry && f.geometry.coordinates;
        const title = (f.properties && f.properties.title || '').trim();
        if (!c || !title) return null;
        return {
          kind: 'addr',
          name: title,
          sub: '📍 住所',
          tag: '',
          lat: parseFloat(c[1]), lng: parseFloat(c[0]), zoom: 17,
        };
      }).filter((it) => it && isFinite(it.lat) && isFinite(it.lng));
    } finally {
      clearTimeout(t);
    }
  }

  // 行き先にならないものを落とす。
  // 「松本城」で探すと、同じ名前の信号機やレンタルサイクルまで返ってくる。
  const NET_SKIP_CAT = /^(highway|barrier|traffic_calming|power|boundary|landuse)$/;
  const NET_SKIP_TYPE = /^(traffic_signals|bus_stop|crossing|stop|give_way|turning_circle|street_lamp|bench|waste_basket|vending_machine|bicycle_rental|bicycle_parking|motorcycle_parking|post_box|telephone|fire_hydrant|survey_point|milestone|tree|pitch|track)$/;
  function isJunk(cat, type) {
    return NET_SKIP_CAT.test(cat || '') || NET_SKIP_TYPE.test(type || '');
  }

  // 住所は長いので、都道府県と市区町村だけ見せる。
  // 後ろから探す（前からだと「葭町」のような小字を市区町村と取り違える）。
  function addrOf(displayName) {
    const rev = String(displayName || '').split(',').map((v) => v.trim()).filter(Boolean).reverse();
    const pref = rev.find((v) => /[都道府県]$/.test(v)) || '';
    const city = rev.find((v) => v !== pref && /[市区町村]$/.test(v)) || '';
    return [pref, city].filter(Boolean).join(' ');
  }

  // 探した場所にもう行っているか。
  // 名前が一致すれば確かだが、GPSはずれるし、大きな境内のどこで
  // 記録したかにもよるので、距離だけのときは言い切らない。
  function beenThere(visits, name, lat, lng) {
    const nm = (name || '').trim();
    let near = false;
    for (const v of (visits || [])) {
      const vn = (v.place && v.place.name || '').trim();
      if (nm && vn && vn === nm) return '行った';
      if (v.coords && distMeters(v.coords.lat, v.coords.lng, lat, lng) <= 120) near = true;
    }
    return near ? '近くに記録' : '';
  }

  // 検索結果の種類を、こちらのタグに寄せる。
  // ランドマークと同じ見分け方(kindOf)を使い回し、そこで決まらないものだけ足す。
  // 決まらなければ未設定のまま出す（違うタグが付くより、空のほうが直しやすい）。
  function netTagOf(cat, type, name) {
    const k = kindOf({ [cat]: type, name: name });
    if (k) return k.tag;
    if (/^(hotel|motel|hostel|guest_house|apartment|chalet)$/.test(type)) return 'stay';
    if (/^(restaurant|cafe|fast_food|food_court|bar|pub)$/.test(type)) return 'food';
    if (type === 'convenience') return 'conv';
    if (type === 'parking') return 'park';
    if (type === 'toilets') return 'toilet';
    if (/^(aerodrome|airport|terminal)$/.test(type)) return 'air';
    if (/^(ferry_terminal|harbour|port|marina)$/.test(type)) return 'port';
    // ★名前からの見当は、確かな種類の後・大まかな種類の前に置く★
    // OSM では松本城が museum 、兵庫県の城が attraction などばらつきがある。
    // 先に大まかな種類で判定すると、城が全部「遊び」になる。
    if (/(城|城跡|城址)$/.test(name)) return 'castle';
    if (/駅$/.test(name)) return 'statn';
    if (/(空港|飛行場)$/.test(name)) return 'air';
    if (/(港|フェリーターミナル)$/.test(name)) return 'port';
    if (/(神社|神宮|大社|八幡宮|東照宮)$/.test(name)) return 'shrine';
    if (/(寺|院|大師|観音)$/.test(name)) return 'temple';
    if (/(温泉|の湯|銀湯)$/.test(name)) return 'onsen';
    if (/ダム$/.test(name)) return 'dam';
    if (/^(supermarket|department_store|mall|shop)$/.test(type)) return 'shop';
    if (/^(attraction|theme_park|zoo|aquarium|museum|park|garden)$/.test(type)) return 'play';
    return '';
  }

  // 検索の索引。GeoJSONは件数が多いので一度だけ作って使い回す。
  function buildPlaceIndex() {
    const idx = [];
    for (const lv of ['pref', 'city']) {
      const gj = state.geo[lv];
      if (!gj) continue;
      for (const f of gj.features) {
        const c = centerOfFeature(f);
        if (!c) continue;
        idx.push({
          src: 'geo',
          name: f.properties.name,
          sub: lv === 'pref' ? '都道府県' : '市区町村',
          lat: c[0], lng: c[1], zoom: lv === 'pref' ? 9 : 12,
        });
      }
    }
    return idx;
  }

  // ポリゴンのおおよその中心。全頂点の平均で足りる（正確な重心は要らない）。
  function centerOfFeature(f) {
    let sx = 0, sy = 0, n = 0;
    const eat = (ring) => { for (const p of ring) { sx += p[0]; sy += p[1]; n++; } };
    const g = f.geometry;
    if (!g) return null;
    if (g.type === 'Polygon') g.coordinates.forEach(eat);
    else if (g.type === 'MultiPolygon') g.coordinates.forEach((poly) => poly.forEach(eat));
    else return null;
    return n ? [sy / n, sx / n] : null;
  }

  function searchPlaces(text, limit, visits) {
    const t = text.toLowerCase();
    const out = [];

    // 自分の記録を先に出す。探しているのは大抵「前に行ったあそこ」なので。
    const seen = new Set();
    (visits || []).sort((a, b) => visitStamp(b).localeCompare(visitStamp(a)));
    for (const v of (visits || [])) {
      if (!v.coords) continue;
      const nm = (v.place && v.place.name || '').trim();
      const hay = [nm, v.name, v.memo, v.goshuin && v.goshuin.name]
        .filter(Boolean).join(' ').toLowerCase();
      if (hay.indexOf(t) < 0) continue;
      const label = nm || v.name || '(名前なし)';
      if (seen.has(label)) continue;
      seen.add(label);
      out.push({
        src: 'visit',
        name: label,
        sub: [tagOf(v.tag).mark + ' ' + tagOf(v.tag).label, v.name, v.visitedAt]
          .filter(Boolean).join(' ・ '),
        lat: v.coords.lat, lng: v.coords.lng, zoom: 16,
      });
      if (out.length >= limit) return out;
    }

    if (!state.placeIndex) state.placeIndex = buildPlaceIndex();
    // 前方一致を先に、次に部分一致。「金沢」で金沢市が上に来るようにする。
    const starts = [], includes = [];
    for (const it of state.placeIndex) {
      const n = it.name.toLowerCase();
      if (n.startsWith(t)) starts.push(it);
      else if (n.indexOf(t) >= 0) includes.push(it);
    }
    for (const it of starts.concat(includes)) {
      out.push(it);
      if (out.length >= limit) break;
    }
    return out;
  }

  function buildMarkKindChips() {
    const box = $('#mark-kinds');
    if (!box || box.childElementCount) return;
    // 後から足した種類は既定でオフ。全部オンにすると件数が増えて上限に当たりやすく、
    // 「一部だけ表示しています」の通知が毎回出て煩わしいため。必要な人が押して出す。
    state.markKinds = new Set(MARK_KINDS.filter((k) => k.def !== false).map((k) => k.key));
    MARK_KINDS.forEach((k) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'mkchip' + (k.def === false ? '' : ' is-on');
      b.dataset.kind = k.key;
      b.innerHTML = '<span>' + k.mark + '</span>' + k.label;
      b.addEventListener('click', () => {
        if (state.markKinds.has(k.key)) state.markKinds.delete(k.key);
        else state.markKinds.add(k.key);
        b.classList.toggle('is-on', state.markKinds.has(k.key));
        // 連続で切り替えたときに毎回取りに行かないよう、少し待ってからまとめて反映する
        clearTimeout(state.marksTimer);
        state.marksTimer = setTimeout(() => renderLandmarks(true), 350);
      });
      box.appendChild(b);
    });
  }

  const kindByKey = (k) => MARK_KINDS.find((x) => x.key === k) || null;

  function kindOf(tags) {
    if (!tags) return null;
    if (tags.historic === 'castle' || tags.historic === 'fort' || tags.ruins === 'castle') {
      return kindByKey('castle');
    }
    if (tags.railway === 'station' || tags.railway === 'halt') return kindByKey('statn');
    if (tags.natural === 'peak' || tags.natural === 'volcano') return kindByKey('mtn');
    if (tags.natural === 'hot_spring' || tags.amenity === 'public_bath') return kindByKey('onsen');
    if (tags.waterway === 'dam') return kindByKey('dam');
    if (tags.amenity === 'place_of_worship' || tags.religion) {
      if (tags.religion === 'shinto') return kindByKey('shrine');
      if (tags.religion === 'buddhist') return kindByKey('temple');
      // religion が付いていない社寺が多いので、名前から見当をつける。
      // 判断できないものは出さない（キリスト教会などを混ぜないため）。
      const n = tags.name || '';
      if (/神社|神宮|八幡|稲荷|天満|大社|東照宮|宮$/.test(n)) return kindByKey('shrine');
      if (/寺|院|庵|大師|観音|不動尊|薬師/.test(n)) return kindByKey('temple');
      return null;
    }
    return null;
  }

  async function renderLandmarks(force) {
    if (!state.map) return;
    if (!state.marksOn) {
      if (state.marks) { state.map.removeLayer(state.marks); state.marks = null; }
      return;
    }
    // 広域だと件数が膨大になるので下限を設ける。
    // 足りないときは文句を言うのではなく、こちらから寄せる。
    const MIN_ZOOM = 12;
    if (state.map.getZoom() < MIN_ZOOM) {
      if (!force) {
        if (state.marks) { state.map.removeLayer(state.marks); state.marks = null; }
        return;
      }
      state.map.setZoom(MIN_ZOOM);
      await new Promise((r) => setTimeout(r, 400));
    }
    const b = state.map.getBounds();
    const key = [b.getSouth(), b.getWest(), b.getNorth(), b.getEast()]
      .map((n) => n.toFixed(2)).join(',');

    // 取得中に要求が来たら捨てずに覚えておき、終わったあとで最新の状態で描き直す
    if (state.marksLoading) { state.marksPending = true; return; }

    // 同じ範囲を取得済みで、選んだ種類が取得済みの範囲に収まっているなら描き直すだけでよい
    const want = Array.from(state.markKinds || []).sort().join(',');
    const have = state.markCacheKinds || '';
    const subset = state.markCache && key === state.marksKey &&
      want.split(',').filter(Boolean).every((k) => have.split(',').includes(k));

    let els;
    if (subset) {
      els = state.markCache;
    } else {
      state.marksLoading = true;
      toast('ランドマークを探しています…');
      els = await fetchLandmarks(b);
      state.marksLoading = false;
      if (!els) {
        toast('ランドマークを取得できませんでした。地図の提供元が混雑しているようです');
        if (state.marksPending) { state.marksPending = false; renderLandmarks(true); }
        return;
      }
      state.markCache = els;
      state.markCacheKinds = want;
      // 上限で打ち切られると黙って一部が消える。気づけないと「出ない」と誤解するので伝える。
      if (els.length >= MARK_LIMIT) {
        toast('この範囲は数が多いため一部だけ表示しています。地図を拡大すると全部出ます');
      }
    }

    if (state.marks) { state.map.removeLayer(state.marks); state.marks = null; }
    state.marksKey = key;

    const group = L.layerGroup();
    let n = 0;
    for (const el of els) {
      const k = kindOf(el.tags);
      if (!k) continue;
      if (state.markKinds && !state.markKinds.has(k.key)) continue;
      const lat = el.lat != null ? el.lat : (el.center && el.center.lat);
      const lng = el.lon != null ? el.lon : (el.center && el.center.lon);
      if (lat == null || lng == null) continue;
      const name = (el.tags['name:ja'] || el.tags.name || '').trim();
      if (!name) continue;

      const icon = L.divIcon({
        className: 'lmark',
        html: '<span class="lmark__mark">' + k.mark + '</span>',
        iconSize: [26, 26], iconAnchor: [13, 13], popupAnchor: [0, -12],
      });
      const m = L.marker([lat, lng], { icon, zIndexOffset: -200 });

      const box = document.createElement('div');
      const t = document.createElement('b');
      t.textContent = name;
      const sub = document.createElement('div');
      sub.className = 'muted';
      sub.style.margin = '2px 0 8px';
      sub.textContent = k.label;
      const btn = document.createElement('button');
      btn.className = 'btn';
      btn.style.width = '100%';
      btn.textContent = 'ここを記録する';
      btn.addEventListener('click', () => recordLandmark(name, k, lat, lng));
      box.appendChild(t); box.appendChild(sub); box.appendChild(btn);
      m.bindPopup(box);
      group.addLayer(m);
      n++;
    }
    state.marks = group.addTo(state.map);
    toast(n ? 'ランドマーク ' + n + '件' : 'この範囲にはありません');

    if (state.marksPending) { state.marksPending = false; renderLandmarks(true); }
  }

  // 地図で長押しした地点を記録する。市区町村と町丁目は座標から自動で決まるので、
  // ユーザーは名前を入れるだけでよい。
  async function recordAtPoint(lat, lng) {
    const ok = await ensureLevelData('city');
    const f = ok ? findAt('city', lat, lng) : null;
    if (!f) { toast('日本の範囲外のようです'); return; }

    if (state.here) state.map.removeLayer(state.here);
    state.here = L.circleMarker([lat, lng], {
      radius: 7, color: '#c0392b', fillColor: '#e74c3c', fillOpacity: 0.9, weight: 2,
    }).addTo(state.map);

    await openSheet('city', f.properties.code, { lat, lng });
    // 名前を入れてもらう前提なので、場所の欄を開いてそこへ誘導する
    $('#place-body').removeAttribute('hidden');
    $('#place-toggle').classList.add('is-open');
    $('#place-name').focus();
    toast('この地点を記録します。場所の名前を入れてください');
  }

  // 同じ場所に「また来た」を足す。場所の情報は引き継ぎ、日時は今にする。
  async function openPlaceForNewVisit(v) {
    const lv = v.category;
    if (!LEVELS[lv]) return;
    if (!(await ensureLevelData(lv))) return;
    const code = String(v.spotId).slice(lv.length + 1);
    if (state.level !== lv) {
      state.level = lv;
      $$('.lvbtn').forEach((b) => b.classList.toggle('is-active', b.dataset.level === lv));
      drawLayer(); renderProgress();
    }
    await openSheet(lv, code, v.coords || undefined);   // 日時は今、フォームは空の状態
    setTagValue(v.tag || '');
    if (v.place) setPlace(v.place);
    if (v.address) state.selected.address = v.address;
    $('#place-body').removeAttribute('hidden');
    $('#place-toggle').classList.add('is-open');
    toast((v.place && v.place.name ? v.place.name : v.name) + ' に来たことを追加します');
  }

  // ランドマークから記録する。市区町村を割り出し、場所の名前とタグを入れた状態で開く。
  async function recordLandmark(name, kind, lat, lng) {
    state.map.closePopup();
    const ok = await ensureLevelData('city');
    const f = ok ? findAt('city', lat, lng) : null;
    if (!f) { toast('この地点の市区町村が分かりませんでした'); return; }
    await openSheet('city', f.properties.code, { lat, lng });
    setTagValue(kind.tag);
    $('#place-name').value = name;
    $('#place-body').removeAttribute('hidden');
    $('#place-toggle').classList.add('is-open');
  }

  // 記録のピン。座標を持つ記録だけを、タグの記号つきで置く。
  async function renderPins() {
    if (!state.map) return;
    const all = await Store.getAllVisits();
    const withCoords = all.filter((v) => v.coords && typeof v.coords.lat === 'number');
    // ★同じ場所は1本のピンにまとめる★
    // よく行く場所を何度も記録すると、訪問ごとにピンが立って地図が読めなくなる。
    state.placeCache = withCoords.length ? groupByPlace(withCoords) : [];
    drawPins();
  }

  // ★重なったピンは丸1つに束ねる★
  // 場所ごとにまとめても、全国を引きで見ると数百のピンが重なって数が読めない。
  // 束ね方はズームだけで決まるので、地図を横に動かしただけでは組み替わらない
  // （組み替わるとピンがちらついて、どれを見ていたのか分からなくなる）。
  const CLUSTER_PX = 48;

  function drawPins() {
    if (!state.map) return;
    if (state.pins) { state.map.removeLayer(state.pins); state.pins = null; }
    if (!state.pinsOn) return;
    const places = state.placeCache || [];
    if (!places.length) return;

    const group = L.layerGroup();
    for (const c of clusterPlaces(places)) {
      group.addLayer(c.places.length === 1 ? placeMarker(c.places[0]) : clusterMarker(c));
    }
    state.pins = group.addTo(state.map);
  }

  function clusterPlaces(places) {
    const z = state.map.getZoom();
    const out = [];
    for (const g of places) {
      const p = state.map.project([g.lat, g.lng], z);
      let best = null, bd = CLUSTER_PX;
      for (const c of out) {
        const d = Math.hypot(c.p.x - p.x, c.p.y - p.y);
        if (d < bd) { best = c; bd = d; }
      }
      if (best) { best.places.push(g); continue; }
      out.push({ p, places: [g] });
    }
    // 束ねた丸は、含まれる場所の真ん中に置く
    for (const c of out) {
      c.lat = c.places.reduce((a, g) => a + g.lat, 0) / c.places.length;
      c.lng = c.places.reduce((a, g) => a + g.lng, 0) / c.places.length;
    }
    return out;
  }

  function placeMarker(g) {
    const v = g.items[0];                 // 最新の記録を代表にする
    const t = tagOf(v.tag);
    const icon = L.divIcon({
      className: 'pin',
      html: '<span class="pin__mark">' + t.mark + '</span>'
        + (g.items.length > 1 ? '<b class="pin__count">' + g.items.length + '</b>' : ''),
      iconSize: [34, 34],
      iconAnchor: [17, 34],
      popupAnchor: [0, -30],
    });
    const m = L.marker([g.lat, g.lng], { icon });
    m.bindPopup(buildPinPopup(g, t));
    return m;
  }

  function clusterMarker(c) {
    const n = c.places.length;
    const big = n >= 100;
    const size = big ? 46 : 38;
    const icon = L.divIcon({
      className: 'cpin' + (big ? ' cpin--big' : ''),
      html: '<b>' + n + '</b>',
      iconSize: [size, size],
      iconAnchor: [size / 2, size / 2],
    });
    const m = L.marker([c.lat, c.lng], { icon, title: n + 'か所' });
    // ★押したら必ずズームが進むようにする★
    // 束の範囲にちょうど合わせる（fitBounds）だけだと、画面上の広がりが
    // 前とほぼ同じになるので同じ束に組み直され、押しても何も起きないように見える。
    // 同じ場所は50m以上離れているので、寄り続ければ必ずばらける。
    m.on('click', () => {
      const b = L.latLngBounds(c.places.map((g) => [g.lat, g.lng]));
      const fit = state.map.getBoundsZoom(b, false, [40, 40]);
      const next = Math.min(Math.max(fit, state.map.getZoom() + 2), state.map.getMaxZoom());
      state.map.setView(b.getCenter(), next);
    });
    return m;
  }

  function buildLineDayChips(days) {
    const box = $('#line-days');
    if (!box) return;
    const wanted = ['__all__'].concat(days.slice(0, 40));
    const cur = box.dataset.days || '';
    const key = wanted.join(',');
    if (cur === key) {                       // 中身が同じなら選択状態だけ更新
      $$('#line-days .ldchip').forEach(function (b) {
        b.classList.toggle('is-on', (b.dataset.day || '__all__') === (state.lineDay || '__all__'));
      });
      return;
    }
    box.dataset.days = key;
    box.innerHTML = '';
    if (!days.length) { box.hidden = true; return; }
    box.hidden = !state.linesOn;

    wanted.forEach(function (d) {
      const isAll = d === '__all__';
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'ldchip';
      if (!isAll) b.dataset.day = d;
      b.textContent = isAll ? 'すべての日' : d.slice(5).replace('-', '/');
      b.classList.toggle('is-on', (isAll ? '__all__' : d) === (state.lineDay || '__all__'));
      b.addEventListener('click', function () {
        state.lineDay = isAll ? null : d;
        state.lineDayPicked = true;
        renderDayLines();
      });
      box.appendChild(b);
    });
  }

  // ★日付は必ずローカルで作る★
  // new Date().toISOString().slice(0,10) は UTC を返すため、日本時間の朝9時前に
  // 記録すると前日の日付が入ってしまう。
  function todayLocal(d) {
    const t = d || new Date();
    const p = (n) => String(n).padStart(2, '0');
    return t.getFullYear() + '-' + p(t.getMonth() + 1) + '-' + p(t.getDate());
  }

  function nowTimeLocal(d) {
    const t = d || new Date();
    const p = (n) => String(n).padStart(2, '0');
    return p(t.getHours()) + ':' + p(t.getMinutes());
  }

  // 並べ替え・表示に使う「日付＋時刻」。時刻が無い記録も混ざるので既定値を置く
  function visitStamp(v) {
    return (v.visitedAt || '') + ' ' + (v.visitedTime || '00:00');
  }

  // 「8/26 14:30」の形。時刻が無ければ日付だけ
  function visitLabel(v) {
    const d = (v.visitedAt || '').split('-');
    const day = d.length === 3 ? Number(d[1]) + '/' + Number(d[2]) : (v.visitedAt || '');
    return v.visitedTime ? day + ' ' + v.visitedTime : day;
  }

  // 同じ場所かどうかの判定。
  // 名前を付けた場所は「名前が同じなら同じ場所」。GPSは数十mずれるので座標では見ない。
  // 名前が無い記録どうしは、50m以内なら同じ場所とみなす。
  // 名前あり・なしは混ぜない（付けた本人が区別しているため）。
  function groupByPlace(visits) {
    const NEAR = 50;                        // メートル
    const named = new Map();
    const rest = [];

    const sorted = visits.slice().sort((a, b) => visitStamp(b).localeCompare(visitStamp(a)));
    for (const v of sorted) {
      const name = (v.place && v.place.name || '').trim();
      if (name) {
        if (!named.has(name)) named.set(name, { name, lat: v.coords.lat, lng: v.coords.lng, items: [] });
        named.get(name).items.push(v);
      } else {
        rest.push(v);
      }
    }

    // 名前を入れるのは初回だけで、2回目からは日時だけ記録する——という使い方が
    // 実際に多い。名前あり・なしを完全に分けると、2回目以降が別のピンになり、
    // 場所の名前ではなく市区町村名で表示されてしまう。
    // そこで、名前なしの記録は近く(50m以内)に名前付きの場所があればそこへ寄せる。
    // 一番近いものを選ぶので、同じ建物に別の店を登録していても取り違えにくい。
    const groups = Array.from(named.values());
    const anon = [];
    for (const v of rest) {
      let best = null, bestD = NEAR;
      for (const g of groups) {
        const d = distMeters(g.lat, g.lng, v.coords.lat, v.coords.lng);
        if (d <= bestD) { best = g; bestD = d; }
      }
      if (best) { best.items.push(v); continue; }
      const near = anon.find((g) => distMeters(g.lat, g.lng, v.coords.lat, v.coords.lng) <= NEAR);
      if (near) near.items.push(v);
      else anon.push({ name: '', lat: v.coords.lat, lng: v.coords.lng, items: [v] });
    }

    // 寄せたぶんが末尾に付くので、各グループを新しい順に整え直す。
    // 吹き出しは items[0] を最新として扱うため、ここが崩れると表示がずれる。
    for (const g of groups) {
      g.items.sort((a, b) => visitStamp(b).localeCompare(visitStamp(a)));
    }
    return groups.concat(anon);
  }

  // 2点間のおおよその距離（メートル）
  function distMeters(lat1, lng1, lat2, lng2) {
    const R = 6371000, rad = Math.PI / 180;
    const dLat = (lat2 - lat1) * rad;
    const dLng = (lng2 - lng1) * rad;
    const a = Math.sin(dLat / 2) ** 2
      + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
  }

  // ピンの吹き出し。登録した場所の名前を一番上に出す（市区町村名より先に
  // 「ここが何の場所か」が分かるほうが役に立つ）。編集にもここから入れる。
  function buildPinPopup(g, t) {
    const v = g.items[0];                    // 最新の記録
    const box = document.createElement('div');
    box.className = 'pinpop';

    const title = document.createElement('b');
    title.className = 'pinpop__title';
    title.textContent = g.name || v.name || '';
    box.appendChild(title);

    const sub = document.createElement('div');
    sub.className = 'pinpop__sub';
    const parts = [];
    if (g.name) parts.push(v.name || '');    // 場所名を出したときだけ市区町村を副題に
    if (t.key) parts.push(t.mark + ' ' + t.label);
    if (v.address && v.address.lv01Nm) parts.push(v.address.lv01Nm);
    sub.textContent = parts.filter(Boolean).join(' ・ ');
    if (sub.textContent) box.appendChild(sub);

    if (g.items.length > 1) {
      const c = document.createElement('div');
      c.className = 'pinpop__date';
      // 何度も買い物する場所は、回数だけでなく合計いくら使ったかが知りたい
      const sum = g.items.reduce((n, it) => n + (Number(it.amount) || 0), 0);
      c.textContent = g.items.length + '回訪問'
        + (sum > 0 ? ' ・ 合計 ¥' + sum.toLocaleString('ja-JP') : '');
      box.appendChild(c);
    }

    // 訪問した日時を新しい順に。行をタップするとその回を編集できる
    const list = document.createElement('ul');
    list.className = 'pinpop__times';
    const SHOW = 6;
    for (const item of g.items.slice(0, SHOW)) {
      const li = document.createElement('li');
      li.className = 'pinpop__time';

      // 金額と御朱印は訪問ごとの情報なので、その回の行に出す。
      // 以前は最新1件ぶんだけを吹き出しの下にまとめて出しており、
      // 同じ場所に何度も来ていると、どの回のものか分からなかった。
      const main = document.createElement('div');
      main.className = 'pinpop__timeMain';
      const when = document.createElement('span');
      when.className = 'pinpop__when';
      when.textContent = visitLabel(item);
      main.appendChild(when);

      const bits = [];
      if (Number(item.amount) > 0) bits.push('¥' + Number(item.amount).toLocaleString('ja-JP'));
      if (item.goshuin && item.goshuin.name) bits.push(gsKindOf(item.goshuin) + ': ' + item.goshuin.name);
      if (bits.length) {
        const meta = document.createElement('span');
        meta.className = 'pinpop__meta';
        meta.textContent = bits.join(' ・ ');
        main.appendChild(meta);
      }
      li.appendChild(main);
      const edit = document.createElement('button');
      edit.type = 'button';
      edit.className = 'linkbtn';
      edit.textContent = '編集';
      edit.addEventListener('click', async () => {
        state.map.closePopup();
        await openVisitForEdit(item);
      });
      li.appendChild(edit);
      list.appendChild(li);
    }
    box.appendChild(list);

    if (g.items.length > SHOW) {
      const more = document.createElement('div');
      more.className = 'pinpop__more';
      more.textContent = '他 ' + (g.items.length - SHOW) + ' 件';
      box.appendChild(more);
    }

    // 1回だけの場所は、御朱印とメモをそのまま下に出す。
    // 複数回の場所では上の行ごとの表示に任せる（最新1件だけ出すと
    // 他の回のものと取り違える）。各回の詳しい中身は行の「編集」から見る。
    if (g.items.length === 1) {
      if (v.goshuin && v.goshuin.name) {
        const gs = document.createElement('div');
        gs.className = 'pinpop__goshuin';
        gs.textContent = gsKindOf(v.goshuin) + ': ' + v.goshuin.name;
        box.appendChild(gs);
      }
      if (v.memo) {
        const memo = document.createElement('div');
        memo.className = 'pinpop__memo';
        memo.textContent = v.memo;
        box.appendChild(memo);
      }
    }

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn pinpop__edit';
    btn.textContent = g.items.length > 1 ? 'ここに来たことを追加' : 'この記録を編集';
    btn.addEventListener('click', async () => {
      state.map.closePopup();
      // 複数回来ている場所は「また来た」を足したいので、編集ではなく新規で開く。
      // 編集で開くと保存が最新の記録の上書きになり、回数が増えない。
      if (g.items.length > 1) await openPlaceForNewVisit(v);
      else await openVisitForEdit(v);
    });
    box.appendChild(btn);
    return box;
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
    $('#visit-date').value = todayLocal();
    $('#visit-time').value = nowTimeLocal();
    $('#visit-memo').value = '';
    setTagValue('');
    clearExtraFields();
    clearPending();
    $('#sheet-coords').textContent = coords
      ? `現在地: ${coords.lat.toFixed(4)}, ${coords.lng.toFixed(4)}`
      : '座標は記録されません（地図から選択）';

    await renderVisitList(spotIdOf(level, code));

    // 同じ地点に場所の情報つきの記録があれば、引き継ぎボタンを出す
    const past = await Store.getVisitsBySpot(spotIdOf(level, code));
    const withPlace = past.filter((v) => v.place && v.place.name);
    if (withPlace.length) {
      withPlace.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
      state.lastPlace = withPlace[0].place;
      const cp = $('#place-copy');
      cp.hidden = false;
      cp.textContent = '前回の情報を引き継ぐ（' + withPlace[0].place.name + '）';
    }

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
    visits.sort((a, b) => visitStamp(b).localeCompare(visitStamp(a)));
    const box = $('#visit-list');
    if (!visits.length) {
      box.innerHTML = '<p class="muted">まだ記録がありません。</p>';
      return;
    }
    box.innerHTML = '';
    for (const v of visits) {
      const row = document.createElement('div');
      row.className = 'visit';
      // ★見出しは「場所の名前」を先に出す★
      // 1つの市区町村に何件も記録があると、日付だけでは何の記録か分からない
      // （一覧が地名で埋まって、どれがどれだか見分けられなかった）。
      const nm = (v.place && v.place.name || '').trim();
      const when = (v.visitedAt || '') + (v.visitedTime ? ' ' + v.visitedTime : '');
      const head = document.createElement('div');
      head.className = 'visit__head';
      head.innerHTML = '<b>' + tagOf(v.tag).mark + ' '
        + escapeHtml(nm || v.visitedAt || '')
        + (!nm && v.visitedTime ? ' <span class="visit__time">' + escapeHtml(v.visitedTime) + '</span>' : '')
        + '</b>';
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

      // 名前を見出しにしたときだけ、日時を下の行に出す（見出しが日付なら重複する）
      if (nm && when) {
        const w = document.createElement('p');
        w.className = 'visit__when';
        w.textContent = when;
        row.appendChild(w);
      }

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

    $('#visit-date').value = visit.visitedAt || todayLocal();
    $('#visit-time').value = visit.visitedTime || '';
    $('#visit-memo').value = visit.memo || '';
    setTagValue(visit.tag || '');
    $('#visit-amount').value = (visit.amount || visit.amount === 0) ? visit.amount : '';
    $('#visit-revisit').checked = !!visit.revisit;
    setRating(visit.rating || 0);
    setPlace(visit.place || null);
    setGoshuin(visit.goshuin || null);

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

  // ---- 追加した入力欄の読み書き ----
  function initExtraFields() {
    // 星
    const box = $('#visit-rating');
    if (box && !box.childElementCount) {
      for (let i = 1; i <= 5; i++) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'star';
        b.dataset.v = String(i);
        b.textContent = '☆';
        b.addEventListener('click', () => {
          const cur = getRating();
          setRating(cur === i ? 0 : i);   // 同じ星をもう一度押したら解除
        });
        box.appendChild(b);
      }
    }
    // 定休日
    const dbox = $('#place-closed');
    if (dbox && !dbox.childElementCount) {
      DAYS.forEach((d) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'day' + (d === '不定休' ? ' day--wide' : '');
        b.dataset.day = d;
        b.textContent = d;
        b.addEventListener('click', () => b.classList.toggle('is-on'));
        dbox.appendChild(b);
      });
    }
    // 御朱印：書き方・形式は1つだけ選ぶ（重複しない項目なので排他にする）
    const mkPicker = function (sel, items) {
      const box = $(sel);
      if (!box || box.childElementCount) return;
      items.forEach(function (label) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'day day--wide';
        b.dataset.v = label;
        b.textContent = label;
        b.addEventListener('click', function () {
          const on = b.classList.contains('is-on');
          box.querySelectorAll('.day').forEach(function (x) { x.classList.remove('is-on'); });
          if (!on) b.classList.add('is-on');
        });
        box.appendChild(b);
      });
    };
    mkPicker('#gs-kind', GS_KIND);
    mkPicker('#gs-write', GS_WRITE);
    mkPicker('#gs-form', GS_FORM);

    const gt = $('#goshuin-toggle');
    if (gt) {
      gt.addEventListener('click', function () {
        const body = $('#goshuin-body');
        const open = body.hasAttribute('hidden');
        if (open) body.removeAttribute('hidden'); else body.setAttribute('hidden', '');
        gt.classList.toggle('is-open', open);
      });
    }

    // 折りたたみ
    const tg = $('#place-toggle');
    if (tg) {
      tg.addEventListener('click', () => {
        const body = $('#place-body');
        const open = body.hasAttribute('hidden');
        if (open) body.removeAttribute('hidden'); else body.setAttribute('hidden', '');
        tg.classList.toggle('is-open', open);
      });
    }
    // 前回の情報を引き継ぐ
    const cp = $('#place-copy');
    if (cp) cp.addEventListener('click', () => {
      if (state.lastPlace) { setPlace(state.lastPlace); toast('前回の情報を引き継ぎました'); }
    });
  }

  function setRating(n) {
    $$('#visit-rating .star').forEach((b) => {
      const on = Number(b.dataset.v) <= n;
      b.classList.toggle('is-on', on);
      b.textContent = on ? '★' : '☆';
    });
    $('#visit-rating').dataset.value = String(n || 0);
  }
  function amountValue() {
    const v = ($('#visit-amount').value || '').trim();
    if (!v) return null;
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : null;
  }

  function getRating() { return Number(($('#visit-rating') || {}).dataset?.value || 0); }

  function setGoshuin(g) {
    g = g || {};
    $('#gs-name').value = g.name || '';
    $('#gs-limited').checked = !!g.limited;
    $$('#gs-kind .day').forEach((b) => b.classList.toggle('is-on', b.dataset.v === gsKindOf(g)));
    $$('#gs-write .day').forEach((b) => b.classList.toggle('is-on', b.dataset.v === g.write));
    $$('#gs-form .day').forEach((b) => b.classList.toggle('is-on', b.dataset.v === g.form));
    const any = g.name || g.write || g.form || g.limited;
    const body = $('#goshuin-body'), tg = $('#goshuin-toggle');
    if (any) { body.removeAttribute('hidden'); tg.classList.add('is-open'); }
    else { body.setAttribute('hidden', ''); tg.classList.remove('is-open'); }
  }

  function getGoshuin() {
    const k = $('#gs-kind .day.is-on');
    const w = $('#gs-write .day.is-on');
    const f = $('#gs-form .day.is-on');
    const g = {
      kind: k ? k.dataset.v : '',
      name: $('#gs-name').value.trim(),
      write: w ? w.dataset.v : '',
      form: f ? f.dataset.v : '',
      limited: $('#gs-limited').checked,
    };
    // 種類だけ選んで他が空、というのは記録として意味がないので拾わない
    return (g.name || g.write || g.form || g.limited) ? g : null;
  }

  function setPlace(p) {
    p = p || {};
    $('#place-name').value = p.name || '';
    $('#place-address').value = p.address || '';
    $('#place-tel').value = p.tel || '';
    $('#place-hours').value = p.hours || '';
    $('#place-web').value = p.web || '';
    $('#place-sns').value = p.sns || '';
    const closed = p.closed || [];
    $$('#place-closed .day').forEach((b) => b.classList.toggle('is-on', closed.includes(b.dataset.day)));
    // 何か入っていれば畳まずに開いておく（入力済みなのに隠れていると気づけない）
    const any = ['name', 'address', 'tel', 'hours', 'web', 'sns'].some((k) => p[k]) || closed.length;
    const body = $('#place-body'), tg = $('#place-toggle');
    if (any) { body.removeAttribute('hidden'); tg.classList.add('is-open'); }
    else { body.setAttribute('hidden', ''); tg.classList.remove('is-open'); }
  }

  function getPlace() {
    const closed = $$('#place-closed .day.is-on').map((b) => b.dataset.day);
    const p = {
      name: $('#place-name').value.trim(),
      address: $('#place-address').value.trim(),
      tel: $('#place-tel').value.trim(),
      hours: $('#place-hours').value.trim(),
      web: $('#place-web').value.trim(),
      sns: $('#place-sns').value.trim(),
      closed,
    };
    const any = p.name || p.address || p.tel || p.hours || p.web || p.sns || closed.length;
    return any ? p : null;
  }

  function clearExtraFields() {
    $('#visit-amount').value = '';
    $('#visit-revisit').checked = false;
    setRating(0);
    setPlace(null);
    setGoshuin(null);
    $('#place-copy').hidden = true;
    state.lastPlace = null;
  }

  function initSheet() {
    initTagPicker();
    initExtraFields();
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
      $('#visit-date').value = todayLocal();
    $('#visit-time').value = nowTimeLocal();
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
          visitedTime: $('#visit-time').value || '',
          memo: $('#visit-memo').value.trim(),
          tag: getTagValue(),
          amount: amountValue(),
          rating: getRating(),
          revisit: $('#visit-revisit').checked,
          place: getPlace(),
          goshuin: getGoshuin(),
          photoIds,
          updatedAt: new Date().toISOString(),
        }));
      } else {
        await Store.addVisit({
          spotId,
          category: sel.level,
          name: sel.name,
          visitedAt: $('#visit-date').value || todayLocal(),
          visitedTime: $('#visit-time').value || '',
          memo: $('#visit-memo').value.trim(),
          tag: getTagValue(),
          amount: amountValue(),
          rating: getRating(),
          revisit: $('#visit-revisit').checked,
          place: getPlace(),
          goshuin: getGoshuin(),
          coords: sel.coords,
          address: sel.address,
          photoIds,
        });
      }
      await refreshVisited();
      refreshMap(); renderList(); renderProgress();
      await renderVisitList(spotId);
      // 記録が入った時点で保存の永続化を要求する。ブラウザは使い込まれている
      // アプリほど許可しやすいので、初回表示時ではなくここで頼む。
      ensurePersistOnce();
      const wasEditing = !!state.editing;
      $('#visit-memo').value = '';
      clearExtraFields();
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
      await navigator.share({ files: [file], title: visit.name || 'めぐログ' });
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
      const hay = [v.name, v.memo, v.address && v.address.lv01Nm, v.visitedAt,
                   v.place && v.place.name, v.place && v.place.address,
                   v.goshuin && v.goshuin.name]
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
    const right = document.createElement('span');
    right.className = 'hcard__right';
    const sm = document.createElement('small');
    sm.textContent = v.visitedAt || '';
    // 記録タブから直したいとき、地図へ飛んで履歴から探し直すのは遠すぎるので、
    // カードから1タップで編集に入れるようにする。
    const ed = document.createElement('button');
    ed.type = 'button';
    ed.className = 'hcard__edit';
    ed.textContent = '編集';
    ed.addEventListener('click', async function (e) {
      e.stopPropagation();
      await openVisitForEdit(v);
    });
    right.appendChild(sm);
    right.appendChild(ed);
    head.appendChild(b);
    head.appendChild(right);
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

    // 店名があれば地名より目立たせる（「どこの市か」より「どの店か」で思い出すため）
    if (v.place && v.place.name) {
      const pn = document.createElement('p');
      pn.className = 'hcard__place';
      pn.textContent = v.place.name;
      card.appendChild(pn);
    }

    if (v.goshuin && v.goshuin.name) {
      const gn = document.createElement('p');
      gn.className = 'hcard__goshuin';
      gn.textContent = gsKindOf(v.goshuin) + ': ' + v.goshuin.name;
      card.appendChild(gn);
    }

    const badges = document.createElement('div');
    badges.className = 'hcard__badges';
    if (v.rating) {
      const r = document.createElement('span');
      r.className = 'badge badge--star';
      r.textContent = '★'.repeat(v.rating) + '☆'.repeat(5 - v.rating);
      badges.appendChild(r);
    }
    if (v.amount || v.amount === 0) {
      const a = document.createElement('span');
      a.className = 'badge';
      a.textContent = '¥' + Number(v.amount).toLocaleString('ja-JP');
      badges.appendChild(a);
    }
    if (v.revisit) {
      const rv = document.createElement('span');
      rv.className = 'badge badge--revisit';
      rv.textContent = 'また行きたい';
      badges.appendChild(rv);
    }
    if (v.goshuin) {
      const g = v.goshuin;
      [g.write, g.form, g.limited ? '限定' : ''].filter(Boolean).forEach(function (t) {
        const e = document.createElement('span');
        e.className = 'badge badge--goshuin';
        e.textContent = t;
        badges.appendChild(e);
      });
    }
    if (badges.childElementCount) card.appendChild(badges);

    if (v.memo) {
      const m = document.createElement('p');
      m.className = 'hcard__memo';
      m.textContent = v.memo;
      card.appendChild(m);
    }

    // 場所の詳細。電話とサイトはタップで発信・表示できるようにする。
    if (v.place) {
      const p = v.place;
      const dl = document.createElement('div');
      dl.className = 'hcard__place-info';
      const line = function (label, value, href) {
        if (!value) return;
        const row = document.createElement('div');
        const k = document.createElement('span');
        k.textContent = label;
        row.appendChild(k);
        if (href) {
          const a = document.createElement('a');
          a.href = href;
          a.textContent = value;
          a.rel = 'noopener';
          if (href.startsWith('http')) a.target = '_blank';
          a.addEventListener('click', function (e) { e.stopPropagation(); });
          row.appendChild(a);
        } else {
          const b = document.createElement('b');
          b.textContent = value;
          row.appendChild(b);
        }
        dl.appendChild(row);
      };
      line('住所', p.address);
      line('電話', p.tel, p.tel ? 'tel:' + p.tel.replace(/[^0-9+]/g, '') : '');
      line('営業', p.hours);
      if (p.closed && p.closed.length) line('定休', p.closed.join('・'));
      line('サイト', p.web, p.web);
      line('SNS', p.sns, /^https?:/.test(p.sns || '') ? p.sns : '');
      if (dl.childElementCount) card.appendChild(dl);
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

  // 記録タブから直接その記録の編集を開く
  async function openVisitForEdit(v) {
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
    await openSheet(lv, code);
    await startEdit(v);
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

    // 使ったお金
    const spent = all.reduce(function (n, v) { return n + (Number(v.amount) || 0); }, 0);
    const spentCount = all.filter(function (v) { return Number(v.amount) > 0; }).length;
    if (spent > 0) {
      const byMonth = new Map();
      all.forEach(function (v) {
        const a = Number(v.amount) || 0;
        if (!a) return;
        const mo = (v.visitedAt || '').slice(0, 7);
        if (mo) byMonth.set(mo, (byMonth.get(mo) || 0) + a);
      });
      const rows = [
        ['合計', '¥' + spent.toLocaleString('ja-JP')],
        ['記録した回数', spentCount + ' 件'],
        ['1回あたり', '¥' + Math.round(spent / spentCount).toLocaleString('ja-JP')],
      ];
      Array.from(byMonth.entries())
        .sort(function (a, b) { return b[0].localeCompare(a[0]); })
        .slice(0, 6)
        .forEach(function (e) {
          rows.push([e[0].replace('-', '年') + '月', '¥' + e[1].toLocaleString('ja-JP')]);
        });
      card('使ったお金', rows);
    }

    // 御朱印
    const gs = all.filter(function (v) { return v.goshuin; });
    if (gs.length) {
      const cnt = function (pred) { return gs.filter(pred).length; };
      const rows = [['いただいた数', gs.length + ' 体']];
      GS_KIND.forEach(function (k) {
        const n = cnt(function (v) { return gsKindOf(v.goshuin) === k; });
        if (n) rows.push([k, n + ' 体']);
      });
      GS_WRITE.forEach(function (w) {
        const n = cnt(function (v) { return v.goshuin.write === w; });
        if (n) rows.push([w, n + ' 体']);
      });
      GS_FORM.forEach(function (f) {
        const n = cnt(function (v) { return v.goshuin.form === f; });
        if (n) rows.push([f, n + ' 体']);
      });
      const lim = cnt(function (v) { return v.goshuin.limited; });
      if (lim) rows.push(['限定', lim + ' 体']);
      card('御朱印・御城印など', rows);
    }

    // また行きたい／高評価
    const revisit = all.filter(function (v) { return v.revisit; });
    const rated = all.filter(function (v) { return v.rating; });
    if (revisit.length || rated.length) {
      const rows = [];
      if (revisit.length) rows.push(['また行きたい', revisit.length + ' 件']);
      if (rated.length) {
        const avg = rated.reduce(function (n, v) { return n + v.rating; }, 0) / rated.length;
        rows.push(['評価をつけた記録', rated.length + ' 件']);
        rows.push(['平均評価', avg.toFixed(1) + ' / 5']);
      }
      card('お気に入り', rows);
    }

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
  // ---- Androidの戻るボタン ----
  // ホーム画面から起動していると、戻るを押した時点で何も言わずアプリが閉じる。
  // 履歴にダミーを1つ積んでおき、戻るが来たら「閉じる」の前に段階的に畳む。
  //   1. 記録シートが開いていれば閉じる
  //   2. 場所検索の候補が開いていれば閉じる
  //   3. 地図タブ以外なら地図へ戻る
  //   4. それでも戻るなら、閉じてよいか確認する
  function pushBackGuard() {
    try { history.pushState({ mlGuard: true }, ''); } catch (e) { /* 何もしない */ }
  }

  function initBackGuard() {
    pushBackGuard();
    window.addEventListener('popstate', () => {
      if (state.layersOpen) { openLayers(false); pushBackGuard(); return; }
      const sheet = $('#sheet');
      if (sheet && sheet.classList.contains('is-open')) {
        closeSheet(); pushBackGuard(); return;
      }
      const hits = $('#map-hits');
      if (hits && !hits.hidden) {
        hits.hidden = true; hits.innerHTML = ''; pushBackGuard(); return;
      }
      const active = document.querySelector('.tab.is-active');
      if (active && active.dataset.tab !== 'map') {
        switchTab('map'); pushBackGuard(); return;
      }
      if (confirm('めぐログを閉じますか？')) {
        // ダミーはもう消えているので、ここで戻るとアプリから出る
        history.back();
      } else {
        pushBackGuard();
      }
    });
  }

  function switchTab(name) {
    $$('.tab').forEach((b) => b.classList.toggle('is-active', b.dataset.tab === name));
    $$('.panel').forEach((p) => p.classList.toggle('is-active', p.id === 'panel-' + name));
    if (name === 'map' && state.map) setTimeout(() => { fitMapHeight(); state.map.invalidateSize(); }, 50);
    if (name !== 'map') openLayers(false);
    if (name === 'history') renderHistory(true);
    // 記録したあとに設定を開いたとき、バックアップの状況が古いままにならないように
    if (name === 'settings') {
      ensurePersistOnce().then(() => { renderPersistInfo(); renderDeviceInfo(); });
      renderBackupStatus(); renderStorageInfo(); renderPickTags();
      prepareBackupFile(state.shareType);
    } else {
      releaseBackupFile();
    }
  }

  function initTabs() {
    $$('.tab').forEach((b) => b.addEventListener('click', () => switchTab(b.dataset.tab)));
    initBackGuard();

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
  // 共有用のファイルを先に作っておく。設定を離れたら捨てる（写真の分だけ重いため）。
  async function prepareBackupFile(shareType) {
    if (!shareType || state.backupBuilding) return;
    state.backupBuilding = true;
    try {
      const b = await buildBackup();
      const name = b.name.replace(/\.json$/, '.' + shareType.ext);
      state.backupFile = {
        file: new File([b.blob], name, { type: shareType.type }),
        counts: b.counts,
      };
    } catch (e) {
      state.backupFile = null;
    } finally {
      state.backupBuilding = false;
    }
  }

  function saveFile(file) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(file);
    a.download = file.name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  // ★「バックアップを取った」と記録してよいのは全部を書き出したときだけ★
  // 一部だけの書き出しでここを通すと、次の警告が出なくなり、
  // 全部のバックアップを取ったつもりのまま機種変してしまう。
  async function saveBackupFile(file, counts) {
    saveFile(file);
    await Store.markBackedUp(counts);
    renderBackupStatus();
  }

  function releaseBackupFile() {
    state.backupFile = null;
  }

  // この端末の共有シートが受け付ける形式を選ぶ。どれも通らなければ null。
  function pickShareType(candidates) {
    if (!navigator.canShare || !navigator.share) return null;
    for (const c of candidates) {
      try {
        const probe = new File(['{}'], 'probe.' + c.ext, { type: c.type });
        if (navigator.canShare({ files: [probe] })) return c;
      } catch (e) { /* 次を試す */ }
    }
    return null;
  }

  // バックアップの中身を1つ作る。共有にもファイル保存にも同じものを使う。
  async function buildBackup() {
    const data = await Store.exportAll();
    const name = `meguri-log-${todayLocal()}.json`;
    const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
    return { data, name, blob, counts: { visits: data.visits.length, photos: data.photos.length } };
  }

  // ---------------------------------------------------------------
  // 選んで書き出す（人に渡す用）
  // ---------------------------------------------------------------
  // 上のバックアップとは別物。バックアップは全部でないと機種変で困るので、
  // 「一部だけ渡す」はここに分けてある。
  // ★入っていないことが既定★ 写真・メモ・金額は、自分で選んだときだけ入る。
  // 渡してから気づいても取り返せないので、外し忘れではなく入れ忘れが起きる側に倒す。
  function trimForShare(v, opt) {
    const out = Object.assign({}, v);
    if (!opt.memo) out.memo = '';
    if (!opt.money) { delete out.amount; delete out.rating; delete out.revisit; }
    // 写真を入れないときは参照も消す。残すと、渡した先で開けない写真の枠だけが出る
    if (!opt.photo) out.photoIds = [];
    return out;
  }

  async function buildPickExport() {
    const tags = state.pickTags;
    if (!tags.size) return null;
    const opt = {
      photo: $('#pick-photo').checked,
      memo: $('#pick-memo').checked,
      money: $('#pick-money').checked,
    };
    const data = await Store.exportAll({
      visitFilter: (v) => tags.has(v.tag || ''),
      withPhotos: opt.photo,
    });
    data.visits = data.visits.map((v) => trimForShare(v, opt));
    // 読み込む側に「これは一部です」と分かるようにしておく。
    // 全部のバックアップと取り違えられると、何が入っていないのか分からなくなる。
    data.partial = true;
    data.partialTags = Array.from(tags).map((k) => tagOf(k).label);
    const label = data.partialTags.length === 1 ? data.partialTags[0] : '選んだ分';
    const name = 'meguri-log-' + label.replace(/[^\p{L}\p{N}ー・]/gu, '') + '-' + todayLocal() + '.json';
    const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
    return { data, name, blob, counts: { visits: data.visits.length, photos: data.photos.length } };
  }

  // 設定を開くたびに作り直す。記録が増えてもタグの件数が古いままにならないように。
  async function renderPickTags() {
    const box = $('#pick-tags');
    if (!box) return;
    const all = await Store.getAllVisits();
    const counts = new Map();
    for (const v of all) {
      const k = v.tag || '';
      counts.set(k, (counts.get(k) || 0) + 1);
    }
    // 記録が無くなったタグの選択は落とす（選ばれたまま0件になると混乱する）
    Array.from(state.pickTags).forEach((k) => { if (!counts.get(k)) state.pickTags.delete(k); });

    box.innerHTML = '';
    TAGS.forEach((t) => {
      const n = counts.get(t.key) || 0;
      if (!n) return;                        // 記録の無いタグは出さない
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'pktag' + (state.pickTags.has(t.key) ? ' is-on' : '');
      b.innerHTML = t.mark + ' ' + escapeHtml(t.label) + ' <small>' + n + '</small>';
      b.addEventListener('click', () => {
        if (state.pickTags.has(t.key)) state.pickTags.delete(t.key);
        else state.pickTags.add(t.key);
        b.classList.toggle('is-on');
        schedulePick();
      });
      box.appendChild(b);
    });
    if (!box.children.length) {
      box.innerHTML = '<p class="muted">まだ記録がありません。</p>';
    }
    schedulePick();
  }

  // 選び直すたびにファイルを作り直しておく。
  // ★共有は押された直後にしか通らない★ ので、押されてから作るのでは間に合わない。
  function schedulePick() {
    clearTimeout(state.pickTimer);
    state.pickSeq++;
    state.pickFile = null;
    const ex = $('#btn-pick-export');
    const sh = $('#btn-pick-share');
    if (ex) ex.disabled = true;
    if (sh) sh.disabled = true;
    const cnt = $('#pick-count');
    if (cnt) {
      const none = !state.pickTags.size;
      cnt.textContent = none ? 'タグを選んでください。' : '数えています…';
      cnt.classList.toggle('is-none', none);
    }
    if (!state.pickTags.size) return;
    state.pickTimer = setTimeout(refreshPickFile, 250);
  }

  async function refreshPickFile() {
    const seq = state.pickSeq;
    let b = null;
    try { b = await buildPickExport(); } catch (e) { b = null; }
    if (seq !== state.pickSeq) return;       // 作っている間に選び直された
    state.pickFile = b;
    const cnt = $('#pick-count');
    const ex = $('#btn-pick-export');
    const sh = $('#btn-pick-share');
    const ok = !!(b && b.counts.visits);
    if (ex) ex.disabled = !ok;
    if (sh) sh.disabled = !ok;
    if (!cnt) return;
    if (!ok) {
      cnt.textContent = '選んだタグの記録がありません。';
      cnt.classList.add('is-none');
      return;
    }
    const ph = b.counts.photos ? '・写真 ' + b.counts.photos + '枚' : '';
    cnt.textContent = b.data.partialTags.join('・') + ' の記録 ' + b.counts.visits + '件' + ph + ' を書き出します。';
    cnt.classList.remove('is-none');
  }

  function initPickExport() {
    const ex = $('#btn-pick-export');
    const sh = $('#btn-pick-share');
    if (!ex) return;
    ['#pick-photo', '#pick-memo', '#pick-money'].forEach((sel) => {
      const el = $(sel);
      if (el) el.addEventListener('change', schedulePick);
    });

    ex.addEventListener('click', () => {
      const ready = state.pickFile;
      if (!ready) { toast('準備中です。少し待ってからもう一度押してください'); return; }
      // ここではバックアップを取った扱いにしない（一部しか入っていないため）
      saveFile(new File([ready.blob], ready.name, { type: 'application/json' }));
      toast(ready.counts.visits + '件を書き出しました（バックアップとは別です）');
    });

    if (sh && state.shareType) sh.hidden = false;
    if (sh) sh.addEventListener('click', () => {
      const ready = state.pickFile;
      const st = state.shareType;
      if (!ready || !st) { toast('準備中です。少し待ってからもう一度押してください'); return; }
      // await を挟まずに share() へ入る。挟むと権限が切れてAndroidで必ず失敗する
      const file = new File([ready.blob], ready.name.replace(/\.json$/, '.' + st.ext), { type: st.type });
      navigator.share({ files: [file], title: 'めぐログ（' + ready.data.partialTags.join('・') + '）' })
        .then(() => toast('送信先を選んでください'))
        .catch((err) => {
          if (err && err.name === 'AbortError') return;
          saveFile(file);
          toast('共有できなかったので、ファイルとして保存しました');
        });
    });
  }

  function initSettings() {
    // スマホでは共有シートから直接クラウドへ送れる。
    // ファイル保存だと端末の中に落ちるだけで、機種が壊れたら一緒に消える。
    //
    // 注意: 共有できるファイル形式はブラウザごとに違う。Android Chrome は
    // application/json を受け付けないので、形式を決め打ちにすると
    // Androidだけボタンが出なくなる。端末に聞いて通る形式を選ぶ。
    const shareBtn = $('#btn-share');
    const SHARE_TYPES = [
      { ext: 'json', type: 'application/json' },
      { ext: 'txt', type: 'text/plain' },
    ];
    const shareType = pickShareType(SHARE_TYPES);
    if (shareType) shareBtn.hidden = false;

    // ★共有は押された直後に呼ばないと弾かれる★
    // ブラウザは「ユーザーが押した直後」にしか共有を許さない（一時的な操作権限）。
    // ここで記録と写真を読み出してから share() を呼ぶと、その待ち時間で権限が切れ、
    // Androidでは必ず失敗する。だから設定を開いた時点でファイルを作っておき、
    // クリック時は await を一切挟まずに share() を呼ぶ。
    shareBtn.addEventListener('click', () => {
      const ready = state.backupFile;
      if (!ready) {
        toast('バックアップを準備中です。少し待ってからもう一度押してください');
        prepareBackupFile(shareType);
        return;
      }
      navigator.share({ files: [ready.file], title: 'めぐログのバックアップ' })
        .then(async () => {
          await Store.markBackedUp(ready.counts);
          renderBackupStatus();
          toast('送信先を選んで保存してください');
        })
        .catch((err) => {
          if (err && err.name === 'AbortError') return;   // 本人が閉じただけ
          // 端末側の事情で共有が通らないことがある。ここで行き止まりにせず、
          // 同じファイルをそのまま保存に回す（何も起きないのが一番困る）。
          saveBackupFile(ready.file, ready.counts);
          toast('共有できなかったので、ファイルとして保存しました');
        });
    });

    state.shareType = shareType;

    $('#btn-persist').addEventListener('click', async () => {
      const r = await Store.persist();
      await renderPersistInfo();
      toast(r ? '保存を保護しました' : 'ブラウザに断られました。バックアップを取っておいてください');
    });

    $('#btn-export').addEventListener('click', async () => {
      const b = await buildBackup();
      saveBackupFile(new File([b.blob], b.name, { type: 'application/json' }), b.counts);
    });

    initPickExport();

    $('#btn-import').addEventListener('click', () => $('#import-file').click());

    $('#import-file').addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      try {
        const data = JSON.parse(await file.text());
        if (!data || data.app !== 'meguri-log') {
          throw new Error('このファイルは めぐログ の書き出しデータではありません');
        }
        // 何が起きるのかを先に見せる。黙って上書きされるのが一番こわい。
        const inFile = (data.visits || []).length;
        const inPhoto = (data.photos || []).length;
        const now = (await Store.getAllVisits()).length;
        const when = data.exportedAt ? data.exportedAt.slice(0, 10) : '不明';
        // 一部だけの書き出しは、全部のバックアップと見分けがつかないと事故になる。
        // 何のタグだけが入っているのかを先に出す。
        const note = data.partial
          ? `【一部だけの書き出しです】
`
            + `　入っているタグ: ${(data.partialTags || []).join('・') || '不明'}
`
            + `　これ1つでは元に戻せません。

`
          : '';
        const ok = confirm(
          note
          + `読み込む内容
`
          + `　記録 ${inFile}件・写真 ${inPhoto}枚（${when} に書き出したファイル）

`
          + `今この端末には ${now}件 の記録があります。
`
          + `今の記録は消さず、ファイルの中身を追加します。
`
          + `同じ記録が両方にある場合は、ファイル側の内容で上書きされます。

`
          + `読み込みますか？`
        );
        if (!ok) { e.target.value = ''; return; }

        const r = await Store.importAll(data, { merge: true });
        await refreshVisited();
        refreshMap(); renderList(); renderProgress(); renderBackupStatus();
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

    renderBackupStatus();
    renderPersistInfo();
    renderStorageInfo();
    renderDeviceInfo();   // shareType が決まったあとに呼ぶ
  }

  function renderStorageInfo() {
    Store.estimate().then((est) => {
      if (!est) return;
      const mb = (n) => (n / 1024 / 1024).toFixed(1) + ' MB';
      $('#storage-info').textContent = `使用量の目安: ${mb(est.usage || 0)} / 空き ${mb(est.quota || 0)}`;
    });
  }

  // iPadOS 13以降はMacintoshを名乗るので、タッチの有無で見分ける
  function isIOS() {
    const ua = navigator.userAgent;
    return /iPhone|iPad|iPod/.test(ua)
      || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  }

  // 保存の永続化。断られても記録は続けられるので黙って進む。
  // 「記録を保存したとき」だけに頼っていたため、設定を見に行っただけの人には
  // 一度も要求されず、いつまでも未保護と表示されていた。起動時にも頼む。
  let persistAsked = false;
  function ensurePersistOnce() {
    if (persistAsked) return Promise.resolve();
    persistAsked = true;
    return Store.persist().then(() => { renderPersistInfo(); }).catch(() => {});
  }

  // 端末の対応状況に「保存の保護」も出しておくと切り分けが早い
  function persistLabel(p, installed) {
    if (p) return '保護されている';
    return installed ? 'ホーム画面アプリ（保護の宣言はなし）' : '未保護';
  }

  async function renderBackupStatus() {
    const el = $('#backup-status');
    if (!el) return;
    const st = await Store.backupStatus();
    el.classList.remove('is-warn', 'is-ok');
    if (!st.total) { el.textContent = 'まだ記録がありません。'; return; }
    if (st.never) {
      el.textContent = `まだ一度もバックアップを取っていません（記録 ${st.total}件）。`;
      el.classList.add('is-warn');
      return;
    }
    const d = st.at.slice(0, 10);
    if (st.unsaved > 0) {
      el.textContent = `最後のバックアップ（${d}）から ${st.unsaved}件 増えています。`;
      el.classList.add('is-warn');
    } else {
      el.textContent = `${d} にバックアップ済み（記録 ${st.total}件）。`;
      el.classList.add('is-ok');
    }
  }

  async function renderPersistInfo() {
    const el = $('#persist-info');
    if (!el) return;
    const p = await Store.persisted();
    if (p === null) { el.textContent = ''; return; }
    // 永続化はこちらから頼めるだけで、許可するかはブラウザが決める。
    // iOSのように、ホーム画面アプリでは実際に保持されるのにAPIがfalseを返す
    // 環境があるため、断られた=危険とは言い切らない。
    const installed = window.matchMedia('(display-mode: standalone)').matches
      || window.navigator.standalone === true;
    const btn = $('#btn-persist');
    if (p) {
      el.textContent = '保存は保護されています（ブラウザが勝手に消すことはありません）。';
      if (btn) btn.hidden = true;
    } else if (installed) {
      el.textContent = 'ホーム画面のアプリとして開いているため、記録は通常そのまま保持されます。'
        + 'ただしブラウザからの保証はないので、ときどきバックアップを取ってください。';
      if (btn) btn.hidden = !!isIOS();          // iOSでは押しても必ず断られる
    } else if (isIOS()) {
      // iOSは保護の要求に必ずfalseを返す。押しても断られるだけのボタンは出さず、
      // 実際に効果があるホーム画面への追加を案内する。
      el.textContent = 'Safariのタブで開いています。この状態だと、しばらく使わないと'
        + 'iOSが記録を消すことがあります。共有ボタン → 「ホーム画面に追加」から'
        + 'アプリとして開いてください。';
      if (btn) btn.hidden = true;
    } else {
      el.textContent = '未保護: 空き容量が足りなくなると、ブラウザが記録を消すことがあります。'
        + 'ホーム画面に追加すると保護されやすくなります。';
      if (btn) btn.hidden = false;
    }
    el.classList.toggle('is-warn', !p && !installed);
  }

  // 端末の対応状況。写真保存がうまくいかないときの切り分けに使う。
  async function renderDeviceInfo() {
    const box = $('#device-info');
    if (!box) return;
    let canFiles = false;
    try {
      const f = new File([new Blob(['x'], { type: 'image/jpeg' })], 't.jpg', { type: 'image/jpeg' });
      canFiles = !!(navigator.canShare && navigator.canShare({ files: [f] }));
    } catch (e) { canFiles = false; }

    const ua = navigator.userAgent;
    const ios = isIOS();
    const isAndroid = /Android/.test(ua);
    const osName = ios ? 'iPhone / iPad' : (isAndroid ? 'Android' : 'パソコンなど');
    const installed = window.matchMedia('(display-mode: standalone)').matches
      || window.navigator.standalone === true;
    const persisted = await Store.persisted();
    const bkType = state.shareType;

    const rows = [
      ['アプリのバージョン', APP_VERSION],
      ['端末の種類', osName],
      ['開き方', installed ? 'ホーム画面のアプリ' : 'ブラウザのタブ'],
      ['保存の保護', persistLabel(persisted, installed)],
      ['写真の共有', canFiles ? '使えます' : '使えません'],
      ['バックアップの共有', bkType ? ('使えます（.' + bkType.ext + '）') : '使えません'],
      ['位置情報', ('geolocation' in navigator) ? '使えます' : '使えません'],
      ['オフライン起動', ('serviceWorker' in navigator) ? '使えます' : '使えません'],
    ];

    let advice;
    if (ios && canFiles) {
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
