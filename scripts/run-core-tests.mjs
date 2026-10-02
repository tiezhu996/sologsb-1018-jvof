// 用 esbuild 把 TS 测试与依赖打到系统临时目录的 ESM 文件，再用 node --test 运行。
// 浏览器 API 中仅用到 structuredClone / Blob / crypto.subtle，Node 20 均已内置；
// IndexedDB 相关部分在 e2e 测试里用内存 Map 替换。
import { build } from 'esbuild'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

const tests = ['src/server-core.test.ts', 'src/sync.e2e.test.ts']
const outfiles = tests.map((name) => join(tmpdir(), `sologsb-test-${name.replace(/[/.]/g, '-')}.mjs`))

for (let i = 0; i < tests.length; i += 1) {
  await build({
    entryPoints: [tests[i]],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    outfile: outfiles[i],
    logLevel: 'silent'
  })
}

const result = spawnSync(process.execPath, ['--test', ...outfiles], { stdio: 'inherit' })
for (const file of outfiles) rmSync(file, { force: true })
process.exit(result.status ?? 1)
