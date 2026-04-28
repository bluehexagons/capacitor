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

const requireCleanTrackedWorktree = () => {
  if (run('git', ['diff', '--quiet'], { allowFailure: true }).status !== 0) {
    throw new Error('Release tagging requires a clean tracked git worktree');
  }

  if (run('git', ['diff', '--cached', '--quiet'], { allowFailure: true }).status !== 0) {
    throw new Error('Release tagging requires no staged changes');
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

if (!/^\d+\.\d+\.\d+$/.test(version)) {
  throw new Error(`Package version must be semver x.y.z for release tagging, got ${version}`);
}

requireCleanTrackedWorktree();

if (localTagExists(tagName)) {
  throw new Error(`Release tag ${tagName} already exists locally`);
}

if (remoteTagExists(tagName)) {
  throw new Error(`Release tag ${tagName} already exists on ${remote}`);
}

run('npm', ['test']);
run('git', ['tag', '-a', tagName, '-m', `Capacitor ${tagName}`]);
run('git', ['push', remote, `refs/tags/${tagName}`]);
