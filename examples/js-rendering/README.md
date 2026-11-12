# JS 描画サンプル

COLR v1 に対応していないブラウザ (Safari など) でも Nottsu Sans JP を色付きで表示するための描画例です。リリース ZIP に同梱されています。

## 使い方

ZIP を解凍し、このフォルダー (`examples/js-rendering/`) を含むツリー全体を HTTP サーバーで配信して、`index.html` をブラウザで開いてください。WASM とフォントの読み込みに fetch を使うため、`file://` では動作しません。

```sh
# ZIP を解凍したフォルダーで
npx serve .
# または
python3 -m http.server
```

フォントは2つ上の階層にある `NottsuSansJP-VariableFont_wght.ttf` を相対パスで読みます。配置を変える場合は `index.html` のパスを調整してください。HarfBuzz の WASM 版 (harfbuzzjs) は CDN から読み込んでいます。自前で配信する場合は `render.js` の import 先を変えてください。

## 仕組み

`render.js` の `createColorRenderer(harfbuzz, fontUrl)` が、HarfBuzz でフォントの COLR ペイント情報を読み取り、グリフごとにインライン SVG を生成します。各グリフは、字形のアウトラインでクリップした扇形を、スイープグラデーションの色区間ごとに塗ったものです。COLR v1 の描画結果と一致し、太さ (wght) の変更にも追随します。
