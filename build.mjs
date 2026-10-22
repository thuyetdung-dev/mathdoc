import fs from 'fs';
import { build } from 'esbuild';
const r = await build({ entryPoints: ['src/main.js'], bundle: true, format: 'esm', minify: true, write: false, target: ['chrome110', 'firefox115', 'safari16'], legalComments: 'none' });
let js = r.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
const html = fs.readFileSync('src/index.html', 'utf8').replace('/*APP*/', () => js);
fs.mkdirSync('dist', { recursive: true });
fs.writeFileSync('dist/index.html', html);
console.log('dist/index.html', (html.length / 1024 / 1024).toFixed(2), 'MB');
