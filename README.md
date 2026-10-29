# Merge gate

Blocks a pull request that is too big, mixes two owners, or changes application code without a test.

AI agents can suggest splitting code, but they can't enforce it. Merge Gate blocks mixed pull requests and uses the repository's owner file to keep changes aligned with the right teams. Review is faster because each team reads only its own files.

Each commit has to stay within the limit. Docs, config, infrastructure, and lockfiles do not need a new test. Lockfiles do not count toward the limit.

## Install

From the project folder:

```bash
npx github:OmritRenders/merge-gate
```

One command. It adds the rule, the workflow, and an owner file when the repository does not have one. Run it again before opening a pull request. GitHub runs the same rules on the pull request.

If the test command is wrong, change the `run` line in `.github/workflows/review.yml`.

`merge-gate-waive` skips the size limit only. The author cannot add it, and a bot cannot add it either.

## Working on merge gate

`dist/` is committed and the action runs from it, so build before you commit:

```bash
npm ci
npm run build
npm run check:dist
```

`npm run check:dist` fails when `dist/` does not match `src/`, and CI runs it on every pull request.
