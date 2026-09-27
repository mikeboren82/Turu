// TuRu - CONTINUOUS MONSTER: which code line is this pilot running? (pure + one git probe)
// The pilot must never silently run an older copy of MAIN's Cleaner / ingestion rules (code-line
// unification, 2026-09-24). Every cycle records the checkout it runs from (commit, branch, dirty files)
// in the heartbeat, and REFUSES to run jobs unless the checkout is the main branch at MAIN's current commit -
// a stale worktree or a feature branch stops loudly instead of repairing with another line's rules.
const { execFileSync } = require('child_process');

function git(root, args) {
  try { return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return null; }
}

// probe -> { head, branch, mainHead, dirty, available }
function probeCodeLine(root, mainRef = 'main') {
  const head = git(root, ['rev-parse', 'HEAD']);
  if (!head) return { available: false, head: null, branch: null, mainHead: null, dirty: null };
  const branch = git(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const mainHead = git(root, ['rev-parse', mainRef]);
  const status = git(root, ['status', '--porcelain', '--untracked-files=no']);
  const dirty = status == null ? null : status.split('\n').filter(Boolean).length;
  return { available: true, head, branch, mainHead, dirty };
}

// pure decision -> { ok, code, message }. A git checkout runs jobs ONLY when BOTH hold (2026-09-27): the checked-out
// branch is literally `main` AND HEAD is main's commit. A feature branch (or a detached HEAD) whose commit happens to
// equal main is still refused - the 2026-09-27 06:42 cycle ran relay + Cleaner from a UI branch sitting at main's
// commit with uncommitted edits, because only the commit was compared.
//   ok=false, code='not_main_branch'  : the checkout is not the `main` branch (whatever its commit) - jobs must not run
//   ok=false, code='stale_code_line'  : on `main` but HEAD is not main's commit - jobs must not run
//   ok=true,  code='main'             : branch main at main's commit (dirty count reported, never blocking)
//   ok=true,  code='unknown'          : not a git checkout (allowed, reported)
function codeLineStatus({ available, head, mainHead, branch, dirty }) {
  if (!available) return { ok: true, code: 'unknown', message: 'not a git checkout - code line unknown' };
  if (branch !== 'main') return { ok: false, code: 'not_main_branch', message: `checkout ${head.slice(0, 7)} is on ${branch === 'HEAD' ? 'a detached HEAD' : 'branch ' + branch}, not main${mainHead ? (head === mainHead ? ' (same commit as main)' : ' ' + mainHead.slice(0, 7)) : ''} - refusing to run jobs outside the main branch` };
  if (!mainHead || head !== mainHead) return { ok: false, code: 'stale_code_line', message: `checkout ${head.slice(0, 7)} (${branch}) is not main ${mainHead ? mainHead.slice(0, 7) : '(unresolved)'} - refusing to run jobs with a different rule generation` };
  return { ok: true, code: 'main', message: `main ${head.slice(0, 7)}${dirty ? ', ' + dirty + ' modified tracked file(s) in the working tree' : ''}` };
}

module.exports = { probeCodeLine, codeLineStatus };
