# public/wc.js

Browser bundle of `@walletconnect/sign-client` (v2) + `qrcode`, used by the game for
"Joey (mobile)". Loaded on demand with `import("/wc.js")`.

Rebuild:

```bash
cd tools/wc && npm init -y && npm i @walletconnect/sign-client@2 qrcode esbuild
npx esbuild entry.js --bundle --format=esm --platform=browser --minify --target=es2020 \
  --define:process.env.NODE_ENV='"production"' --define:global=globalThis --outfile=../../public/wc.js
```
