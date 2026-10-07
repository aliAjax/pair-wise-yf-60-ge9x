/**
 * 测试运行器：把 reconcile.ts 转译为同目录下的 .generated.mjs，
 * 再执行 node:test 用例，结束后清理。
 */
import { transpileModule } from 'typescript';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const libDir = join(here, '..', 'src', 'lib');
const sourcePath = join(libDir, 'reconcile.ts');
const generatedPath = join(libDir, 'reconcile.generated.mjs');

const source = readFileSync(sourcePath, 'utf8');
const { outputText } = transpileModule(source, {
  compilerOptions: { module: 'esnext', target: 'es2022', isolatedModules: true }
});
writeFileSync(generatedPath, outputText);

const result = spawnSync(process.execPath, ['--test', join(libDir, 'reconcile.test.mjs')], {
  stdio: 'inherit'
});
rmSync(generatedPath, { force: true });
process.exit(result.status ?? 1);
