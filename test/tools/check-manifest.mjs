/**
 * manifest.json の妥当性チェック。`npm run check` から呼ばれる。
 *
 * 構文チェック (node --check) では拾えない、壊れると読み込み時に初めて分かる類を見る。
 * 特に version は manifest.json と package.json の 2 箇所に手書きされているので、
 * 片方だけ上げたまま release を切る事故をここで止める。
 */
import { readFile, access } from 'node:fs/promises';
import { join } from 'node:path';

const SRC = 'extension';
const problems = [];

const manifest = JSON.parse(await readFile(join(SRC, 'manifest.json'), 'utf8'));
const pkg = JSON.parse(await readFile('package.json', 'utf8'));

if (manifest.version !== pkg.version) {
  problems.push(
    `version 不一致: extension/manifest.json=${manifest.version} package.json=${pkg.version}`,
  );
}

if (!/^\d+(\.\d+){0,3}$/.test(manifest.version || '')) {
  // Chrome は 1〜4 個の数字しか受け付けない ('1.0.0-rc1' は読み込みで弾かれる)
  problems.push(`version は数字とドットだけで構成すること: ${manifest.version}`);
}

// ウェブストアは 128x128 を必須にしている
if (!manifest.icons?.['128']) {
  problems.push('icons に 128 が無い (ウェブストア掲載に必須)');
}

if (manifest.manifest_version !== 3) {
  problems.push(`manifest_version は 3 であること: ${manifest.manifest_version}`);
}

// manifest が名前で参照しているファイルが実在するか。リネーム時に効く。
// アイコンは生成物なので、作り忘れたまま package される事故がいちばん起きやすい。
// icons と action.default_icon は同じパスを指すので、重複は畳んでから見る
const referenced = [...new Set([
  manifest.background?.service_worker,
  manifest.options_page,
  ...Object.values(manifest.icons || {}),
  ...Object.values(manifest.action?.default_icon || {}),
].filter(Boolean))];
for (const name of referenced) {
  try {
    await access(join(SRC, name));
  } catch {
    problems.push(`manifest が参照する ${name} が ${SRC}/ に無い`);
  }
}

if (problems.length) {
  for (const problem of problems) console.error(`  ✗ ${problem}`);
  process.exit(1);
}

console.log(`  ✓ manifest.json ok (version ${manifest.version})`);
