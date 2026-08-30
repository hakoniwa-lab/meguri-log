/* めぐログ — Service Worker
   圏外の山の中の城跡や神社でも記録できるよう、アプリ本体と地図データを端末に置く。
   地図タイルはオンライン時のみ。閲覧済みタイルは一定枚数だけ残す。 */
/* ★デプロイ時の必須作業★
   index.html / css / js / data を変更したら、必ず VERSION を上げること。
   上げないと、既に開いたことのある端末は古いキャッシュを返し続け、
   修正がいつまでも届かない（Service Workerは sw.js 自体が変わったときだけ再インストールされる）。 */
const VERSION = 'v35';
const SHELL = 'meguri-shell-' + VERSION;
const TILES = 'meguri-tiles-' + VERSION;
const TILE_LIMIT = 400;

const SHELL_FILES = [
  './',
  './index.html',
  './css/style.css',
  './js/app.js',
  './js/storage.js',
  './vendor/leaflet.js',
  './vendor/leaflet.css',
  './vendor/images/marker-icon.png',
  './vendor/images/marker-icon-2x.png',
  './vendor/images/marker-shadow.png',
  './data/prefectures.geojson',
  './manifest.webmanifest',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(SHELL_FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k !== SHELL && k !== TILES).map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // 地図タイル: あればキャッシュを返しつつ裏で更新（stale-while-revalidate）
  // 地図の種類を選べるようにしたので、地理院（淡色・航空写真）もここに含める。
  // 含め忘れると、選んだ種類のときだけ圏外で地図が真っ白になる。
  if (url.hostname.endsWith('tile.openstreetmap.org') ||
      url.hostname === 'cyberjapandata.gsi.go.jp') {
    e.respondWith(
      caches.open(TILES).then(async (cache) => {
        const hit = await cache.match(req);
        const net = fetch(req).then((res) => {
          if (res && res.status === 200) {
            cache.put(req, res.clone());
            trimCache(TILES, TILE_LIMIT);
          }
          return res;
        }).catch(() => hit);
        return hit || net;
      })
    );
    return;
  }

  if (url.origin !== self.location.origin) return;

  // ★アプリのコード（HTML/JS/CSS/manifest）はネットワーク優先★
  // ここをキャッシュ優先にしていたため、修正を公開しても端末に古い画面が出続けた。
  // オンラインなら常に最新を取り、取れなかったときだけキャッシュに落とす。
  const p = url.pathname;
  const isCode = p.endsWith('/') || p.endsWith('.html') ||
                 p.endsWith('.js') || p.endsWith('.css') || p.endsWith('.webmanifest');

  if (isCode) {
    e.respondWith(
      fetch(req).then((res) => {
        if (res && res.status === 200) {
          const copy = res.clone();
          caches.open(SHELL).then((c) => c.put(req, copy));
        }
        return res;
      }).catch(() => caches.match(req).then((hit) => hit || Response.error()))
    );
    return;
  }

  // 地図データ・画像・フォント等は中身が変わらないのでキャッシュ優先でよい
  e.respondWith(
      caches.match(req).then((hit) => hit || fetch(req).then((res) => {
        if (res && res.status === 200) {
          const copy = res.clone();
          caches.open(SHELL).then((c) => c.put(req, copy));
        }
        return res;
      }))
  );
});

// 待機中の新バージョンを、画面側の指示で即座に有効化する
self.addEventListener('message', (e) => {
  if (e.data === 'skip-waiting') self.skipWaiting();
});

async function trimCache(name, max) {
  const cache = await caches.open(name);
  const keys = await cache.keys();
  if (keys.length <= max) return;
  for (const k of keys.slice(0, keys.length - max)) await cache.delete(k);
}
