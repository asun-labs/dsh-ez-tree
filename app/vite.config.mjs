import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { cpSync, mkdirSync } from 'node:fs'

const root = fileURLToPath(new URL('..', import.meta.url))
export default {
  root: resolve(root, 'app'),
  base: './',
  publicDir: resolve(root, 'vendor/ez-tree/src/app/public'),
  resolve: { alias: { '@dgreenheck/ez-tree': resolve(root, 'vendor/ez-tree/src/lib/index.js') } },
  assetsInclude: ['**/*.frag', '**/*.vert'],
  build: { outDir: resolve(root, 'lib/editor'), emptyOutDir: true },
  plugins: [{
    name: 'ez-tree-desktop-adaptations',
    transform(source, id) {
      if (id.endsWith('/vendor/ez-tree/src/app/scene.js')) {
        const original = 'return new Promise(resolve => requestAnimationFrame(resolve));'
        if (!source.includes(original)) throw new Error('上游场景加载结构已变化，请重新核对隐藏窗口初始化适配。')
        // 初次窗口保持隐藏时 rAF 可能暂停，定时器保证加载进度仍能继续。
        return source.replace(original, `return new Promise(resolve => {
          const timer = setTimeout(done, 32);
          const frame = requestAnimationFrame(done);
          function done() { clearTimeout(timer); cancelAnimationFrame(frame); resolve(); }
        });`).replace('const treeCount = 100;', "const treeCount = new URLSearchParams(location.search).has('automation') ? 0 : 100;")
      }
      if (id.endsWith('/vendor/ez-tree/src/app/rocks.js')) return source.replace('https://www.gstatic.com/draco/versioned/decoders/1.5.7/', './draco/')
      // 大模型超过 65535 顶点时，上游 Uint16 索引会溢出。
      if (id.endsWith('/vendor/ez-tree/src/lib/tree.js')) return source.replaceAll('new Uint16Array(', 'new Uint32Array(')
    },
    closeBundle() {
      mkdirSync(resolve(root, 'lib/editor/draco'), { recursive: true })
      for (const file of ['draco_decoder.js', 'draco_decoder.wasm', 'draco_wasm_wrapper.js']) cpSync(resolve(root, 'node_modules/three/examples/jsm/libs/draco/gltf', file), resolve(root, 'lib/editor/draco', file))
    },
  }],
}
