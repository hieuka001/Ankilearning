#!/usr/bin/env node
/**
 * Cursor stop hook: tự commit và push lên GitHub khi agent sửa xong.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

try {
  readFileSync(0, 'utf8');
} catch {
  // Hook protocol expects stdin to be consumed.
}

const ROOT = process.cwd();
const BLOCKED_PATTERNS = [/^\.env/i, /\.env\./i];

function git(args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
}

function hasUpstream() {
  try {
    git(['rev-parse', '--abbrev-ref', '@{u}']);
    return true;
  } catch {
    return false;
  }
}

try {
  const status = git(['status', '--porcelain']);
  if (!status) process.exit(0);

  const blocked = status
    .split('\n')
    .some((line) => BLOCKED_PATTERNS.some((pattern) => pattern.test(line.slice(3).trim())));
  if (blocked) {
    console.error('[auto-push] Bỏ qua: phát hiện file nhạy cảm (.env)');
    process.exit(0);
  }

  git(['add', '-A']);

  const staged = git(['diff', '--cached', '--name-only']);
  if (!staged) process.exit(0);

  const files = staged.split('\n');
  const summary = files
    .slice(0, 8)
    .map((file) => file.split('/').pop())
    .join(', ');
  const message = `Auto-sync: ${summary}${files.length > 8 ? ', ...' : ''}`;

  git(['commit', '-m', message]);

  if (hasUpstream()) {
    git(['push']);
  } else {
    const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
    git(['push', '-u', 'origin', branch]);
  }
} catch (error) {
  const stderr = error && typeof error === 'object' && 'stderr' in error ? String(error.stderr || '') : '';
  console.error('[auto-push]', stderr || (error instanceof Error ? error.message : String(error)));
  process.exit(0);
}
