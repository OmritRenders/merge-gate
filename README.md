# Merge gate

Stops a pull request that is too big, has a file nobody owns, or does not have a passing test.

A big pull request can still go through when every commit in it stays within the limit. Each commit needs an owner for its files. A commit that changes code also needs a test file. The test job still has to pass.

## Install

From the repository, run:

```bash
npx github:OmritRenders/merge-gate
```

Use that same command in a terminal, Cursor, Claude, Copilot, or any other coding agent. It adds the rule, an owner file when the repository does not have one, the workflow, and `AGENTS.md`. When this computer is already signed in to GitHub, it also creates the `merge-gate-waive` label and requires the `test` and `merge-gate` checks.

`AGENTS.md` tells the coding agent to run this before it opens a pull request:

```bash
npx github:OmritRenders/merge-gate check
```

The agent has to fix what that command reports. GitHub runs the same rules again on the pull request, so a later commit cannot sneak past them.

Open a pull request if those files are not on the default branch yet. If the test command is wrong, change the one `run` line in `.github/workflows/review.yml`.

`merge-gate-waive` skips the size limit only. The pull request author cannot add it, and a bot cannot add it either.
