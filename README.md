# Merge gate

Blocks a pull request that is too big, mixes two owners, or changes application code without a test.

An agent can say to split billing and login. GitHub can still merge that pull request. Merge Gate keeps it closed. The file list comes from the owner file, so the split matches the real teams.

Each commit has to stay within the limit. Docs, config, infrastructure, and lockfiles do not need a new test. Lockfiles do not count toward the limit.

## Install

From the project folder:

```bash
npx github:OmritRenders/merge-gate
```

One command. It adds the rule, the workflow, and an owner file when the repository does not have one. Run it again before opening a pull request. GitHub runs the same rules on the pull request.

If the test command is wrong, change the `run` line in `.github/workflows/review.yml`.

`merge-gate-waive` skips the size limit only. The author cannot add it, and a bot cannot add it either.
