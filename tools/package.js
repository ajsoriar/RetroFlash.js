'use strict';
/* Assemble and pack the minimal npm distribution. Run with `npm run package`. */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { build } = require('./build');

const root = path.join(__dirname, '..');
const dist = path.join(root, 'dist');
const stage = path.join(dist, 'npm-package');

function npmPack() {
  const args = ['pack', stage, '--pack-destination', dist];
  const npmCli = process.env.npm_execpath;
  const result = npmCli
    ? spawnSync(process.execPath, [npmCli].concat(args), { cwd: root, stdio: 'inherit' })
    : spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, {
      cwd: root,
      stdio: 'inherit',
      shell: process.platform === 'win32'
    });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error('npm pack failed with exit code ' + result.status);
}

async function packageNpm() {
  const { bundleName, code } = await build();
  const pkg = require(path.join(root, 'package.json'));
  if (pkg.browser !== './dist/' + bundleName) {
    throw new Error('package: package.browser must point to the current versioned bundle');
  }

  fs.rmSync(stage, { recursive: true, force: true });
  fs.mkdirSync(path.join(stage, 'dist'), { recursive: true });
  // Package the bundle just built from src/, not whatever dist/ holds; the source map is not shipped.
  const bundle = code
    .replace(/(?:\r?\n)?\/\/[#@]\s*sourceMappingURL=.*(?:\r?\n)?$/, '\n');
  fs.writeFileSync(path.join(stage, 'dist', bundleName), bundle);
  fs.copyFileSync(path.join(root, 'LICENSE'), path.join(stage, 'LICENSE'));
  fs.writeFileSync(
    path.join(stage, 'README.md'),
    fs.readFileSync(path.join(root, 'packaging', 'README.md'), 'utf8').replace(/\{\{version\}\}/g, pkg.version)
  );

  const packageJson = {
    name: pkg.name,
    version: pkg.version,
    description: pkg.description,
    license: pkg.license,
    repository: pkg.repository,
    homepage: pkg.homepage,
    bugs: pkg.bugs,
    browser: pkg.browser,
    publishConfig: pkg.publishConfig,
    files: ['dist/'],
    keywords: pkg.keywords
  };
  fs.writeFileSync(path.join(stage, 'package.json'), JSON.stringify(packageJson, null, 2) + '\n');

  console.log('Staged minimal npm package at dist/npm-package/');
  npmPack();
}

if (require.main === module) {
  packageNpm().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}

module.exports = { packageNpm };
