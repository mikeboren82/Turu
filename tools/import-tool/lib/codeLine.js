// TuRu - CONTINUOUS MONSTER: which code line is this pilot running? (pure + one git probe)
// The pilot must never silently run an older copy of MAIN's Cleaner / ingestion rules (code-line
// unification, 2026-09-24). Every cycle records the checkout it runs from (commit, branch, dirty files)
// in the heartbeat, and REFUSES to run jobs when the checkout is not at MAIN's current commit - a
// stale worktree stops loudly instead of repairing with yesterday's rules.
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

// pure decision -> { ok, code, message }
//   ok=false, code='stale_code_line'  : HEAD is not MAIN's commit (an older/other line) - jobs must not run
//   ok=true,  code='main'             : running MAIN's current commit (dirty count reported, never blocking)
//   ok=true,  code='unknown'          : not a git checkout (allowed, reported)
function codeLineStatus({ available, head, mainHead, branch, dirty }, { allowDetached = true } = {}) {
  if (!available) return { ok: true, code: 'unknown', message: 'not a git checkout - code line unknown' };
  if (!mainHead) return { ok: true, code: 'unknown', message: 'main ref not found - code line unknown' };
  if (head !== mainHead) return { ok: false, code: 'stale_code_line', message: `checkout ${head.slice(0, 7)} (${branch}) is not main ${mainHead.slice(0, 7)} - refusing to run jobs with a different rule generation` };
  if (branch !== 'main' && !allowDetached) return { ok: false, code: 'not_main_branch', message: `branch ${branch} at main's commit but detached runs are not allowed` };
  return { ok: true, code: 'main', message: `main ${head.slice(0, 7)}${branch !== 'main' ? ' (' + branch + ')' : ''}${dirty ? ', ' + dirty + ' modified tracked file(s) in the working tree' : ''}` };
}

module.exports = { probeCodeLine, codeLineStatus };
