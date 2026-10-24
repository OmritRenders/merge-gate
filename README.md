# Merge gate

Blocks a GitHub pull request that is over the size limit, has a file without an owner, or does not have a passing test.

Each commit is checked on its own. One commit cannot go over the limit, even if a later commit undoes part of it. A pull request that is still over the limit in total is allowed when every commit stays within the limit, every file in that commit has an owner, and a commit that changes code includes a test file. The test job still has to pass. A commit that only merges other commits is not counted as one of those pieces.

## Setup

1. Copy `example/merge-gate.yml` to `.github/merge-gate.yml` on the default branch. Set `testCheck` to the test job name.
2. Add `CODEOWNERS` at `.github/CODEOWNERS`, `CODEOWNERS`, or `docs/CODEOWNERS`.
3. Copy `example/workflow.yml` to `.github/workflows/review.yml`. If this folder is the repository root, change the action path to `uses: ./`.
4. Require the `test` and `merge-gate` checks in branch protection, and create the `merge-gate-waive` label.

```bash
npm ci
npm run build
```

The action entry point is `dist/src/cli.js`.

`merge-gate-waive` drops the size limit only. The pull request author cannot add it, and neither can a bot.

```html
<!-- merge-gate-stack: abc1234 def5678 -->
```

That note is stored with the decision. It does not raise the limit.
