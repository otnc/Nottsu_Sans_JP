# Nottsu Sans JP

Noto Sans JP をもとに、文字の中心から4色で塗ったフォントです。

![Nottsu Sans JP](./0-color-title.png)

![Aa1あア漢](./0-color-characters.png)

![28px の例文](./0-color-28.png)

![22px の例文](./0-color-22.png)

![18px の例文](./0-color-18.png)

例文と文字サイズは [Google Fonts の Noto Sans JP 見本](https://fonts.google.com/noto/specimen/Noto+Sans+JP) に合わせています。見本のテキストは [`data/samples/`](./data/samples/) にあります。

## 配色

![字形を塗る４色の配色見本](./0-color.png)

配色の出典は @Nottsu_fun26 (https://twitter.com/Nottsu_fun26) です。

## 使い方

GitHub Releases の ZIP を解凍し、太さを 100〜900 の範囲で調整できる可変 TTF か、`static/` にある９種類の固定 TTF から使いたいファイルをインストールしてください。色付きで表示するには、OpenType の COLR v1 に対応したアプリが必要です。可変 TTF には SVG テーブルも入っているので、Safari でも色付きで表示できます。COLR v1 非対応ブラウザ向けの JavaScript 描画サンプルがリリース ZIP の `examples/js-rendering/` に同梱されていて、Web サイトのタイプテスターも同じ方法で描画しています。

## ビルド

```sh
npm ci
npm run build
npm test
```

フォントは `dist/` に、配色見本と文字見本はリポジトリのルートに生成されます。

## ライセンス

SIL Open Font License 1.1 で配布します。[LICENSE](./LICENSE) を参照してください。
