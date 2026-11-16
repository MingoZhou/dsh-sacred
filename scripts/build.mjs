/**
 * Build artifacts:
 *   lib/index.js      host half (ESM; @deepseek-ai/* and node:* stay external)
 *   lib/client.js     browser half — a classic script that registers a lazy
 *                     CJS factory with window.__ModuleLoader__ (the dsh web
 *                     loader contract); react resolves from the host page.
 *   demo/dist/demo.js self-contained demo (react inlined) for GitHub Pages
 */
import { build } from 'esbuild'
import { mkdir, stat, writeFile } from 'node:fs/promises'

const css = { loader: { '.css': 'text', '.webp': 'dataurl' } }
await mkdir('lib', { recursive: true })
await mkdir('demo/dist', { recursive: true })

await build({
  entryPoints: ['src/index.ts'],
  outfile: 'lib/index.js',
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  external: ['@deepseek-ai/*', 'node:*'],
})

const client = await build({
  entryPoints: ['src/client/index.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  jsx: 'automatic',
  ...css,
  external: ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/*'],
  minify: true,
  write: false,
})
await writeFile('lib/client.js', `/* dsh-sacred client bundle — registers a lazy CJS factory with the dsh web loader. */
;(function () {
  var factory = function (require) {
    var module = { exports: {} };
    (function (require, module, exports) {
${client.outputFiles[0].text}
    })(require, module, module.exports);
    return module.exports;
  };
  if (typeof window !== 'undefined' && window.__ModuleLoader__) {
    window.__ModuleLoader__.load({ id: '@mingozhou/dsh-sacred', factory: factory });
  } else if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory(typeof require === 'function' ? require : function (id) {
      throw new Error('unresolvable external: ' + id);
    });
  }
})();
`)

await build({
  entryPoints: ['demo/main.tsx'],
  outfile: 'demo/dist/demo.js',
  bundle: true,
  format: 'iife',
  platform: 'browser',
  jsx: 'automatic',
  ...css,
  define: { 'process.env.NODE_ENV': '"production"' },
  minify: true,
})

const sizes = await Promise.all(['lib/index.js', 'lib/client.js', 'demo/dist/demo.js']
  .map(async (f) => `${f} ${((await stat(f)).size / 1024).toFixed(0)} KB`))
console.log(`build ok: ${sizes.join(' · ')}`)
