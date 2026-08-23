# めぐりログ

行った場所を地図に残していく記録アプリ。HAKONIWA LAB の11本目。
御朱印・城・駅・市区町村などを**1つのアプリにまとめる**ことを目的にしている。

公開URL（予定）: https://hakoniwa-lab.github.io/meguri-log/

## 現在の実装（Phase 1）

- 47都道府県の制覇記録（地図の塗りつぶし・進捗率）
- 現在地から「今いる都道府県」を自動判定
- 訪問記録（日付・メモ・写真・座標）
- 同じ場所への再訪も記録できる
- JSON書き出し／読み込み（写真も同梱）
- PWA（ホーム画面に追加・オフライン起動）

## 構成

```
app/
├── index.html
├── css/style.css
├── js/
│   ├── storage.js   ← 保存層。ここだけ差し替えればクラウド同期に移行できる
│   └── app.js       ← 画面・地図・位置判定
├── data/prefectures.geojson   ← 47都道府県の境界（簡略化済み 348KB）
├── vendor/          ← Leaflet 1.9.4（CDNを使わずローカルに置く＝オフライン対応のため）
├── icons/
├── manifest.webmanifest
└── sw.js
```

## 設計上の約束ごと

1. **データの読み書きは `Store`（storage.js）経由のみ。** 画面側から IndexedDB を直接触らない。
   クラウド同期に移行するとき、storage.js の中身だけ差し替えれば画面は無修正で済む。
2. **localStorage は使わない。** 上限約5MBで、写真を数枚入れただけで破綻するため。
3. **地点は二階建て。** マスタ（GeoJSON等に同梱）とユーザー追加（IndexedDBの `spots`）を
   同じ `spot` として扱う。網羅リストが存在しない対象（御朱印・廃駅など）もこれで扱える。
4. **写真は長辺1600pxに縮小して保存。** 原寸だと1枚5MB前後になり容量を食い潰す。

## 地図データについて

`data/prefectures.geojson` は [dataofjapan/land](https://github.com/dataofjapan/land) の
`japan.geojson`（13MB）を、同梱の手順で **348KB** まで軽量化したもの。

- Ramer-Douglas-Peucker で頂点を間引き（tolerance 0.004度 ≒ 400m）
- 座標を小数4桁に丸め（≒11m精度）
- 3km四方未満の離島リングを除去（各県で最大のリングは必ず保持）

頂点数 80,370 → 18,113（22.5%）。この精度でも、現在地からの都道府県判定は
主要8地点＋国外1地点のテストで全て正しく判定できることを確認済み。

## ローカルで動かす

```bash
python -m http.server 8731 --directory projects/meguri-log/app
```

位置情報はブラウザの仕様上 **HTTPS または localhost でのみ**取得できる。
GitHub Pages は標準でHTTPSなので、公開後はそのまま動く。

## これから

| Phase | 内容 |
|---|---|
| 2 | 日本100名城・続日本100名城（200城）＋ユーザー追加 |
| 3 | 鉄道駅（現存＋廃駅はユーザー追加） |
| 4 | 御朱印の記録（写真主体） |
| 5 | 複数端末での同期 |
| — | 市区町村（約1,700）の制覇。境界データの軽量化が主作業 |
