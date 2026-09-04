/*
  app.js — めぐログ 本体

  Phase 1: 都道府県 / 市区町村の制覇 ＋ 町丁目の記録
  データの読み書きは storage.js の Store 経由でしか行わない（クラウド差し替えのため）。
*/
(() => {
  'use strict';

  // sw.js の VERSION と必ず揃えること。設定画面に表示され、
  // 端末に届いている版を目視で確認できるようにしている。
  const APP_VERSION = 'v61';

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
    { key: 'zoo',   mark: '🦁', label: '動物園・水族館' },
    { key: 'museum',mark: '🎨', label: '博物館・美術館' },
    { key: 'garden',mark: '🌸', label: '公園・庭園' },
    { key: 'tower', mark: '🗼', label: '展望台・タワー' },
    { key: 'shop',  mark: '🛍️', label: '買い物' },
    { key: 'conv',  mark: '🏪', label: 'コンビニ' },
    { key: 'food',  mark: '🍽️', label: '食事' },
    { key: 'michi', mark: '🛣️', label: '道の駅' },
    { key: 'sapa',  mark: '🅿️', label: 'SA・PA' },
    { key: 'park',  mark: '🚗', label: '駐車場' },
    { key: 'gas',   mark: '⛽', label: 'ガソリンスタンド' },
    { key: 'toilet',mark: '🚻', label: 'トイレ' },
    { key: 'mtn',   mark: '⛰️', label: '山・登山' },
    { key: 'fall',  mark: '🏞️', label: '滝' },
    { key: 'dam',   mark: '🌊', label: 'ダム' },
    { key: 'camp',  mark: '⛺', label: 'キャンプ場' },
    { key: 'light', mark: '💡', label: '灯台' },
    { key: 'onsen', mark: '♨️', label: '温泉・銭湯' },
    { key: 'hosp',  mark: '🏥', label: '病院' },
    { key: 'home',  mark: '🏠', label: '個人宅' },
    { key: 'other', mark: '✳️', label: 'その他' },
  ];
  // ★key は保存済みの記録が参照している。絶対に付け替えない★
  // v35 で公園を足すとき 'park' を使い回しかけたが、それをすると駐車場として
  // 保存済みの記録が公園に化ける。公園は 'garden' にした。
  const tagKeyOf = (k) => k || '';
  const tagOf = (k) => TAGS.find((t) => t.key === tagKeyOf(k)) || TAGS[0];

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
    hiddenTags: new Set(),   // 記録画面に出さないタグ（設定で選ぶ）
    tracking: false,         // 移動記録モード
    trackWatch: null,
    wakeLock: null,
    passed: new Set(),       // 通っただけの市区町村
    passedPref: new Set(),
    passedCounts: false,     // 通過を制覇に数えるか
    trackCount: 0,
    trackLast: '',
    lastTrack: null,
    collections: null,       // 同梱の集めるリスト（初回に読む）
    customCols: [],          // 自分で作ったリスト
    curCol: null,            // いま開いているリスト
    colLayer: null,          // 地図に出しているリストのレイヤー
    lines: null,        // 移動の線のレイヤー
    linesOn: true,
    // 通った道そのもの。[緯度, 経度, 時刻] の並び
    track: [],
    trackLineOn: true,
    trackLayer: null,
    // 駅。索引と、読み込んだ県のぶんだけ持つ（47県ぶんを常に抱えない）
    stIndex: null,
    stPref: {},
    stMode: 'pref',
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
    viewing: null,     // 見るだけの画面に出している記録
    sheetOnly: null,   // 記録シートで1件だけ出しているときの id
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
    state.hiddenTags = new Set((await Store.getMeta('hiddenTags')) || []);
    await loadPassed();
    state.geo.pref = sortByCode(await fetch(LEVELS.pref.file).then((r) => r.json()));
    await refreshVisited();

    initMap();
    initTabs();
    initLevelSwitch();
    initSheet();
    initSnsAdd();
    initViewer();
    initHistory();
    initSettings();
    initCollect();
    initStations();
    initTracking();
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
    // 「通ったところも制覇に数える」を選んでいれば、ここで足す。
    // 表示の色は styleFor で別に分けているので、薄い色のまま数だけ増える。
    if (state.passedCounts) {
      for (const id of state.passed) city.add(id);
      for (const id of state.passedPref) pref.add(id);
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

    const tl = $('#btn-track-line');
    if (tl) {
      setToggle('#btn-track-line', state.trackLineOn);
      tl.addEventListener('click', async () => {
        state.trackLineOn = !state.trackLineOn;
        setToggle('#btn-track-line', state.trackLineOn);
        await Store.setMeta('trackLineOn', state.trackLineOn);
        renderDayLines();                     // チップの出し入れも含めて描き直す
        if (state.trackLineOn && !state.track.length) toast('通った道はまだ記録されていません');
      });
    }

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
    // 前に記録した軌跡を、開いた時点で出す（refreshMap を待たない）
    drawTrack();
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
    const id = spotIdOf(state.level, feat.properties.code);
    const done = state.visited[state.level].has(id);
    // 「通っただけ」は薄い色にする。行った所と同じ色にすると、
    // 新幹線で通過しただけの県が制覇済みに見えてしまう。
    const passed = !done && passedSet(state.level).has(id);
    return {
      color: '#2c3e62',
      weight: state.level === 'city' ? 0.5 : 1,
      fillColor: done ? '#e8a33d' : (passed ? '#f0cf9a' : '#c9d2e0'),
      fillOpacity: done ? 0.75 : (passed ? 0.6 : 0.35),
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
    renderDayLines();                         // 通った道もこの中で描く
  }

  // 移動の線。同じ日に記録した地点を、記録した順に結ぶ。
  // 実際の道なりではない（Webでは背面で位置を取り続けられないため）。
  // それでも「その日どこを回ったか」は十分に見える。
  async function renderDayLines() {
    if (!state.map) return;
    if (state.lines) { state.map.removeLayer(state.lines); state.lines = null; }
    // ★線がオフでもここで帰らない★ 日付のチップは「通った道」も使う

    const all = await Store.getAllVisits();
    const byDay = new Map();
    for (const v of all) {
      if (!(v.coords && typeof v.coords.lat === 'number')) continue;
      const d = v.visitedAt || '';
      if (!d) continue;
      if (!byDay.has(d)) byDay.set(d, []);
      byDay.get(d).push(v);
    }

    // 線になる日（2か所以上）と、通った道が残っている日を合わせ、新しい順に並べる
    const days = new Set(Array.from(byDay.entries())
      .filter(function (e) { return e[1].length >= 2; })
      .map(function (e) { return e[0]; }));
    for (const d of trackDays()) days.add(d);
    const dayList = Array.from(days).sort(function (a, b) { return b.localeCompare(a); });

    // 何日分も重なると「その日どこを回ったか」が読めないので、既定は最新の1日だけ。
    // 自分で日を選ぶまでは最新の日に追従する（開いたまま今日の記録を足しても線が出るように）。
    if (dayList.length) {
      if (!state.lineDayPicked) state.lineDay = dayList[0];
      else if (state.lineDay && !dayList.includes(state.lineDay)) state.lineDay = dayList[0];
    }
    buildLineDayChips(dayList);
    drawTrack();                              // 選ばれた日に合わせて描き直す
    if (!state.linesOn) return;

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
    if (/(滝|の滝)$/.test(name)) return 'fall';
    if (/灯台$/.test(name)) return 'light';
    if (/(水族館|動物園)$/.test(name)) return 'zoo';
    if (/(博物館|美術館|記念館|資料館)$/.test(name)) return 'museum';
    if (/(公園|庭園|植物園)$/.test(name)) return 'garden';
    if (/(タワー|展望台)$/.test(name)) return 'tower';
    if (/キャンプ場$/.test(name)) return 'camp';
    if (/^(supermarket|department_store|mall|shop)$/.test(type)) return 'shop';
    if (/^(zoo|aquarium)$/.test(type)) return 'zoo';
    if (/^(museum|gallery|artwork)$/.test(type)) return 'museum';
    if (/^(park|garden)$/.test(type)) return 'garden';
    if (/^(waterfall)$/.test(type)) return 'fall';
    if (/^(lighthouse)$/.test(type)) return 'light';
    if (/^(camp_site|caravan_site)$/.test(type)) return 'camp';
    if (/^(viewpoint|tower)$/.test(type)) return 'tower';
    if (/^(attraction|theme_park)$/.test(type)) return 'play';
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
      // ★最大ズームでもばらけない束がある★
      // 「同じ場所は50m以上離れている」は名前の無い記録の話で、名前が違えば
      // 14m しか離れていない場所も別のピンになる（羽田の待機場トイレとコンビニ）。
      // 最大ズーム18でも 14m ≒ 29px で 48px の内側なので、押しても同じズームに
      // setView するだけ＝何も起きないように見えていた。
      // これ以上寄れないときは、中の場所を一覧で出して選んでもらう。
      if (next <= state.map.getZoom()) {
        L.popup({ maxWidth: 280 })
          .setLatLng([c.lat, c.lng])
          .setContent(buildClusterPopup(c))
          .openOn(state.map);
        return;
      }
      state.map.setView(b.getCenter(), next);
    });
    return m;
  }

  // 割れない束の中身。押すとその場所の吹き出しを開く
  function buildClusterPopup(c) {
    const box = document.createElement('div');
    box.className = 'cpop';
    const h = document.createElement('b');
    h.className = 'cpop__h';
    h.textContent = 'この辺りの ' + c.places.length + ' か所';
    box.appendChild(h);
    for (const g of c.places) {
      const v = g.items[0];
      const t = tagOf(v.tag);
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'cpop__row';
      row.innerHTML = '<span>' + t.mark + '</span>'
        + '<span class="cpop__n">' + escapeHtml(g.name || v.name || '') + '</span>'
        + (g.items.length > 1 ? '<small>' + g.items.length + '回</small>' : '');
      row.addEventListener('click', () => {
        state.map.closePopup();
        L.popup({ offset: [0, -30] })
          .setLatLng([g.lat, g.lng])
          .setContent(buildPinPopup(g, t))
          .openOn(state.map);
      });
      box.appendChild(row);
    }
    return box;
  }

  function buildLineDayChips(days) {
    const box = $('#line-days');
    if (!box) return;
    const wanted = ['__all__'].concat(days.slice(0, 40));
    const cur = box.dataset.days || '';
    const key = wanted.join(',');
    // ★出す・出さないは、作り直すかどうかとは別に必ず決める★
    // 以前はここを「中身が変わったときだけ」書いていたため、線を一度消して
    // もう一度出すと、日付は同じままなので早く帰ってしまい、
    // チップが隠れたきり戻らなかった。
    box.hidden = !(state.linesOn || state.trackLineOn) || !days.length;
    if (cur === key) {                       // 中身が同じなら選択状態だけ更新
      $$('#line-days .ldchip').forEach(function (b) {
        b.classList.toggle('is-on', (b.dataset.day || '__all__') === (state.lineDay || '__all__'));
      });
      return;
    }
    box.dataset.days = key;
    box.innerHTML = '';
    if (!days.length) return;

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

    // 1件でも「出かけていない」分があれば、内訳が要る
    if (g.items.length > 1 || g.items.some((it) => it.athome)) {
      const c = document.createElement('div');
      c.className = 'pinpop__date';
      // 何度も買い物する場所は、回数だけでなく合計いくら使ったかが知りたい
      // ★「出かけていない」記録は、回数にも金額にも混ぜない★
      // 自宅からの通販を日付ごとに入れると、自宅だけ何十回訪問・何万円になってしまう。
      // 消してしまうと通販の出費が見えなくなるので、足さずに横に分けて出す。
      const yen = (n) => '¥' + n.toLocaleString('ja-JP');
      const money = (list) => list.reduce((n, it) => n + (Number(it.amount) || 0), 0);
      const went = g.items.filter((it) => !it.athome);
      const away = g.items.filter((it) => it.athome);
      const wentYen = money(went);
      const awayYen = money(away);
      c.textContent = went.length + '回訪問'
        + (wentYen > 0 ? ' ・ ' + yen(wentYen) : '')
        + (away.length
            ? '（出かけていない ' + away.length + '件'
              + (awayYen > 0 ? ' ・ ' + yen(awayYen) : '') + '）'
            : '');
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
      // 行そのものを押しても見られるが、それだけだと気づけない。
      // ★何度も来ている場所は「ここに来たことを追加」しか無く、中身が見られなかった★
      main.addEventListener('click', async () => {
        state.map.closePopup();
        await openVisitViewer(item);
      });
      main.style.cursor = 'pointer';
      li.appendChild(main);
      const see = document.createElement('button');
      see.type = 'button';
      see.className = 'linkbtn';
      see.textContent = '見る';
      see.addEventListener('click', async () => {
        state.map.closePopup();
        await openVisitViewer(item);
      });
      li.appendChild(see);
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
    btn.textContent = g.items.length > 1 ? 'ここに来たことを追加' : 'この記録を見る';
    btn.addEventListener('click', async () => {
      state.map.closePopup();
      // 複数回来ている場所は「また来た」を足したいので、編集ではなく新規で開く。
      // 編集で開くと保存が最新の記録の上書きになり、回数が増えない。
      if (g.items.length > 1) await openPlaceForNewVisit(v);
      else await openVisitViewer(v);       // ★まず見せる。直すのはその先から★
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
        if (err.code === 1) {
          // ★「ブラウザの設定から」だけでは直せない人がいた★
          // iPhone/iPadは設定が3か所あり、どこを見ればいいかが分からない。
          // 手順は「使い方 → よくある質問」に置き、ここからそこへ飛ばす。
          toast(isIOS()
            ? '位置情報が拒否されています。iPhone/iPadは設定が3か所あります。'
              + '「設定」タブ →「使い方」→「よくある質問」に手順を書きました'
            : '位置情報の利用が許可されていません。ブラウザの設定から許可してください',
            isIOS() ? 9000 : undefined);
          return;
        }
        toast(err.code === 3 ? '現在地の取得に時間がかかりすぎました。空の見える場所でもう一度'
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

  // ★どのポリゴンにも入らない地点がある★
  // 埋立地（お台場・京浜島・大黒ふ頭）や、境界を簡略化した岸ぎりぎりの場所。
  // 何も返さないと「タップしても反応しない・通っても色が付かない」になる。
  // 少しだけ外に出ているだけなら、いちばん近い区域として扱う。
  // 2km。これ以上離れていたら本当に海の上なので何も返さない。
  const SNAP_DEG = 0.02;

  function findAt(level, lat, lng) {
    const gj = state.geo[level];
    if (!gj) return null;
    for (const f of gj.features) {
      for (const poly of f.geometry.coordinates) {
        if (pointInRing(lng, lat, poly[0])) return f;
      }
    }
    return nearestFeature(gj, lat, lng);
  }

  function nearestFeature(gj, lat, lng) {
    const cos = Math.cos(lat * Math.PI / 180);
    let best = SNAP_DEG * SNAP_DEG;
    let hit = null;
    for (const f of gj.features) {
      for (const poly of f.geometry.coordinates) {
        for (const pt of poly[0]) {
          const dx = (pt[0] - lng) * cos;
          const dy = pt[1] - lat;
          const d = dx * dx + dy * dy;
          if (d < best) { best = d; hit = f; }
        }
      }
    }
    return hit;
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

  async function openSheet(level, code, coords, onlyId) {
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

    // ★どの1件を見ているかは覚えておく★
    // 保存や削除のあとの描き直しは onlyId を渡してこないので、
    // 覚えていないと「何回か操作すると全部出てくる」ことになる。
    state.sheetOnly = onlyId || null;
    await renderVisitList(spotIdOf(level, code), onlyId);

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

  // ---------------------------------------------------------------
  // 記録を見るだけの画面
  // ---------------------------------------------------------------
  // ★見ることと直すことを分ける★
  // これまでは記録に触ると必ず編集画面が開いた。見返したいだけなのに
  // 入力欄が並び、うっかり書き換えてしまう。
  // カードやピンを押したときは中身を見せるだけにして、
  // 直すのは「編集」を押したときだけにする。
  async function openVisitViewer(v) {
    state.viewing = v;
    const t = tagOf(v.tag);
    $('#viewer-title').textContent = (v.place && v.place.name) || v.name || '記録';
    const sub = [];
    if (v.place && v.place.name) sub.push(v.name || '');
    if (t.key) sub.push(t.mark + ' ' + t.label);
    if (v.address && v.address.lv01Nm) sub.push(v.address.lv01Nm);
    $('#viewer-sub').textContent = sub.filter(Boolean).join(' ・ ');

    const box = $('#viewer-body');
    box.innerHTML = '';
    const row = (label, value) => {
      if (value === '' || value === null || value === undefined) return;
      const d = document.createElement('div');
      d.className = 'vrow';
      const k = document.createElement('span');
      k.className = 'vrow__k';
      k.textContent = label;
      const val = document.createElement('span');
      val.className = 'vrow__v';
      val.textContent = value;
      d.appendChild(k);
      d.appendChild(val);
      box.appendChild(d);
    };

    row('訪れた日', (v.visitedAt || '') + (v.visitedTime ? ' ' + v.visitedTime : ''));
    if (t.key) row('タグ', t.mark + ' ' + t.label);
    if (Number(v.amount) > 0) row('使った金額', '¥' + Number(v.amount).toLocaleString('ja-JP'));
    if (v.rating) row('評価', '★'.repeat(v.rating) + '☆'.repeat(5 - v.rating));
    if (v.revisit) row('', 'また行きたい');
    if (v.athome) row('', '出かけていない記録（通販・電話など）');
    if (v.goshuin && v.goshuin.name) {
      const g = v.goshuin;
      row(gsKindOf(g), [g.name, g.write, g.form, g.limited ? '限定' : ''].filter(Boolean).join(' ・ '));
    }
    if (v.memo) {
      const m = document.createElement('p');
      m.className = 'vmemo';
      m.textContent = v.memo;
      box.appendChild(m);
    }
    // 場所の情報は「その場所」の属性。ある分だけ出す
    const p = v.place || {};
    [['建物', p.building], ['住所', p.address], ['電話', p.tel], ['営業時間', p.hours],
     ['定休日', (p.closed || []).join('・')], ['サイト', p.web]]
      .forEach(([k, val]) => row(k, val || ''));
    snsList(p).forEach((x, i) => row(i ? '' : 'SNS', x));
    if (v.coords && typeof v.coords.lat === 'number') {
      const jump = document.createElement('button');
      jump.type = 'button';
      jump.className = 'linkbtn';
      jump.textContent = '地図でこの場所を見る';
      jump.addEventListener('click', () => {
        closeViewer();
        switchTab('map');
        setTimeout(() => state.map.setView([v.coords.lat, v.coords.lng], 16), 80);
      });
      box.appendChild(jump);
    }

    // 写真は最後にまとめて。読み込みで画面を待たせない
    const shots = document.createElement('div');
    shots.className = 'vshots';
    box.appendChild(shots);
    for (const pid of (v.photoIds || [])) {
      const ph = await Store.getPhoto(pid);
      if (!ph) continue;
      const img = document.createElement('img');
      img.src = URL.createObjectURL(ph.blob);
      img.alt = '';
      shots.appendChild(img);
    }

    $('#viewer').classList.add('is-open');
  }

  function closeViewer() {
    $('#viewer').classList.remove('is-open');
    // 作った URL は捨てる。開き直すたびに増えていくため
    $$('#viewer-body img').forEach((im) => {
      if (im.src.startsWith('blob:')) URL.revokeObjectURL(im.src);
    });
    state.viewing = null;
  }

  function initViewer() {
    const close = () => closeViewer();
    const c = $('#viewer-close');
    if (c) c.addEventListener('click', close);
    const bd = $('#viewer-backdrop');
    if (bd) bd.addEventListener('click', close);
    const ed = $('#viewer-edit');
    if (ed) {
      ed.addEventListener('click', async () => {
        const v = state.viewing;
        closeViewer();
        if (v) await openVisitForEdit(v);
      });
    }
  }

  function closeSheet() {
    $('#sheet').classList.remove('is-open');
    state.sheetOnly = null;
    state.selected = null;
    clearPending();
  }

  // onlyId を渡すと、その1件だけを出す。
  // ★記録タブのカードから開いたのに、その市区町村の記録が全部並んでいた★
  // 成田市に20件あると、見たかった1件がどれか分からなくなる。
  async function renderVisitList(spotId, onlyId) {
    const only = (onlyId === undefined) ? state.sheetOnly : onlyId;
    const all = await Store.getVisitsBySpot(spotId);
    const visits = only ? all.filter((v) => v.id === only) : all;
    visits.sort((a, b) => visitStamp(b).localeCompare(visitStamp(a)));
    const box = $('#visit-list');
    if (!visits.length) {
      box.innerHTML = '<p class="muted">まだ記録がありません。</p>';
      return;
    }
    box.innerHTML = '';
    // 1件だけ出しているときは、残りも見られることを言っておく（隠したままにしない）
    if (only && all.length > 1) {
      const more = document.createElement('button');
      more.type = 'button';
      more.className = 'linkbtn';
      more.style.margin = '0 0 8px';
      more.textContent = 'この市区町村の記録をすべて見る（' + all.length + '件）';
      more.addEventListener('click', () => {
        state.sheetOnly = null;              // 一度すべて出したら、そのまま
        renderVisitList(spotId, null);
      });
      box.appendChild(more);
    }
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
    $('#visit-athome').checked = !!visit.athome;
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
  // ★設定で選んだタグだけを出す★
  // タグは人によって使うものが全く違う。全部並べると記録画面が
  // 10行になってメモ欄が画面の外に出るので、自分で間引けるようにした。
  // 並びは変えない（位置が動くと押し間違える）。
  function initTagPicker(extraKey) {
    const box = $('#tag-picker');
    if (!box) return;
    box.innerHTML = '';
    const keep = tagKeyOf(extraKey);
    TAGS.forEach((t) => {
      // 未設定は常に出す。編集中の記録が使っているタグも必ず出す
      // （隠したままだと、編集で開いただけで別のタグに変わってしまう）。
      if (t.key && t.key !== keep && state.hiddenTags.has(t.key)) return;
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'tagbtn' + (t.key === '' ? ' is-active' : '');
      b.dataset.tag = t.key;
      b.innerHTML = '<span>' + t.mark + '</span>' + escapeHtml(t.label);
      b.addEventListener('click', () => setTagValue(t.key));
      box.appendChild(b);
    });
  }

  function setTagValue(key) {
    const k = tagKeyOf(key);
    // 隠してあるタグの記録を開いたときは、そのボタンを戻してから選ぶ
    if (k && !$('#tag-picker .tagbtn[data-tag="' + k + '"]')) initTagPicker(k);
    $$('#tag-picker .tagbtn').forEach((b) =>
      b.classList.toggle('is-active', b.dataset.tag === k));
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

  // 古い記録は sns が文字列1つ。新しい記録は配列。★両方読めるようにする★
  function snsList(p) {
    if (Array.isArray(p.sns)) return p.sns.filter(Boolean);
    return p.sns ? [p.sns] : [];
  }

  function addSnsRow(value) {
    const box = $('#place-sns-list');
    if (!box) return;
    const row = document.createElement('div');
    row.className = 'snsrow';
    const inp = document.createElement('input');
    inp.type = 'text';
    inp.placeholder = 'URL または @アカウント';
    inp.value = value || '';
    const x = document.createElement('button');
    x.type = 'button';
    x.className = 'snsrow__x';
    x.textContent = '×';
    x.setAttribute('aria-label', 'この行を消す');
    x.addEventListener('click', () => {
      row.remove();
      if (!box.children.length) addSnsRow('');   // 最低1行は残す
    });
    row.appendChild(inp);
    row.appendChild(x);
    box.appendChild(row);
  }

  function initSnsAdd() {
    const b = $('#place-sns-add');
    if (b) b.addEventListener('click', () => addSnsRow(''));
  }

  function setPlace(p) {
    p = p || {};
    $('#place-name').value = p.name || '';
    $('#place-building').value = p.building || '';
    $('#place-address').value = p.address || '';
    $('#place-tel').value = p.tel || '';
    $('#place-hours').value = p.hours || '';
    $('#place-web').value = p.web || '';
    const list = snsList(p);
    $('#place-sns-list').innerHTML = '';
    (list.length ? list : ['']).forEach((v) => addSnsRow(v));
    const closed = p.closed || [];
    $$('#place-closed .day').forEach((b) => b.classList.toggle('is-on', closed.includes(b.dataset.day)));
    // 何か入っていれば畳まずに開いておく（入力済みなのに隠れていると気づけない）
    const any = ['name', 'building', 'address', 'tel', 'hours', 'web'].some((k) => p[k])
      || list.length || closed.length;
    const body = $('#place-body'), tg = $('#place-toggle');
    if (any) { body.removeAttribute('hidden'); tg.classList.add('is-open'); }
    else { body.setAttribute('hidden', ''); tg.classList.remove('is-open'); }
  }

  function getPlace() {
    const closed = $$('#place-closed .day.is-on').map((b) => b.dataset.day);
    const sns = $$('#place-sns-list input').map((i) => i.value.trim()).filter(Boolean);
    const p = {
      name: $('#place-name').value.trim(),
      building: $('#place-building').value.trim(),
      address: $('#place-address').value.trim(),
      tel: $('#place-tel').value.trim(),
      hours: $('#place-hours').value.trim(),
      web: $('#place-web').value.trim(),
      sns,                              // ★配列。古い記録は文字列なので読む側で吸収する★
      closed,
    };
    const any = p.name || p.building || p.address || p.tel || p.hours || p.web
      || sns.length || closed.length;
    return any ? p : null;
  }

  function clearExtraFields() {
    $('#visit-amount').value = '';
    $('#visit-revisit').checked = false;
    $('#visit-athome').checked = false;
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
          athome: $('#visit-athome').checked,
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
          athome: $('#visit-athome').checked,
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
    card.className = 'hcard is-tap';
    // 「編集」の小さなボタンだけが入口だと気づきにくい。カードのどこを押しても開く。
    // 中のボタン・リンク・写真は、それぞれの動きを優先する。
    card.addEventListener('click', async function (e) {
      if (e.target.closest('button, a, img, input, textarea, select')) return;
      await openVisitViewer(v);            // ★見るだけ。直すのは「編集」から★
    });

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
    if (v.athome) {
      const ah = document.createElement('span');
      ah.className = 'badge badge--athome';
      ah.textContent = '出かけていない';
      badges.appendChild(ah);
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

    // ★ここに2つめのクリック処理を置かない★
    // 以前はここにも「地図へ飛んでその市区町村のシートを開く」処理があり、
    // カードの先頭で足した「見るだけ」と二重に動いていた。
    // その結果、押すたびに市区町村の記録が全部並ぶシートまで開いていた
    // （しかも1回目だけは地図の読み込みで遅れるため、たまたま正しく見えた）。
    // 地図で見たいときは、見るだけの画面の「地図でこの場所を見る」から。
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
    await openSheet(lv, code, null, v.id);
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
    // 出かけていない分（通販など）は、出かけた分と混ぜない
    const homeSpent = all.reduce(function (n, v) {
      return n + (v.athome ? (Number(v.amount) || 0) : 0);
    }, 0);
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
      if (homeSpent > 0) {
        rows.splice(1, 0,
          ['うち出かけた分', '¥' + (spent - homeSpent).toLocaleString('ja-JP')],
          ['うち出かけていない分', '¥' + homeSpent.toLocaleString('ja-JP')]);
      }
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
      const athome = all.filter(function (v) { return v.athome; });
      if (athome.length) rows.push(['出かけていない記録', athome.length + ' 件']);
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
      const cdet = $('#collect-detail');
      if (cdet && !cdet.hidden) { closeCollection(); pushBackGuard(); return; }
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
    if (name === 'collect') { if (state.curCol) renderCollectItems(); else renderCollect(); }
    // 記録したあとに設定を開いたとき、バックアップの状況が古いままにならないように
    if (name === 'settings') {
      ensurePersistOnce().then(() => { renderPersistInfo(); renderDeviceInfo(); });
      renderBackupStatus(); renderStorageInfo(); renderPickTags(); renderTagPrefs();
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
  // 移動記録モード
  // ---------------------------------------------------------------
  // ★アプリを閉じたまま裏で位置を追うことはWebではできない★
  // Service Worker（閉じても動く仕組み）の中に geolocation が存在しない。
  // プッシュ等で起こせても、起きた先で位置を取る手段が無い。ネイティブ専用の機能。
  //
  // できるのは「画面が点いている間だけ追う」こと。
  // Screen Wake Lock で画面を消させないので、車のホルダーに置く・電車で移動する
  // といった使い方なら実用になる。他のアプリに切り替えると止まる。
  //
  // 精度は要らない（市区町村が分かればよい）。enableHighAccuracy を false にすると
  // GPSを回しっぱなしにせず基地局・Wi-Fiで済ませられるので、電池の持ちが全く違う。
  const TRACK_OPTS = { enableHighAccuracy: false, maximumAge: 15000, timeout: 30000 };
  // 前回から動いていないときに何度も判定しない距離（市区町村の塗り分け用）
  const TRACK_MIN_MOVE = 150;

  // ★通った道を線で残す★
  // 市区町村を塗るだけでは「どこを通ったか」が分からない、という声から足したもの。
  // 地図の道路に色を付けているのではなく、★自分が通った点を順につないでいる★だけ。
  // それでも40mおきに拾えば、縮尺を上げたとき道なりの形になる。
  // （道路そのものに吸着させるには外部の経路照合サービスが要るので使っていない）
  const TRACK_LINE_MIN = 40;                 // これだけ動いたら点を1つ足す
  const TRACK_GAP_MS = 5 * 60 * 1000;        // これ以上間が空いたら線を切る
  const TRACK_GAP_M = 3000;                  // 距離が飛んでいても切る（閉じていた間）
  const TRACK_MAX_PTS = 30000;               // 貯めすぎない（古い方から捨てる）
  let trackSaveTimer = null;

  async function loadPassed() {
    const saved = (await Store.getMeta('passed')) || [];
    state.passed = new Set(saved);
    state.passedCounts = !!(await Store.getMeta('passedCounts'));
    const tr = await Store.getMeta('track');
    state.track = Array.isArray(tr) ? tr : [];
    const on = await Store.getMeta('trackLineOn');
    state.trackLineOn = (on === null || on === undefined) ? true : !!on;
    rebuildPassedPref();
  }

  // 動くたびに保存すると走っている間ずっと書き続けることになる。少し待ってまとめて書く。
  function saveTrackSoon() {
    if (trackSaveTimer) return;
    trackSaveTimer = setTimeout(async () => {
      trackSaveTimer = null;
      try { await Store.setMeta('track', state.track); } catch (e) { /* 端末が一杯 */ }
    }, 8000);
  }

  // 線を切るところで区切る。アプリを閉じていた間を1本の直線でつながないため。
  // 時刻（ms）→ その端末の日付 YYYY-MM-DD。
  // ★toISOString は使わない★ UTCなので朝9時前が前日になる（2つのアプリで踏んだ）
  function dayOfMs(t) {
    const d = new Date(t);
    const z = (n) => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + z(d.getMonth() + 1) + '-' + z(d.getDate());
  }

  // 通った道が残っている日。記録が1つも無い日でも、走っていれば並ぶ
  function trackDays() {
    const out = new Set();
    for (const p of state.track) out.add(dayOfMs(p[2]));
    return out;
  }

  function trackSegments(points) {
    const segs = [];
    let cur = [];
    for (const p of points) {
      if (cur.length) {
        const q = cur[cur.length - 1];
        if ((p[2] - q[2]) > TRACK_GAP_MS || distMeters(q[0], q[1], p[0], p[1]) > TRACK_GAP_M) {
          segs.push(cur); cur = [];
        }
      }
      cur.push(p);
    }
    if (cur.length) segs.push(cur);
    return segs.filter((sg) => sg.length >= 2);
  }

  function drawTrack() {
    if (!state.map) return;
    if (state.trackLayer) { state.map.removeLayer(state.trackLayer); state.trackLayer = null; }
    if (!state.trackLineOn || state.track.length < 2) return;
    // ★「その日の移動の線」と同じ日付の切り替えに従う★
    // 何日分も重なると、どれが今日の道か読めない。
    const pts = state.lineDay
      ? state.track.filter((p) => dayOfMs(p[2]) === state.lineDay)
      : state.track;
    const g = L.layerGroup();
    for (const sg of trackSegments(pts)) {
      const pts = sg.map((p) => [p[0], p[1]]);
      // 白を下に敷く。濃い地図でも薄い地図でも線が見えるように
      L.polyline(pts, { color: '#fff', weight: 7, opacity: .7,
                        lineCap: 'round', lineJoin: 'round' }).addTo(g);
      L.polyline(pts, { color: '#e8672d', weight: 3.5, opacity: .95,
                        lineCap: 'round', lineJoin: 'round' }).addTo(g);
    }
    state.trackLayer = g.addTo(state.map);
  }

  // 市区町村の通過から、都道府県の通過を作る（記録と同じ考え方）
  function rebuildPassedPref() {
    const pref = new Set();
    for (const id of state.passed) {
      const code = String(id).replace(/^city-/, '');
      if (code.length >= 2) pref.add('pref-' + parseInt(code.slice(0, 2), 10));
    }
    state.passedPref = pref;
  }

  const passedSet = (lv) => (lv === 'city' ? state.passed : state.passedPref);

  async function startTracking() {
    if (!navigator.geolocation) { toast('この端末では位置情報が使えません'); return; }
    // 市区町村の判定に要るので、先に読んでおく
    if (!(await ensureLevelData('city'))) { toast('市区町村の地図が読めませんでした'); return; }

    state.tracking = true;
    state.trackCount = 0;
    state.lastTrack = null;
    await grabWakeLock();
    // 画面を切り替えて戻ると Wake Lock は外れる。戻ったら取り直す
    document.addEventListener('visibilitychange', onTrackVisibility);
    state.trackWatch = navigator.geolocation.watchPosition(onTrackPos, onTrackErr, TRACK_OPTS);
    setToggle('#btn-track', true);
    renderTrackBar();
    toast('移動の記録を始めました。画面はつけたままにしてください');
  }

  async function stopTracking() {
    state.tracking = false;
    if (state.trackWatch != null) { navigator.geolocation.clearWatch(state.trackWatch); state.trackWatch = null; }
    document.removeEventListener('visibilitychange', onTrackVisibility);
    if (state.wakeLock) { try { await state.wakeLock.release(); } catch (e) { /* もう外れている */ } }
    state.wakeLock = null;
    // まとめ書きを待たずに、止めた時点の分を必ず残す
    if (trackSaveTimer) { clearTimeout(trackSaveTimer); trackSaveTimer = null; }
    try { await Store.setMeta('track', state.track); } catch (e) { /* 端末が一杯 */ }
    setToggle('#btn-track', false);
    renderTrackBar();
    toast('移動の記録を止めました');
  }

  async function grabWakeLock() {
    if (!navigator.wakeLock) return;          // 使えない端末もある。無くても動く
    try { state.wakeLock = await navigator.wakeLock.request('screen'); } catch (e) { state.wakeLock = null; }
  }

  function onTrackVisibility() {
    if (state.tracking && document.visibilityState === 'visible') grabWakeLock();
  }

  async function onTrackPos(pos) {
    if (!state.tracking) return;
    const lat = pos.coords.latitude, lng = pos.coords.longitude;
    // ★線は市区町村の判定より細かく拾う★
    // 150mおきだと曲がり角が全部切り落とされて、道の形にならない。
    const tail = state.track.length ? state.track[state.track.length - 1] : null;
    if (!tail || distMeters(tail[0], tail[1], lat, lng) >= TRACK_LINE_MIN) {
      state.track.push([Math.round(lat * 1e6) / 1e6, Math.round(lng * 1e6) / 1e6, Date.now()]);
      if (state.track.length > TRACK_MAX_PTS) {
        state.track.splice(0, state.track.length - TRACK_MAX_PTS);
      }
      saveTrackSoon();
      // 日付をまたいだら今日のチップが要る。自分で日を選んでいる間は触らない
      if (!state.lineDayPicked && state.lineDay !== dayOfMs(Date.now())) renderDayLines();
      else drawTrack();
    }

    // 同じ場所に留まっている間は市区町村の判定をしない
    if (state.lastTrack && distMeters(state.lastTrack.lat, state.lastTrack.lng, lat, lng) < TRACK_MIN_MOVE) return;
    state.lastTrack = { lat: lat, lng: lng };

    const f = findAt('city', lat, lng);
    if (!f) return;                            // 海の上・国外
    const id = spotIdOf('city', f.properties.code);
    if (state.passed.has(id) || state.visited.city.has(id)) {
      state.trackLast = f.properties.name;
      renderTrackBar();
      return;
    }
    state.passed.add(id);
    state.trackCount++;
    state.trackLast = f.properties.name;
    rebuildPassedPref();
    await Store.setMeta('passed', Array.from(state.passed));
    if (state.layer) state.layer.setStyle(styleFor);
    renderProgress();
    renderTrackBar();
  }

  function onTrackErr(err) {
    if (!state.tracking) return;
    // 一時的に取れないだけのことが多いので止めない。権限を切られたときだけ止める
    if (err && err.code === 1) {
      toast('位置情報が許可されていないため止めました');
      stopTracking();
    }
  }

  function renderTrackBar() {
    const bar = $('#trackbar');
    if (!bar) return;
    bar.hidden = !state.tracking;
    if (!state.tracking) return;
    const n = state.trackCount || 0;
    bar.innerHTML = '<span class="trackbar__dot"></span>'
      + '<b>移動を記録中</b>'
      + '<small>' + (n ? '新しく ' + n + ' か所' : 'まだ新しい場所はありません')
      + (state.trackLast ? '（' + escapeHtml(state.trackLast) + '）' : '') + '</small>'
      + '<i class="trackbar__stop">やめる</i>';
    const stop = bar.querySelector('.trackbar__stop');
    if (stop) stop.addEventListener('click', (e) => { e.stopPropagation(); stopTracking(); });
  }

  function initTracking() {
    const b = $('#btn-track');
    if (!b) return;
    setToggle('#btn-track', false);
    b.addEventListener('click', () => (state.tracking ? stopTracking() : startTracking()));

    const c = $('#track-counts');
    if (c) {
      c.checked = !!state.passedCounts;
      c.addEventListener('change', async () => {
        state.passedCounts = c.checked;
        await Store.setMeta('passedCounts', c.checked);
        await refreshVisited();
        refreshMap(); renderProgress(); renderList();
      });
    }
    const clr = $('#btn-track-clear');
    if (clr) clr.addEventListener('click', async () => {
      if (!state.passed.size && !state.track.length) { toast('通った記録はまだありません'); return; }
      if (!confirm('通った印と、通った道の線を全部消しますか？\n記録（ピン）そのものは消えません。')) return;
      state.passed = new Set();
      state.track = [];
      rebuildPassedPref();
      await Store.setMeta('passed', []);
      await Store.setMeta('track', []);
      drawTrack();
      await refreshVisited();
      refreshMap(); renderProgress(); renderList();
      toast('消しました');
    });
  }

  // ---------------------------------------------------------------
  // 集めるリスト（コレクション）
  // ---------------------------------------------------------------
  // ★タグとは別の軸★
  // 姫路城は「城」であり同時に「世界遺産」。タグは1つしか選べないので、
  // 集めるリストをタグに混ぜると必ずどちらかを捨てることになる。
  //
  // 同梱のリストは data/collections/*.json（ビルド時に Wikidata / ウィキペディアから
  // 作ったもの）。★利用者の端末から一括で取りに行かない★
  // 自分で作ったリストは meta に入れる（件数が小さいので専用の入れ物は作らない）。
  const BUILTIN_COLLECTIONS = [
    { id: 'whs',        file: './data/collections/whs.json' },
    { id: 'castle100',  file: './data/collections/castle100.json' },
    { id: 'castle100b', file: './data/collections/castle100b.json' },
    { id: 'castle12',     file: './data/collections/castle12.json' },
    { id: 'kokuho5',      file: './data/collections/kokuho5.json' },
    { id: 'sanmeijo',     file: './data/collections/sanmeijo.json' },
    { id: 'shikoku88',  file: './data/collections/shikoku88.json' },
    { id: 'saikoku33',  file: './data/collections/saikoku33.json' },
    { id: 'bando33',    file: './data/collections/bando33.json' },
    { id: 'chichibu34', file: './data/collections/chichibu34.json' },
    { id: 'fudo36',     file: './data/collections/fudo36.json' },
    { id: 'hanatera102', file: './data/collections/hanatera102.json' },
    { id: 'meisui100',  file: './data/collections/meisui100.json' },
    { id: 'taki100',    file: './data/collections/taki100.json' },
    { id: 'hyakumeizan', file: './data/collections/hyakumeizan.json' },
    { id: 'lighthouse50', file: './data/collections/lighthouse50.json' },
    { id: 'nisshu22',   file: './data/collections/nisshu22.json' },
    { id: 'ichinomiya', file: './data/collections/ichinomiya.json' },
    { id: 'bosou41',    file: './data/collections/bosou41.json' },
    { id: 'nanohana18', file: './data/collections/nanohana18.json' },
    { id: 'awa34',      file: './data/collections/awa34.json' },
    { id: 'asakusa9',   file: './data/collections/asakusa9.json' },
    { id: 'sakura7',    file: './data/collections/sakura7.json' },
    { id: 'ibaraki12',  file: './data/collections/ibaraki12.json' },
    { id: 'hama7',      file: './data/collections/hama7.json' },
    { id: 'yakushi91',  file: './data/collections/yakushi91.json' },
    { id: 'jizo108',    file: './data/collections/jizo108.json' },
    { id: 'sankei',     file: './data/collections/sankei.json' },
    { id: 'sanmeien',   file: './data/collections/sanmeien.json' },
    { id: 'michinoeki',   file: './data/collections/michinoeki.json' },
    { id: 'sapa',         file: './data/collections/sapa.json' },
    { id: 'sanmeibaku',   file: './data/collections/sanmeibaku.json' },
    { id: 'sanmeisen',    file: './data/collections/sanmeisen.json' },
    { id: 'yakei3',       file: './data/collections/yakei3.json' },
    { id: 'sandaiinari',  file: './data/collections/sandaiinari.json' },
    { id: 'kamakura33',   file: './data/collections/kamakura33.json' },
    { id: 'edo33',        file: './data/collections/edo33.json' },
    { id: 'kamakura24', file: './data/collections/kamakura24.json' },
  ];

  // 「もう行った」と見なす距離。城や霊場は敷地が広く、入口で記録することも
  // 門の中で記録することもあるので、ピンの統合(50m)より広く取る。
  const COLLECT_NEAR = 400;
  // 名前がぴったり同じときだけ、ここまで離れていても同じ場所とみなす。
  // 高野山のように境内が広い所や、駐車場で記録した場合を拾うため。
  // ★広げすぎない★ 隣り合った別の城や札所を巻き込む。
  const COLLECT_NEAR_NAMED = 2000;

  async function loadCollections() {
    if (state.collections) return state.collections;
    const out = [];
    for (const b of BUILTIN_COLLECTIONS) {
      try {
        const d = await fetch(b.file).then((r) => r.json());
        d.builtin = true;
        out.push(d);
      } catch (e) { /* 1つ読めなくても残りは出す */ }
    }
    state.collections = out;
    return out;
  }

  async function customCollections() {
    return (await Store.getMeta('collections')) || [];
  }

  async function saveCustom(list) {
    await Store.setMeta('collections', list);
  }

  // その項目に行ったか。記録から自動で見つかったか、手で付けたか。
  // 名前は完全一致だけだと拾えない（「姫路城」と「国宝 姫路城」）ので、
  // どちらかがどちらかを含んでいれば同じものとして扱う。
  // 返す値: '' / 'auto'（記録がある） / 'hand'（手で付けた）
  // 名前の比べ方。空白と括弧だけ落として、あとはそのまま比べる。
  const nameKey = (s) => String(s || '').replace(/[\s　（）()「」『』]/g, '');

  function visitedItem(item, visits, hand, reach) {
    // リストごとに許容する距離を変えられる。駅は密度が高いので狭くする。
    const near = (reach && reach.near) || COLLECT_NEAR;
    const nearNamed = (reach && reach.nearNamed) || COLLECT_NEAR_NAMED;
    const nm = nameKey(item.name);
    for (const v of visits) {
      const vn = nameKey(v.place && v.place.name);
      const same = !!(nm && vn && nm === vn);
      // ★位置が市区町村の中心までしか分かっていないものは、距離で数えない★
      // 本の目次には番地が無く、地図にも載っていない小さな寺がある。
      // その分は市役所のあたりに落ちている。近くを通っただけで札所に行ったことに
      // なってしまうので、名前が一致したときだけ数える。
      if (item.approx) {
        if (same) return 'auto';
        continue;
      }
      if (v.coords && typeof v.coords.lat === 'number') {
        // ★名前は「距離をどこまで許すか」にだけ使う★
        // 以前は「片方の名前がもう片方に含まれていれば同じ場所」としていたが、
        // それだと 佐倉城（100名城）を記録しただけで 本佐倉城（続100名城）にも
        // チェックが付いた。3.9km離れた別の城で、本人の指摘で発覚した。
        // 「〜城」「〜寺」は前に字が付くだけで別の場所になるので、部分一致は使わない。
        const d = distMeters(v.coords.lat, v.coords.lng, item.lat, item.lng);
        if (d <= (same ? nearNamed : near)) return 'auto';
      } else if (same) {
        // 座標の無い記録（市区町村をタップしただけ等）は名前だけで見るしかない
        return 'auto';
      }
    }
    // ★手で付けたぶん★ 昔に行ったが記録していない、というのが普通にある。
    // 自動判定だけだと、その分は永久に埋まらない。
    return (hand && hand.indexOf(item.name) >= 0) ? 'hand' : '';
  }

  // 同梱のリストに、自分で足したぶんを混ぜる。
  // 「100名城のうち1つ足りない、自分で足したい」に応えるため。分母も増える。
  function itemsOf(col, extra) {
    const add = (extra && extra[col.id]) || [];
    if (!add.length) return col.items;
    const names = new Set(col.items.map((i) => i.name));
    return col.items.concat(add.filter((i) => !names.has(i.name)).map((i) => {
      const c = Object.assign({}, i);
      c.mine = true;                      // 自分で足したものは消せるようにする
      return c;
    }));
  }

  function collectStats(col, visits, hand, extra) {
    const items = itemsOf(col, extra);
    let n = 0;
    for (const it of items) if (visitedItem(it, visits, (hand || {})[col.id], col.reach)) n++;
    return { done: n, total: items.length };
  }

  async function collectMeta() {
    const [hand, extra] = await Promise.all([
      Store.getMeta('collectDone'), Store.getMeta('collectExtra'),
    ]);
    return { hand: hand || {}, extra: extra || {} };
  }

  // ---------------------------------------------------------------
  // 鉄道駅・廃駅
  // ---------------------------------------------------------------
  // ★1本のリストにしない★
  // 全国9,153駅に対して制覇率を出しても、ほとんどの人が0%台で意味を持たない。
  // 「この県は制覇した」「この路線は乗った」で見られるよう、県別・路線別に切る。
  // ゲームにもしない（駅メモ・駅奪取があり、そこと張り合っても仕方がない）。
  //
  // 出典は Wikidata（CC0）。★OpenStreetMap は廃駅が106件しか無く使えない★
  // 都道府県はどの出典にも入っていないので、同梱の境界データから点in多角形で決めてある。
  const ST_INDEX = './data/stations/index.json';
  const stFile = (c) => './data/stations/p' + String(c).padStart(2, '0') + '.json';

  // ★駅は密度が高い★ 実測で18.6%の駅は400m以内に別の駅がある。
  // 既定の400mのままだと、1つ記録しただけで隣の駅にもチェックが入る。
  // 名前が一致したときの許容も、同名駅（日野・富田・本町…）が全国にあるので狭くする。
  const ST_REACH = { near: 150, nearNamed: 1000 };

  async function loadStationIndex() {
    if (!state.stIndex) state.stIndex = await fetch(ST_INDEX).then((r) => r.json());
    return state.stIndex;
  }

  async function loadStationPref(code) {
    if (!state.stPref[code]) {
      state.stPref[code] = await fetch(stFile(code)).then((r) => r.json());
    }
    return state.stPref[code];
  }

  // ★47県ぶん(900KB)を数のためだけに読まない★
  // 記録が1つも無い県は必ず0か所なので、読まなくても数は分かる。
  //
  // ★state.visited.pref だけを見てはいけない★
  // あれは「区域をタップして記録した」分しか入っていない。駅のように
  // 地点で記録したものは spotId を持たないので、いつまでも0県のままになる。
  // 記録の座標から県を引き直す。
  async function loadVisitedPrefStations() {
    const codes = new Set();
    for (const id of state.visited.pref) {
      const n = parseInt(String(id).replace(/^pref-/, ''), 10);
      if (n) codes.add(n);
    }
    const visits = await Store.getAllVisits();
    for (const v of visits) {
      if (!(v.coords && typeof v.coords.lat === 'number')) continue;
      const f = findAt('pref', v.coords.lat, v.coords.lng);
      if (f && f.properties && f.properties.code) codes.add(parseInt(f.properties.code, 10));
    }
    await Promise.all(Array.from(codes).map((c) => loadStationPref(c).catch(() => null)));
  }

  const stItems = (code, gone) =>
    ((state.stPref[code] || {}).items || []).filter((x) => (gone ? !!x.gone : !x.gone));

  function prefName(code) {
    const p = ((state.stIndex || {}).prefs || []).find((x) => x.code === code);
    return p ? p.name : String(code);
  }

  // 選んだ県・路線を、いつもの「集めるリスト」の形に組み立てる。
  // こうすると詳細画面（絞り込み・まだの分だけ・地図に出す・手でチェック）が
  // そのまま使える。手で付けた印は id で覚えるので、★id は変えないこと★
  function stationCol(mode, key) {
    const idx = state.stIndex;
    if (!idx) return null;
    if (mode === 'line') {
      const ln = idx.lines.find((l) => l.id === key);
      if (!ln) return null;
      const items = [];
      for (const p of ln.prefs) {
        for (const it of stItems(p, false)) {
          if (it.lines.indexOf(key) >= 0) items.push(it);
        }
      }
      return {
        id: 'st-l' + key, name: ln.name, mark: '🚃', builtin: true, station: true,
        reach: ST_REACH, items: items,
        // ★路線の分け方は運転系統と違うことがある★
        // 出典の「接続路線」は正式な路線名で入っていることが多く、
        // 山手線の駅の多くは東北本線・東海道本線として登録されている。
        // 黙っていると「17駅しかない」と誤解されるので、そう書いておく。
        note: ln.prefs.map(prefName).join('・') + 'を通る' + ln.live + '駅'
          + (ln.gone ? '（ほかに廃駅' + ln.gone + '）' : '') + '。'
          + '路線の分け方は出典（Wikidata）のもので、正式な路線名で入っているため、'
          + '普段乗っている運転系統とは駅の数が違うことがあります。',
      };
    }
    const gone = mode === 'gone';
    const p = idx.prefs.find((x) => x.code === key);
    if (!p) return null;
    return {
      id: (gone ? 'st-g' : 'st-p') + key, mark: gone ? '🚏' : '🚉',
      name: p.name + (gone ? 'の廃駅' : 'の駅'), builtin: true, station: true,
      reach: ST_REACH, items: stItems(key, gone),
      note: gone
        ? '廃止された駅。跡地に行った記録があればチェックが入ります。'
          + '出典に載っているのはウィキペディアに記事がある分なので、これで全部ではありません。'
        : p.live + '駅。廃駅' + p.gone + 'は「廃駅」から見られます。',
    };
  }

  // ★道の駅1,223か所を1本の一覧にすると探せない★ 駅と同じく、まず県を選ぶ。
  // 駅の「選ぶ画面」をそのまま借り、県別／路線別の切り替えだけ隠す。
  // 開いた先のリストは元と同じ id にする（手で付けた印や自分で足した場所が
  // 全国と県別で食い違わないように）。
  function openPrefChooser(col) {
    state.chooserCol = col;
    state.stMode = 'colpref';
    $('#collect-home').hidden = true;
    $('#collect-stations').hidden = false;
    $('#st-seg').hidden = true;
    $('#st-filter').value = '';
    $('#collect-stations .cdet__title').textContent = (col.mark || '') + ' ' + col.name;
    $('#st-note').textContent = col.items.length + 'か所。県を選ぶと、その県だけの一覧になります。'
      + (col.note ? ' ' + col.note : '');
    renderStationChooser();
  }

  function prefSlice(col, pref) {
    const items = pref ? col.items.filter((i) => i.kuni === pref) : col.items;
    return Object.assign({}, col, {
      items: items,
      name: col.name + (pref ? '（' + pref + '）' : '（全国）'),
      prefView: true,
    });
  }

  async function openStations() {
    state.chooserCol = null;
    if (state.stMode === 'colpref') state.stMode = 'pref';
    $('#st-seg').hidden = false;
    $('#collect-stations .cdet__title').textContent = '\uD83D\uDE89 鉄道駅';
    $('#collect-home').hidden = true;
    $('#collect-stations').hidden = false;
    $('#st-note').textContent = '読み込んでいます…';
    await loadStationIndex();
    await loadVisitedPrefStations();
    const i = state.stIndex;
    const live = i.prefs.reduce((a, p) => a + p.live, 0);
    const gone = i.prefs.reduce((a, p) => a + p.gone, 0);
    // ★全国の制覇率は出さない★ 9,000駅に対して0.5%では意味を持たない
    $('#st-note').textContent =
      '現役 ' + live + '駅・廃駅 ' + gone + '駅・' + i.lines.length + '路線。'
      + '県か路線を選ぶと、その中での達成が出ます。出典は Wikidata。';
    renderStationChooser();
  }

  function closeStations() {
    $('#collect-stations').hidden = true;
    $('#collect-home').hidden = false;
    renderCollect();
  }

  async function renderStationChooser() {
    const box = $('#st-list');
    if (!box) return;
    const q = (($('#st-filter') || {}).value || '').trim().toLowerCase();
    const mode = state.stMode;
    const [visits, meta] = await Promise.all([Store.getAllVisits(), collectMeta()]);
    box.innerHTML = '';

    // 道の駅・SA/PA の県別。並びは JSON の順（県コード順）をそのまま使う
    if (mode === 'colpref') {
      const col = state.chooserCol;
      if (!col) return;
      const prefs = [];
      for (const it of col.items) if (it.kuni && !prefs.includes(it.kuni)) prefs.push(it.kuni);
      const mk = (label, sub, sub2, sliceCol) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'strow';
        const st = collectStats(sliceCol, visits, meta.hand, meta.extra);
        b.innerHTML = '<span class="strow__n">' + escapeHtml(label) + '</span>'
          + (sub ? '<span class="strow__p">' + escapeHtml(sub) + '</span>' : '')
          + '<span class="strow__c"><b>' + st.done + '</b> / ' + st.total + '</span>';
        b.addEventListener('click', async () => {
          $('#collect-stations').hidden = true;
          await openCollection(sliceCol);
        });
        return b;
      };
      if (!q) box.appendChild(mk('全国', '', '', prefSlice(col, null)));
      for (const pf of prefs) {
        if (q && pf.indexOf(q) < 0) continue;
        box.appendChild(mk(pf, '', '', prefSlice(col, pf)));
      }
      return;
    }
    if (!state.stIndex) return;

    const row = (name, sub, done, total, loaded, onClick) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'strow';
      // ★数えられないものを0と言わない★
      // その県のファイルをまだ読んでいないときは、行った数が分からない。
      const count = loaded ? '<b>' + done + '</b> / ' + total : total + '駅';
      b.innerHTML = '<span class="strow__n">' + escapeHtml(name) + '</span>'
        + (sub ? '<span class="strow__p">' + escapeHtml(sub) + '</span>' : '')
        + '<span class="strow__c">' + count + '</span>';
      b.addEventListener('click', onClick);
      return b;
    };

    if (mode === 'line') {
      const hit = state.stIndex.lines
        .filter((l) => l.live > 0 && (!q || l.name.toLowerCase().indexOf(q) >= 0));
      if (!hit.length) {
        box.innerHTML = '<p class="muted" style="padding:12px">該当がありません。</p>';
        return;
      }
      for (const l of hit.slice(0, 400)) {
        const loaded = l.prefs.every((c) => state.stPref[c]);
        let done = 0;
        if (loaded) {
          const col = stationCol('line', l.id);
          if (col) done = collectStats(col, visits, meta.hand, meta.extra).done;
        }
        box.appendChild(row(l.name, l.prefs.map(prefName).join('・'),
          done, l.live, loaded, () => openStationCol('line', l.id)));
      }
      // ★黙って打ち切らない★ 何本隠れているかを必ず言う
      if (hit.length > 400) {
        const p = document.createElement('p');
        p.className = 'muted';
        p.style.padding = '10px 12px';
        p.textContent = 'ほかに ' + (hit.length - 400) + ' 路線あります。上の欄で絞り込んでください。';
        box.appendChild(p);
      }
      return;
    }

    const gone = mode === 'gone';
    const hit = state.stIndex.prefs
      .filter((p) => (gone ? p.gone : p.live) > 0 && (!q || p.name.indexOf(q) >= 0));
    if (!hit.length) {
      box.innerHTML = '<p class="muted" style="padding:12px">該当がありません。</p>';
      return;
    }
    for (const p of hit) {
      const loaded = !!state.stPref[p.code];
      let done = 0;
      if (loaded) {
        const col = stationCol(mode, p.code);
        if (col) done = collectStats(col, visits, meta.hand, meta.extra).done;
      }
      box.appendChild(row(p.name, '', done, gone ? p.gone : p.live, loaded,
        () => openStationCol(mode, p.code)));
    }
  }

  async function openStationCol(mode, key) {
    if (mode === 'line') {
      const ln = state.stIndex.lines.find((l) => l.id === key);
      // 路線は県をまたぐ（東海道本線は8都府県）。通る県のぶんだけ読む。
      await Promise.all((ln ? ln.prefs : []).map((c) => loadStationPref(c).catch(() => null)));
    } else {
      await loadStationPref(key).catch(() => null);
    }
    const col = stationCol(mode, key);
    if (!col || !col.items.length) { toast('読み込めませんでした'); return; }
    $('#collect-stations').hidden = true;
    await openCollection(col);
  }

  function initStations() {
    const back = $('#btn-st-back');
    if (back) back.addEventListener('click', closeStations);
    const seg = $('#st-seg');
    if (seg) {
      seg.addEventListener('click', (e) => {
        const b = e.target.closest('.stseg__b');
        if (!b) return;
        state.stMode = b.dataset.mode;
        seg.querySelectorAll('.stseg__b').forEach((x) => x.classList.toggle('is-on', x === b));
        renderStationChooser();
      });
    }
    const f = $('#st-filter');
    if (f) f.addEventListener('input', () => renderStationChooser());
  }

  async function renderCollect() {
    const box = $('#collect-list');
    const mine = $('#collect-custom');
    if (!box) return;
    const [cols, custom, visits, meta] = await Promise.all([
      loadCollections(), customCollections(), Store.getAllVisits(), collectMeta(),
    ]);
    state.customCols = custom;
    state.collectMeta = meta;

    const card = (col) => {
      const s = collectStats(col, visits, meta.hand, meta.extra);
      const pct = s.total ? Math.round((s.done / s.total) * 100) : 0;
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'ccard' + (s.done ? ' is-started' : '');
      b.innerHTML =
        '<span class="ccard__mark">' + (col.mark || '📋') + '</span>'
        + '<span class="ccard__body">'
        + '<b>' + escapeHtml(col.name)
        + (col.area ? '<i class="ccard__area">' + escapeHtml(col.area) + '</i>' : '')
        + '</b>'
        + '<span class="ccard__bar"><i style="width:' + pct + '%"></i></span>'
        + '<small>' + s.done + ' / ' + s.total + ' か所（' + pct + '%）</small>'
        + '</span>';
      b.addEventListener('click', () => (col.byPref ? openPrefChooser(col) : openCollection(col)));
      return b;
    };

    // ★区分ごとの見出しで分ける★
    // 巡礼は地域ごとに無数にあり、これから増える。ただ並べると探せなくなる。
    // 地域（関東・四国など）はカードの名前の横に出す。
    box.innerHTML = '';
    const groups = [];
    for (const c of cols) {
      const g = c.group || 'そのほか';
      let bucket = groups.find((x) => x.name === g);
      if (!bucket) { bucket = { name: g, cols: [] }; groups.push(bucket); }
      bucket.cols.push(c);
    }
    // ★35本を全部並べると探せない★ 見出しを押すと畳める。畳んだ見出しは端末に覚える
    const folded = new Set((await Store.getMeta('collectFold')) || []);
    for (const g of groups) {
      const h = document.createElement('button');
      h.type = 'button';
      h.className = 'cgroup cgroup--btn' + (folded.has(g.name) ? ' is-folded' : '');
      h.innerHTML = '<i class="cgroup__caret"></i>' + escapeHtml(g.name) + '（' + g.cols.length + '）';
      const body = document.createElement('div');
      body.className = 'cgroup__body';
      body.hidden = folded.has(g.name);
      g.cols.forEach((c) => body.appendChild(card(c)));
      h.addEventListener('click', async () => {
        const now = !body.hidden;              // 今開いているなら畳む
        body.hidden = now;
        h.classList.toggle('is-folded', now);
        if (now) folded.add(g.name); else folded.delete(g.name);
        await Store.setMeta('collectFold', Array.from(folded));
      });
      box.appendChild(h);
      box.appendChild(body);
    }
    // 駅は桁が違うので、制覇率つきのカードにはしない。
    // 「全国9,153駅のうち12駅」と出しても意味を持たないため、入口だけ置く。
    const sh = document.createElement('p');
    sh.className = 'cgroup';
    sh.textContent = '駅（県別・路線別）';
    box.appendChild(sh);
    const sb = document.createElement('button');
    sb.type = 'button';
    sb.className = 'ccard';
    sb.innerHTML = '<span class="ccard__mark">🚉</span>'
      + '<span class="ccard__body"><b>鉄道駅<i class="ccard__area">全国</i></b>'
      + '<small>県か路線を選んでから見ます。廃駅も入っています。</small></span>';
    sb.addEventListener('click', () => openStations());
    box.appendChild(sb);

    mine.innerHTML = '';
    if (!custom.length) {
      mine.innerHTML = '<p class="muted" style="padding:4px 2px">まだありません。</p>';
    } else {
      custom.forEach((c) => mine.appendChild(card(c)));
    }
  }

  async function openCollection(col) {
    state.curCol = col;
    $('#collect-home').hidden = true;
    $('#collect-detail').hidden = false;
    $('#cdet-title').textContent = (col.mark || '📋') + ' ' + col.name;
    $('#cdet-note').textContent = col.note || '';
    // 「足りない分を自分で足したい」に応えるため、同梱のリストでも追加はできる。
    // 消せるのは自分のリストだけ（同梱の中身を壊さないため）。
    $('#cdet-acts').hidden = false;
    $('#btn-cdet-del').hidden = !!col.builtin;
    $('#btn-cdet-share').hidden = !!col.builtin;
    $('#cdet-filter').value = '';
    $('#cdet-todo').checked = false;
    await renderCollectItems();
  }

  function closeCollection() {
    const fromStations = !!(state.curCol && (state.curCol.station || state.curCol.prefView));
    state.curCol = null;
    $('#collect-detail').hidden = true;
    if (fromStations) {
      // 駅は「県別 → その県の駅」の2段になっている。いちばん上まで戻されると
      // 選び直すのが大変なので、選ぶ画面に戻す。
      $('#collect-stations').hidden = false;
      renderStationChooser();
    } else {
      $('#collect-home').hidden = false;
      renderCollect();
    }
  }

  async function renderCollectItems() {
    const col = state.curCol;
    if (!col) return;
    const [visits, meta] = await Promise.all([Store.getAllVisits(), collectMeta()]);
    state.collectMeta = meta;
    const hand = meta.hand[col.id] || [];
    const items = itemsOf(col, meta.extra);
    const q = ($('#cdet-filter').value || '').trim().toLowerCase();
    const todoOnly = $('#cdet-todo').checked;

    let done = 0;
    const rows = items.map((it) => {
      const been = visitedItem(it, visits, hand, col.reach);
      if (been) done++;
      return { it: it, been: been };
    });
    const pct = items.length ? Math.round((done / items.length) * 100) : 0;
    $('#cdet-bar').style.width = pct + '%';
    $('#cdet-text').textContent = done + ' / ' + items.length + ' か所（' + pct + '%）';

    const box = $('#cdet-items');
    box.innerHTML = '';
    const shown = rows.filter((r) =>
      (!todoOnly || !r.been)
      && (!q || (r.it.name + ' ' + (r.it.kuni || '')).toLowerCase().indexOf(q) >= 0));
    if (!shown.length) {
      box.innerHTML = '<p class="muted" style="padding:12px">該当がありません。</p>';
      return;
    }
    for (const r of shown) {
      const row = document.createElement('div');
      row.className = 'citem' + (r.been ? ' is-done' : '');

      // ★丸を押すと手で「行った」を付けられる★
      // 昔に行ったが記録していない分は、自動判定だけでは永久に埋まらない。
      // 記録から見つかったものは押しても外さない（記録の方が確かなため）。
      const chk = document.createElement('button');
      chk.type = 'button';
      chk.className = 'citem__chk' + (r.been === 'hand' ? ' is-hand' : '');
      chk.textContent = r.been ? '✓' : '';
      chk.title = r.been === 'auto' ? '記録があります'
        : (r.been === 'hand' ? '手で付けました。押すと外します' : '押すと「行った」にします');
      chk.addEventListener('click', () => toggleHand(col, r.it, r.been));
      row.appendChild(chk);

      const jump = document.createElement('button');
      jump.type = 'button';
      jump.className = 'citem__go';
      const no = r.it.no ? '<b class="citem__no">' + r.it.no + '</b>' : '';
      // 旧国名があれば添える。一の宮は「どの国の一宮か」がそのまま意味になる
      const kuni = r.it.kuni ? '<i class="citem__kuni">' + escapeHtml(r.it.kuni) + '</i>' : '';
      // 位置が市区町村の中心までしか分かっていないものは、そう言っておく。
      // 黙って地図に置くと「その場所にある」と読まれてしまう。
      const rough = r.it.approx ? '<i class="citem__rough" title="番地が資料に無く、'
        + '地図にも載っていないため、市区町村の中心に置いています">およその位置</i>' : '';
      jump.innerHTML = no + escapeHtml(r.it.name) + kuni + rough
        + (r.it.mine ? '<i class="citem__mine">自分で追加</i>' : '')
        // メモがあれば名前の下に出す。もらったリストの「搬入口は裏」などが読めないと用をなさない
        + (r.it.note ? '<small class="citem__note">' + escapeHtml(r.it.note) + '</small>' : '')
        + (r.it.address ? '<small class="citem__addr">' + escapeHtml(r.it.address) + '</small>' : '');
      jump.addEventListener('click', () => {
        switchTab('map');
        // おおよその位置なら寄りすぎない。近づくほど「ここにある」と見えてしまう
        setTimeout(() => state.map.setView([r.it.lat, r.it.lng], r.it.approx ? 13 : 16), 80);
      });
      row.appendChild(jump);

      if (r.it.mine) {
        const del = document.createElement('button');
        del.type = 'button';
        del.className = 'citem__del';
        del.textContent = '×';
        del.title = 'この項目を消す';
        del.addEventListener('click', () => removeExtra(col, r.it));
        row.appendChild(del);
      } else if (!r.been) {
        const rec = document.createElement('button');
        rec.type = 'button';
        rec.className = 'mapsearch__rec';
        rec.textContent = '記録';
        rec.addEventListener('click', () => {
          switchTab('map');
          setTimeout(() => {
            state.map.setView([r.it.lat, r.it.lng], 16);
            recordLandmark(r.it.name, { tag: col.tag || '' }, r.it.lat, r.it.lng);
          }, 80);
        });
        row.appendChild(rec);
      }
      box.appendChild(row);
    }
  }

  // 手で「行った」を付ける・外す。
  async function toggleHand(col, item, been) {
    if (been === 'auto') { toast('記録があるので「行った」になっています'); return; }
    const meta = await collectMeta();
    const list = meta.hand[col.id] || [];
    const i = list.indexOf(item.name);
    if (i >= 0) list.splice(i, 1);
    else list.push(item.name);
    meta.hand[col.id] = list;
    await Store.setMeta('collectDone', meta.hand);
    await renderCollectItems();
    toast(i >= 0 ? '「行った」を外しました' : item.name + ' に「行った」を付けました');
  }

  async function removeExtra(col, item) {
    const meta = await collectMeta();
    const list = (meta.extra[col.id] || []).filter((i) => i.name !== item.name);
    meta.extra[col.id] = list;
    await Store.setMeta('collectExtra', meta.extra);
    await renderCollectItems();
    toast('消しました');
  }

  // 地図にこのリストを出す。まだ行っていない所が見えるのが目的なので、
  // 行った所は薄く、まだの所をはっきり出す。
  async function showCollectionOnMap() {
    const col = state.curCol;
    if (!col) return;
    const [visits, meta] = await Promise.all([Store.getAllVisits(), collectMeta()]);
    const hand = meta.hand[col.id] || [];
    const items = itemsOf(col, meta.extra);
    state.colLayerName = col.name;
    if (state.colLayer) { state.map.removeLayer(state.colLayer); state.colLayer = null; }
    const g = L.layerGroup();
    for (const it of items) {
      const been = visitedItem(it, visits, hand);
      const m = L.circleMarker([it.lat, it.lng], {
        radius: been ? 5 : 8,
        color: been ? '#9aa7b8' : '#c0392b',
        fillColor: been ? '#c9d2e0' : '#e8a33d',
        fillOpacity: been ? 0.5 : 0.95,
        weight: 2,
      });
      m.bindTooltip((been ? '✓ ' : '') + (it.no ? it.no + '. ' : '') + it.name);
      m.on('click', () => {
        if (been) { toast(it.name + '：記録があります'); return; }
        recordLandmark(it.name, { tag: col.tag || '' }, it.lat, it.lng);
      });
      g.addLayer(m);
    }
    state.colLayer = g.addTo(state.map);
    switchTab('map');
    const b = L.latLngBounds(items.map((i) => [i.lat, i.lng]));
    setTimeout(() => {
      state.map.invalidateSize();
      state.map.fitBounds(b.pad(0.1));
    }, 120);
    $('#btn-col-clear').hidden = false;
    $('#btn-col-clear').textContent = '「' + col.name + '」を消す';
    toast('まだの所を濃い色で出しています');
  }

  function clearCollectionLayer() {
    if (state.colLayer) { state.map.removeLayer(state.colLayer); state.colLayer = null; }
    const b = $('#btn-col-clear');
    if (b) b.hidden = true;
  }

  async function newCustomCollection() {
    const name = prompt('リストの名前（例: 聖地巡礼、地元の祭り）');
    if (!name || !name.trim()) return;
    const list = await customCollections();
    const id = 'c-' + Date.now().toString(36);
    list.push({ id, name: name.trim(), mark: '📋', tag: '', note: '自分で作ったリスト', items: [] });
    await saveCustom(list);
    renderCollect();
    toast('作りました。「場所を追加」で足していけます');
  }

  // ★自分の記録からリストを作る★
  // 「行ったお店」「回った城」はもう記録の中にある。それをリストにすれば人に渡せる。
  // ★記録そのものを渡さない★ 訪問日・写真・メモ・金額は入れない。
  // 記録を渡すと相手の履歴に自分の訪問が混ざるが、リストなら相手は「まだ行っていない所」
  // として見られる。このアプリでやりたいのは後者。
  async function collectionFromTag() {
    const all = await Store.getAllVisits();
    const counts = new Map();
    for (const v of all) {
      if (!(v.coords && typeof v.coords.lat === 'number')) continue;
      const k = tagKeyOf(v.tag);
      counts.set(k, (counts.get(k) || 0) + 1);
    }
    // ★全部のタグを出す★ 記録があるものだけ並べると、何が選べるのか分からない
    const opts = TAGS.slice();
    const lines = opts.map((t, i) => (i + 1) + '. ' + t.mark + ' ' + t.label
      + '（' + (counts.get(t.key) || 0) + '件）').join('\n');
    const a = prompt('どのタグからリストを作りますか？ 番号を入れてください。\n\n' + lines, '1');
    const n = parseInt(a, 10);
    if (!(n >= 1 && n <= opts.length)) return;
    const tag = opts[n - 1];

    // 同じ場所は1つにまとめる（何度も行った店が何度も並ばないように）
    const picked = all.filter((v) => tagKeyOf(v.tag) === tag.key
      && v.coords && typeof v.coords.lat === 'number');
    const items = groupByPlace(picked).map((g) => ({
      name: (g.name || '').trim() || (g.items[0] && g.items[0].name) || '名前なし',
      lat: Math.round(g.lat * 1e6) / 1e6,
      lng: Math.round(g.lng * 1e6) / 1e6,
    }));
    if (!items.length) { toast('作れる場所がありませんでした'); return; }

    const nm = prompt('リストの名前', tag.label + 'で行ったところ');
    if (!nm || !nm.trim()) return;
    const list = await customCollections();
    list.push({
      id: 'c-' + Date.now().toString(36), name: nm.trim(), mark: tag.mark,
      tag: tag.key, note: '自分の記録（' + tag.label + '）から作ったリスト', items: items,
    });
    await saveCustom(list);
    await renderCollect();
    toast(items.length + ' か所のリストを作りました');
  }

  async function deleteCustomCollection() {
    const col = state.curCol;
    if (!col || col.builtin) return;
    if (!confirm('「' + col.name + '」を削除しますか？\n記録そのものは消えません。')) return;
    const list = (await customCollections()).filter((c) => c.id !== col.id);
    await saveCustom(list);
    closeCollection();
    toast('削除しました');
  }

  // 自分のリストに場所を足す。名前だけだと地図に出せないので、
  // 場所検索（手元＋インターネット）で座標ごと選んでもらう。
  async function addToCustomCollection() {
    const col = state.curCol;
    if (!col) return;
    const word = prompt('追加する場所の名前（例: 大洗磯前神社）');
    if (!word || !word.trim()) return;
    const text = word.trim();
    let hits = [];
    toast('探しています…');
    try { hits = await searchOnline(text); } catch (e) { hits = []; }
    if (!hits.length) {
      const visits = await Store.getAllVisits();
      hits = searchPlaces(text, 5, visits).filter((h) => h.src === 'visit');
    }
    if (!hits.length) { toast('見つかりませんでした'); return; }
    const pick = hits.length === 1 ? hits[0] : hits[Math.max(0, chooseIndex(hits))];
    if (!pick) return;
    const row = { name: pick.name, lat: pick.lat, lng: pick.lng };

    if (col.builtin) {
      // 同梱のリストは書き換えず、足したぶんだけ別に持つ。
      // こうしておくと、あとで同梱データを直しても自分の追加が消えない。
      const meta = await collectMeta();
      const list = meta.extra[col.id] || [];
      if (list.some((i) => i.name === row.name)) { toast('もう入っています'); return; }
      list.push(row);
      meta.extra[col.id] = list;
      await Store.setMeta('collectExtra', meta.extra);
      await renderCollectItems();
      toast(pick.name + ' を追加しました（自分で追加した分）');
      return;
    }

    const list = await customCollections();
    const target = list.find((c) => c.id === col.id);
    if (!target) return;
    if (target.items.some((i) => i.name === row.name)) { toast('もう入っています'); return; }
    target.items.push(row);
    await saveCustom(list);
    state.curCol = target;
    await renderCollectItems();
    toast(pick.name + ' を追加しました');
  }

  // 候補が複数あるときに1つ選んでもらう。番号で聞く（選択画面を別に作らない）。
  function chooseIndex(hits) {
    const lines = hits.map((h, i) => (i + 1) + '. ' + h.name + '（' + h.sub + '）').join('\n');
    const a = prompt('どれですか？ 番号を入れてください。\n\n' + lines, '1');
    const n = parseInt(a, 10);
    return isFinite(n) && n >= 1 && n <= hits.length ? n - 1 : -1;
  }

  // ★自作リストを人に渡せるようにする★
  // 巡礼や霊場は地域ごとに無数にあり、廃れたものや期間限定のものもある。
  // 全部を同梱するのは無理なので、1人が作ったものを他の人が使える形にしておく。
  // 中身は場所の名前と座標だけ。自分の記録（訪問日・写真・メモ）は入らない。
  function collectionFile(col) {
    const data = {
      app: 'meguri-log',
      kind: 'collection',
      version: 1,
      exportedAt: new Date().toISOString(),
      collection: {
        name: col.name,
        mark: col.mark || '📋',
        tag: col.tag || '',
        note: col.note || '',
        items: (col.items || []).map((i) => {
          const o = { name: i.name, lat: i.lat, lng: i.lng };
          if (i.no) o.no = i.no;
          if (i.note) o.note = i.note;          // 渡す相手にも同じメモが要る
          if (i.address) o.address = i.address;
          return o;
        }),
      },
    };
    const name = 'meguri-list-' + String(col.name).replace(/[^\p{L}\p{N}ー・]/gu, '')
      + '-' + todayLocal() + '.json';
    return { data: data, name: name, blob: new Blob([JSON.stringify(data)], { type: 'application/json' }) };
  }

  function shareCollection() {
    const col = state.curCol;
    if (!col || col.builtin) return;
    if (!col.items || !col.items.length) { toast('まだ場所が入っていません'); return; }
    const f = collectionFile(col);
    const st = state.shareType;
    // 共有は押された直後にしか通らないので、ここで await を挟まない
    if (st && navigator.share) {
      const file = new File([f.blob], f.name.replace(/\.json$/, '.' + st.ext), { type: st.type });
      navigator.share({ files: [file], title: 'めぐログのリスト：' + col.name })
        .then(() => toast('送信先を選んでください'))
        .catch((err) => {
          if (err && err.name === 'AbortError') return;
          saveFile(new File([f.blob], f.name, { type: 'application/json' }));
          toast('共有できなかったので、ファイルとして保存しました');
        });
      return;
    }
    saveFile(new File([f.blob], f.name, { type: 'application/json' }));
    toast('ファイルに保存しました');
  }

  async function importCollectionFile(file) {
    let d = null;
    try { d = JSON.parse(await file.text()); } catch (e) { d = null; }
    const c = d && d.collection;
    if (!d || d.app !== 'meguri-log' || d.kind !== 'collection' || !c || !Array.isArray(c.items)) {
      toast('このファイルは めぐログ のリストではありません');
      return;
    }
    // 座標が無いものは地図に出せないので入れない
    // ★もらったリストのメモを捨てない★
    // 配送先のように「どこで何をするか」が書いてあると、名前だけでは用が足りない。
    const items = c.items
      .filter((i) => typeof i.lat === 'number' && typeof i.lng === 'number' && i.name)
      .map((i) => {
        const o = { name: i.name, lat: i.lat, lng: i.lng };
        if (i.no) o.no = i.no;
        if (typeof i.note === 'string' && i.note) o.note = i.note.slice(0, 300);
        if (typeof i.address === 'string' && i.address) o.address = i.address.slice(0, 200);
        return o;
      });
    if (!items.length) { toast('中身がありませんでした'); return; }
    const list = await customCollections();
    const dup = list.find((x) => x.name === c.name);
    const ok = confirm('「' + c.name + '」を読み込みます。\n' + items.length + ' か所'
      + (dup ? '\n\n同じ名前のリストが既にあります。別のリストとして足します。' : '')
      + '\n\n読み込みますか？');
    if (!ok) return;
    list.push({
      id: 'c-' + Date.now().toString(36),
      name: dup ? c.name + '（読み込み）' : c.name,
      mark: c.mark || '📋', tag: c.tag || '', note: c.note || 'もらったリスト',
      items: items,
    });
    await saveCustom(list);
    await renderCollect();
    toast('読み込みました（' + items.length + ' か所）');
  }

  function initCollect() {
    const back = $('#btn-collect-back');
    if (!back) return;
    back.addEventListener('click', closeCollection);
    $('#btn-collect-map').addEventListener('click', showCollectionOnMap);
    // 下にも同じものを置いてある（100件あると上まで戻るのが大変）
    $('#btn-collect-back2').addEventListener('click', closeCollection);
    $('#btn-collect-map2').addEventListener('click', showCollectionOnMap);
    $('#btn-collect-new').addEventListener('click', newCustomCollection);
    $('#btn-cdet-add').addEventListener('click', addToCustomCollection);
    $('#btn-cdet-del').addEventListener('click', deleteCustomCollection);
    $('#btn-cdet-share').addEventListener('click', shareCollection);
    $('#btn-collect-fromtag').addEventListener('click', collectionFromTag);
    $('#btn-collect-import').addEventListener('click', () => $('#collect-file').click());
    $('#collect-file').addEventListener('change', async (e) => {
      const f = e.target.files[0];
      if (f) await importCollectionFile(f);
      e.target.value = '';
    });
    let t = null;
    $('#cdet-filter').addEventListener('input', () => {
      clearTimeout(t); t = setTimeout(renderCollectItems, 180);
    });
    $('#cdet-todo').addEventListener('change', renderCollectItems);
    const clr = $('#btn-col-clear');
    if (clr) clr.addEventListener('click', clearCollectionLayer);
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
    // ★全部のタグを出す★ 記録があるものだけ出していたが、
    // それだと「このタグは選べないのか、そもそも無いのか」が分からない。
    // 件数を添えて全部並べ、0件のものは薄く出す（選ぶことはできる）。
    TAGS.forEach((t) => {
      const n = counts.get(t.key) || 0;
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'pktag' + (state.pickTags.has(t.key) ? ' is-on' : '') + (n ? '' : ' is-zero');
      b.innerHTML = t.mark + ' ' + escapeHtml(t.label) + ' <small>' + n + '</small>';
      b.addEventListener('click', () => {
        if (state.pickTags.has(t.key)) state.pickTags.delete(t.key);
        else state.pickTags.add(t.key);
        b.classList.toggle('is-on');
        schedulePick();
      });
      box.appendChild(b);
    });
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

  // ---------------------------------------------------------------
  // 使うタグを選ぶ
  // ---------------------------------------------------------------
  // ここで外しても、既にそのタグで保存した記録はそのまま残る。
  // 統計も「選んで書き出す」も絞らない（記録が見えなくなると困る）。
  // 変わるのは「記録画面で選べるタグ」だけ。
  async function renderTagPrefs() {
    const box = $('#tag-prefs');
    if (!box) return;
    const used = new Map();
    for (const v of await Store.getAllVisits()) {
      const k = tagKeyOf(v.tag);
      used.set(k, (used.get(k) || 0) + 1);
    }
    box.innerHTML = '';
    TAGS.forEach((t) => {
      if (!t.key) return;                       // 未設定は外せない
      const on = !state.hiddenTags.has(t.key);
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'pktag' + (on ? ' is-on' : '');
      b.dataset.tag = t.key;
      const n = used.get(t.key) || 0;
      b.innerHTML = t.mark + ' ' + escapeHtml(t.label) + (n ? ' <small>' + n + '</small>' : '');
      b.addEventListener('click', async () => {
        if (state.hiddenTags.has(t.key)) state.hiddenTags.delete(t.key);
        else state.hiddenTags.add(t.key);
        b.classList.toggle('is-on');
        await Store.setMeta('hiddenTags', Array.from(state.hiddenTags));
        initTagPicker();
        renderTagPrefsCount();
      });
      box.appendChild(b);
    });
    renderTagPrefsCount();
  }

  function renderTagPrefsCount() {
    const el = $('#tag-prefs-count');
    if (!el) return;
    const all = TAGS.filter((t) => t.key).length;
    const on = all - state.hiddenTags.size;
    el.textContent = '記録画面に ' + on + ' / ' + all + ' 種を出します。';
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
      // ★Chromeで開いていても「Safari」と言わない★ iPhone/iPadのChromeは中身が
      // Safariと同じ部品なので扱いは同じだが、使っている人にはChromeでしかない。
      // ★「共有ボタン」で分からなかった人がいる★ 形と場所まで書く。
      // ★ホーム画面のアプリは入れ物が別★ 今の記録は自動では移らない。
      //   黙って案内すると、追加した先が空で「消えた」と思わせる。
      const chrome = /CriOS/.test(navigator.userAgent);
      const where = chrome
        ? 'Chromeの右上「…」→「共有」'
        : 'Safariの画面上部にある、四角から上向きの矢印が出たボタン（共有）';
      el.textContent = (chrome ? 'Chrome' : 'Safari') + 'のタブで開いています。'
        + 'この状態だと、しばらく使わないとiOSが記録を消すことがあります。'
        + where + ' → 「ホーム画面に追加」で、アプリとして開けます。'
        + '★ホーム画面のアプリは記録の入れ物が別です★ 先にここで「バックアップ」を'
        + '書き出し、追加したアプリを開いてから「読み込む」で移してください。';
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
  function toast(msg, ms) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.add('is-on');
    clearTimeout(toast._timer);
    // 長い案内（位置情報の設定手順など）は 2.6秒では読み切れないので、指定があれば延ばす
    toast._timer = setTimeout(() => t.classList.remove('is-on'), ms || 2600);
  }

  window.addEventListener('DOMContentLoaded', () => {
    boot().catch((e) => {
      console.error(e);
      alert('起動に失敗しました: ' + e.message);
    });
  });
})();
