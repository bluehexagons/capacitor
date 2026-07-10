import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const version = packageJson.version;
const remote = process.env.CAPACITOR_RELEASE_REMOTE || 'origin';
const tagName = `v${version}`;

const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    stdio: options.capture ? 'pipe' : 'inherit',
  });

  if (options.allowFailure) {
    return result;
  }

  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed with exit code ${result.status}`);
  }

  return result;
};

const requireCleanWorktree = () => {
  const status = run('git', ['status', '--porcelain=v1', '--untracked-files=all'], {
    capture: true,
  });
  if (status.stdout.trim() !== '') {
    throw new Error('Release tagging requires a completely clean git worktree');
  }
};

const localTagExists = (tag) =>
  run('git', ['rev-parse', '--verify', '--quiet', `refs/tags/${tag}`], { allowFailure: true })
    .status === 0;

const remoteTagExists = (tag) =>
  run('git', ['ls-remote', '--exit-code', '--tags', remote, `refs/tags/${tag}`], {
    allowFailure: true,
    capture: true,
  }).status === 0;

const requirePublishedMainHead = () => {
  const branch = run('git', ['branch', '--show-current'], { capture: true }).stdout.trim();
  if (branch !== 'main') {
    throw new Error(`Release tagging must run from main, got ${branch || 'detached HEAD'}`);
  }

  const localHead = run('git', ['rev-parse', 'HEAD'], { capture: true }).stdout.trim();
  const remoteHeadOutput = run('git', ['ls-remote', '--heads', remote, 'refs/heads/main'], {
    capture: true,
  }).stdout.trim();
  const remoteHead = remoteHeadOutput.split(/\s+/u)[0];
  if (remoteHead !== localHead) {
    throw new Error(`Push the release commit to ${remote}/main before tagging`);
  }
};

if (!/^\d+\.\d+\.\d+$/.test(version)) {
  throw new Error(`Package version must be semver x.y.z for release tagging, got ${version}`);
}

requireCleanWorktree();
requirePublishedMainHead();

if (localTagExists(tagName)) {
  throw new Error(`Release tag ${tagName} already exists locally`);
}

if (remoteTagExists(tagName)) {
  throw new Error(`Release tag ${tagName} already exists on ${remote}`);
}

run('npm', ['run', 'check']);
// Compilation is part of the check. Requiring a clean tree again proves the
// checked-in build output matches the source that the tag will contain.
requireCleanWorktree();
run('git', ['tag', '-a', tagName, '-m', `Capacitor ${tagName}`]);
run('git', ['push', remote, `refs/tags/${tagName}`]);
