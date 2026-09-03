#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""めぐログ「集めるリスト」生成ツール

data/collections/<id>.json を Wikidata / ウィキペディア日本語版から作る。
同梱済みのリストも同じ形で作られている（各ファイルの "source" を参照）。

★このスクリプトは外向き通信が要る★
    https://query.wikidata.org  … SPARQL。クラスで数え上げるリスト（道の駅・SA/PA）
    https://ja.wikipedia.org    … API。札所一覧の表と、各ページの座標

Claude Code のクラウドセッションは既定でこの2ホストに出られない（403）。
手元の端末で動かすか、クラウド環境のネットワーク許可にこの2つを足すこと。

使い方:
    python3 tools/build_collections.py --list            # 作れるリストを見る
    python3 tools/build_collections.py kamakura33 --dry-run   # 中身だけ確認
    python3 tools/build_collections.py michinoeki sapa   # 書き出す
    python3 tools/build_collections.py --all

★書き出したあとの当て先（忘れると端末に届かない）★
    1. js/app.js の BUILTIN_COLLECTIONS に1行足す
    2. sw.js の COLLECTION_FILES に id を足す
    3. sw.js の VERSION を上げる
  順番を守ること。2を先に足して1のファイルが無いと、install の addAll が
  落ちて Service Worker のインストールごと失敗する＝オフライン起動が丸ごと死ぬ。
  実行の最後に、貼るべき行をそのまま画面に出す。
"""

import argparse
import json
import os
import re
import sys
import time
import urllib.parse
import urllib.request
from html.parser import HTMLParser

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_DIR = os.path.join(ROOT, "data", "collections")
PREF_GEOJSON = os.path.join(ROOT, "data", "prefectures.geojson")

UA = "meguri-log-collection-builder/1.0 (https://github.com/hakoniwa-lab/meguri-log)"
WIKIDATA = "https://query.wikidata.org/sparql"
JAWIKI = "https://ja.wikipedia.org/w/api.php"
SOURCE = "Wikidata / ウィキペディア日本語版"

# 日本のだいたいの範囲。ここを外れた座標は取り違えとみなして落とす。
JP_BBOX = (20.0, 46.5, 122.0, 154.5)  # lat_min, lat_max, lng_min, lng_max


# ---------------------------------------------------------------
# 作るリストの定義
# ---------------------------------------------------------------
# kind:
#   wikidata  … Wikidata のクラス（日本語ラベル）で数え上げる。件数が動くもの向け。
#   wikitable … ウィキペディアの一覧記事の表から札所番号と寺名を取り、各ページの座標を引く。
#   pages     … ページ名を直に指定する。3か所くらいの小さいリスト向け。
SPECS = [
    {
        "id": "kamakura33", "name": "鎌倉三十三観音", "mark": "📿", "tag": "temple",
        "group": "巡礼・霊場", "area": "神奈川（鎌倉）",
        "note": "鎌倉市内の観音霊場。1〜33番。",
        "kind": "wikitable",
        "pages": ["鎌倉三十三観音霊場", "鎌倉三十三箇所", "鎌倉三十三観音"],
    },
    {
        "id": "kamakura24", "name": "鎌倉二十四地蔵", "mark": "📿", "tag": "temple",
        "group": "巡礼・霊場", "area": "神奈川（鎌倉）",
        "note": "鎌倉市内の地蔵霊場。1〜24番。",
        "kind": "wikitable",
        "pages": ["鎌倉二十四地蔵尊", "鎌倉二十四地蔵"],
    },
    {
        "id": "edo33", "name": "江戸三十三観音", "mark": "📿", "tag": "temple",
        "group": "巡礼・霊場", "area": "東京",
        "note": "昭和新撰江戸三十三観音霊場。1〜33番。",
        "kind": "wikitable",
        "pages": ["昭和新撰江戸三十三観音霊場", "江戸三十三箇所", "江戸三十三観音"],
    },
    {
        "id": "michinoeki", "name": "道の駅", "mark": "🛣️", "tag": "michi",
        "group": "道の駅・SA/PA", "area": "全国",
        "note": "国土交通省に登録された道の駅。数が多いので番号は付けていない。",
        "kind": "wikidata",
        "classes": ["道の駅"],
        "numbered": False,
    },
    {
        "id": "sapa", "name": "サービスエリア・パーキングエリア", "mark": "🅿️", "tag": "sapa",
        "group": "道の駅・SA/PA", "area": "全国",
        "note": "高速道路のSA・PA。数が多いので番号は付けていない。",
        "kind": "wikidata",
        "classes": ["サービスエリア", "パーキングエリア"],
        "numbered": False,
    },
    {
        "id": "sanmeibaku", "name": "日本三名瀑", "mark": "💧", "tag": "fall",
        "group": "三大・名所", "area": "全国",
        "note": "華厳滝（栃木）・那智滝（和歌山）・袋田の滝（茨城）。",
        "kind": "pages",
        "titles": ["華厳滝", "那智滝", "袋田の滝"],
    },
    {
        "id": "sanmeisen", "name": "日本三名泉", "mark": "♨️", "tag": "",
        "group": "三大・名所", "area": "全国",
        "note": "有馬温泉（兵庫）・草津温泉（群馬）・下呂温泉（岐阜）。",
        "kind": "pages",
        "titles": ["有馬温泉", "草津温泉", "下呂温泉"],
    },
    {
        "id": "yakei3", "name": "日本三大夜景", "mark": "🌃", "tag": "tower",
        "group": "三大・名所", "area": "全国",
        "note": "函館山（北海道）・摩耶山（兵庫）・稲佐山（長崎）。",
        "kind": "pages",
        "titles": ["函館山", "摩耶山", "稲佐山"],
    },
    {
        "id": "sandaiinari", "name": "日本三大稲荷", "mark": "⛩️", "tag": "shrine",
        "group": "三大・名所", "area": "全国",
        # ★三大稲荷は決まっていない★ 伏見以外は諸説あり、笠間稲荷・竹駒神社・
        # 最上稲荷なども名乗る。ここでは通りのよい3社を入れているので、
        # 気に入らなければ titles を書き換えて作り直すこと。
        "note": "伏見稲荷大社（京都）・豊川稲荷（愛知）・祐徳稲荷神社（佐賀）。三社目以降は諸説ある。",
        "kind": "pages",
        "titles": ["伏見稲荷大社", "豊川稲荷", "祐徳稲荷神社"],
    },
]

SPEC_BY_ID = {s["id"]: s for s in SPECS}


# ---------------------------------------------------------------
# 通信
# ---------------------------------------------------------------
def http_get(url, params, accept="application/json"):
    """GET して JSON で返す。落ちたら少し待って3回まで試す。"""
    qs = urllib.parse.urlencode(params)
    full = url + "?" + qs
    last = None
    for attempt in range(3):
        try:
            req = urllib.request.Request(full, headers={"User-Agent": UA, "Accept": accept})
            with urllib.request.urlopen(req, timeout=120) as res:
                return json.loads(res.read().decode("utf-8"))
        except Exception as e:  # 相手が混んでいるだけのことが多い
            last = e
            time.sleep(2 * (attempt + 1))
    raise SystemExit(
        "取得できませんでした: %s\n  %r\n"
        "  ネットワークが許可されていない可能性があります（このスクリプトの冒頭を参照）。"
        % (url, last)
    )


# ---------------------------------------------------------------
# Wikidata: クラスで数え上げる
# ---------------------------------------------------------------
def from_wikidata(spec):
    """クラスの日本語ラベルで引く。★QIDを直書きしない★
    QIDは覚え違えても静かに0件になるだけで気付けない。ラベルなら、
    解決できたクラス名を下に出すので取り違えに気付ける。"""
    values = " ".join('"%s"@ja' % c for c in spec["classes"])
    query = """
SELECT DISTINCT ?name ?lat ?lng ?clsLabel WHERE {
  VALUES ?clsName { %s }
  ?cls rdfs:label ?clsName .
  ?x wdt:P31/wdt:P279* ?cls ;
     wdt:P17 wd:Q17 ;
     p:P625 ?st .
  ?st psv:P625 ?node .
  ?node wikibase:geoLatitude ?lat ; wikibase:geoLongitude ?lng .
  ?x rdfs:label ?name FILTER(lang(?name) = "ja")
  SERVICE wikibase:label { bd:serviceParam wikibase:language "ja". }
}
""" % values
    data = http_get(WIKIDATA, {"query": query, "format": "json"},
                    accept="application/sparql-results+json")
    rows = data.get("results", {}).get("bindings", [])
    seen_cls = sorted({r["clsLabel"]["value"] for r in rows if "clsLabel" in r})
    print("  Wikidata が返したクラス: %s" % ("、".join(seen_cls) or "（なし）"))
    items = []
    for r in rows:
        items.append({
            "name": r["name"]["value"],
            "lat": float(r["lat"]["value"]),
            "lng": float(r["lng"]["value"]),
        })
    return items


# ---------------------------------------------------------------
# ウィキペディア: ページの座標
# ---------------------------------------------------------------
def wikipedia_coords(titles):
    """ページ名から座標を引く。リダイレクトは追う。50件ずつ。
    返すのは {元のページ名: (lat, lng)}。座標が無いページは入らない。"""
    out = {}
    for i in range(0, len(titles), 50):
        chunk = titles[i:i + 50]
        data = http_get(JAWIKI, {
            "action": "query", "prop": "coordinates", "coprop": "type|name",
            "titles": "|".join(chunk), "redirects": "1",
            "format": "json", "formatversion": "2",
        })
        q = data.get("query", {})
        # リダイレクトされた場合、元の名前に戻せるようにしておく
        back = {r["to"]: r["from"] for r in q.get("redirects", [])}
        back.update({n["to"]: n["from"] for n in q.get("normalized", [])})
        for page in q.get("pages", []):
            coords = page.get("coordinates")
            if not coords:
                continue
            title = page.get("title")
            orig = back.get(title, title)
            # リダイレクトを2段たどった場合に元をたぐる
            while orig in back:
                orig = back[orig]
            out[orig] = (float(coords[0]["lat"]), float(coords[0]["lon"]))
        time.sleep(0.2)  # 相手に優しく
    return out


def from_pages(spec):
    titles = spec["titles"]
    coords = wikipedia_coords(titles)
    items = []
    for n, t in enumerate(titles, 1):
        if t not in coords:
            print("  ★座標が取れませんでした: %s（ページ名が違うかもしれません）" % t)
            continue
        lat, lng = coords[t]
        items.append({"name": t, "no": n, "lat": lat, "lng": lng})
    return items


# ---------------------------------------------------------------
# ウィキペディア: 一覧記事の表から札所を拾う
# ---------------------------------------------------------------
class _TableGrab(HTMLParser):
    """最初の wikitable から (セルの文字列, 最初のリンク先) を行ごとに集める。"""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.tables = []
        self._depth = 0
        self._rows = None
        self._row = None
        self._cell = None
        self._link = None

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag == "table":
            self._depth += 1
            if self._depth == 1 and "wikitable" in (a.get("class") or ""):
                self._rows = []
        elif self._rows is not None:
            if tag == "tr":
                self._row = []
            elif tag in ("td", "th"):
                self._cell = []
                self._link = None
            elif tag == "a" and self._cell is not None and self._link is None:
                href = a.get("href") or ""
                if href.startswith("/wiki/") and ":" not in href[6:]:
                    self._link = urllib.parse.unquote(href[6:]).replace("_", " ")

    def handle_endtag(self, tag):
        if tag == "table":
            if self._depth == 1 and self._rows is not None:
                self.tables.append(self._rows)
                self._rows = None
            self._depth = max(0, self._depth - 1)
        elif self._rows is not None:
            if tag == "tr" and self._row is not None:
                if self._row:
                    self._rows.append(self._row)
                self._row = None
            elif tag in ("td", "th") and self._cell is not None:
                text = re.sub(r"\s+", " ", "".join(self._cell)).strip()
                if self._row is not None:
                    self._row.append((text, self._link))
                self._cell = None
                self._link = None

    def handle_data(self, data):
        if self._cell is not None:
            self._cell.append(data)


def from_wikitable(spec):
    """一覧記事の表から「番号」と「寺の記事名」を取り、座標を引く。
    ★表の作りは記事ごとに違う★ 数字だけのセルを番号、最初の記事リンクを寺として
    拾う当てずっぽうなので、--dry-run で必ず目視すること。"""
    html = None
    used = None
    for title in spec["pages"]:
        data = http_get(JAWIKI, {
            "action": "parse", "page": title, "prop": "text",
            "format": "json", "formatversion": "2", "redirects": "1",
        })
        if "parse" in data:
            html = data["parse"]["text"]
            used = data["parse"]["title"]
            break
        print("  記事が見つかりません: %s" % title)
    if html is None:
        print("  ★どのページ名でも記事に届きませんでした。SPECS の pages を直してください。")
        return []
    print("  使った記事: %s" % used)

    grab = _TableGrab()
    grab.feed(html)
    rows = []
    for table in grab.tables:
        picked = []
        for row in table:
            no = None
            link = None
            for text, href in row:
                if no is None and re.fullmatch(r"\d{1,3}", text):
                    no = int(text)
                if link is None and href:
                    link = href
            if no is not None and link:
                picked.append((no, link))
        if len(picked) > len(rows):
            rows = picked
    if not rows:
        print("  ★表から札所を拾えませんでした。記事の作りが想定と違います。")
        return []

    rows.sort(key=lambda r: r[0])
    coords = wikipedia_coords([r[1] for r in rows])
    items = []
    for no, title in rows:
        if title not in coords:
            print("  ★座標なし: %d番 %s" % (no, title))
            continue
        lat, lng = coords[title]
        items.append({"name": title, "no": no, "lat": lat, "lng": lng})
    return items


# ---------------------------------------------------------------
# 検算
# ---------------------------------------------------------------
def load_prefs():
    """同梱の県境データ。座標がどの県に落ちるかを数えて、取り違えに気付くため。"""
    try:
        with open(PREF_GEOJSON, encoding="utf-8") as f:
            gj = json.load(f)
    except Exception:
        return None
    out = []
    for feat in gj.get("features", []):
        props = feat.get("properties", {})
        name = props.get("nam_ja") or props.get("name") or props.get("nam") or "?"
        geom = feat.get("geometry") or {}
        rings = []
        if geom.get("type") == "Polygon":
            rings = [geom["coordinates"][0]]
        elif geom.get("type") == "MultiPolygon":
            rings = [p[0] for p in geom["coordinates"]]
        out.append((name, rings))
    return out


def pref_of(prefs, lat, lng):
    for name, rings in prefs:
        for ring in rings:
            inside = False
            j = len(ring) - 1
            for i in range(len(ring)):
                xi, yi = ring[i][0], ring[i][1]
                xj, yj = ring[j][0], ring[j][1]
                if (yi > lat) != (yj > lat):
                    if lng < (xj - xi) * (lat - yi) / (yj - yi) + xi:
                        inside = not inside
                j = i
            if inside:
                return name
    return None


def clean(items, numbered=True):
    """日本の外・重複・座標欠けを落とす。落としたものは黙って消さずに数を出す。"""
    lat0, lat1, lng0, lng1 = JP_BBOX
    out = []
    seen = set()
    dropped_out, dropped_dup = 0, 0
    for it in items:
        lat, lng = it["lat"], it["lng"]
        if not (lat0 <= lat <= lat1 and lng0 <= lng <= lng1):
            dropped_out += 1
            continue
        key = it["name"]
        if key in seen:
            dropped_dup += 1
            continue
        seen.add(key)
        out.append(it)
    if dropped_out:
        print("  日本の外に出た座標を落としました: %d件" % dropped_out)
    if dropped_dup:
        print("  同じ名前が重なっていたので落としました: %d件" % dropped_dup)
    if numbered:
        out.sort(key=lambda x: x.get("no", 0))
    else:
        out.sort(key=lambda x: x["name"])
        for it in out:
            it.pop("no", None)
    return out


# ---------------------------------------------------------------
# 書き出し
# ---------------------------------------------------------------
def build(spec, dry_run, prefs):
    print("\n=== %s（%s）===" % (spec["name"], spec["id"]))
    kind = spec["kind"]
    if kind == "wikidata":
        items = from_wikidata(spec)
    elif kind == "pages":
        items = from_pages(spec)
    elif kind == "wikitable":
        items = from_wikitable(spec)
    else:
        raise SystemExit("知らない kind: %s" % kind)

    items = clean(items, numbered=spec.get("numbered", True))
    if not items:
        print("  0件でした。書き出しません。")
        return None
    for it in items:
        it["lat"] = round(it["lat"], 6)
        it["lng"] = round(it["lng"], 6)

    print("  %d件" % len(items))
    if prefs:
        counts = {}
        unknown = 0
        for it in items:
            p = pref_of(prefs, it["lat"], it["lng"])
            if p is None:
                unknown += 1
            else:
                counts[p] = counts.get(p, 0) + 1
        top = sorted(counts.items(), key=lambda kv: -kv[1])[:8]
        print("  県別: %s%s" % (
            "、".join("%s %d" % (k, v) for k, v in top),
            ("／県に入らなかった座標 %d件" % unknown) if unknown else "",
        ))

    # 中身の目視用。表から拾ったものは特に、ここを見ないと事故る。
    head = items[:5]
    for it in head:
        print("    %s%s (%.6f, %.6f)" % (
            ("%2d " % it["no"]) if "no" in it else "   ", it["name"], it["lat"], it["lng"]))
    if len(items) > len(head):
        print("    …ほか %d件" % (len(items) - len(head)))

    doc = {
        "id": spec["id"], "name": spec["name"], "mark": spec["mark"],
        "tag": spec.get("tag", ""), "group": spec["group"], "area": spec["area"],
        "note": spec["note"], "expect": len(items), "source": SOURCE,
        "items": items,
    }
    path = os.path.join(OUT_DIR, spec["id"] + ".json")
    if dry_run:
        print("  --dry-run なので書きません（%s）" % os.path.relpath(path, ROOT))
        return None
    with open(path, "w", encoding="utf-8") as f:
        json.dump(doc, f, ensure_ascii=False, separators=(",", ":"))
    size = os.path.getsize(path)
    print("  書きました: %s（%.1f KB）" % (os.path.relpath(path, ROOT), size / 1024))
    return spec["id"]


def print_wiring(ids):
    if not ids:
        return
    print("\n" + "=" * 60)
    print("この3つを当てないと端末に届きません。★この順番で★")
    print("=" * 60)
    print("\n1) js/app.js の BUILTIN_COLLECTIONS に足す:")
    for i in ids:
        print("    { id: '%s',%s file: './data/collections/%s.json' }," % (i, " " * max(1, 12 - len(i)), i))
    print("\n2) sw.js の COLLECTION_FILES に足す:")
    print("    " + ", ".join("'%s'" % i for i in ids) + ",")
    print("\n3) sw.js の VERSION を上げる（例 v53 -> v54）")
    print("   ついでに js/app.js の APP_VERSION も同じ値に合わせる。")


def main():
    ap = argparse.ArgumentParser(description="めぐログの集めるリストを作る")
    ap.add_argument("ids", nargs="*", help="作るリストのid（省略時は --list を見る）")
    ap.add_argument("--all", action="store_true", help="定義してある全部を作る")
    ap.add_argument("--list", action="store_true", help="作れるリストを並べる")
    ap.add_argument("--dry-run", action="store_true", help="中身を出すだけで書かない")
    args = ap.parse_args()

    if args.list or (not args.ids and not args.all):
        print("作れるリスト:")
        for s in SPECS:
            print("  %-13s %-22s %s" % (s["id"], s["name"], s["kind"]))
        print("\n例: python3 tools/build_collections.py kamakura33 --dry-run")
        return

    ids = [s["id"] for s in SPECS] if args.all else args.ids
    unknown = [i for i in ids if i not in SPEC_BY_ID]
    if unknown:
        raise SystemExit("知らないid: %s（--list で確認）" % "、".join(unknown))

    os.makedirs(OUT_DIR, exist_ok=True)
    prefs = load_prefs()
    if prefs is None:
        print("※ data/prefectures.geojson が読めないので県別の検算は飛ばします")

    done = []
    for i in ids:
        r = build(SPEC_BY_ID[i], args.dry_run, prefs)
        if r:
            done.append(r)
    print_wiring(done)


if __name__ == "__main__":
    main()
