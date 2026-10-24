# Merge gate

Stops a pull request that is too big, has a file nobody owns, or does not have a passing test. It works for application code, services, mobile, and the config and infrastructure around them.

A big pull request can still go through when every commit in it stays within the limit. Each file needs an owner. Application code for two different owners cannot share one pull request. The report then names the files for each pull request, and names the largest files when a commit is over the limit. A commit that changes application code also needs a test file. Config, docs, infrastructure, lockfiles, and generated files do not need a new test file, and lockfiles do not count toward the size limit. The project's test job still has to pass.

## How it is different

A size checker looks at the finished pull request. The author can often click past it. Merge Gate measures every commit, so a later commit cannot hide a large one. The author cannot add `merge-gate-waive`. A teammate can, and that waiver skips the line limit only.

GitHub CODEOWNERS asks the named people to review. The mixed pull request can still merge. Merge Gate blocks application code for two owner groups in one pull request, then lists the files that belong in each smaller one.

A required test job means the tests that ran have passed. Merge Gate also blocks application code that came in with no test file. Config, docs, infrastructure, lockfiles, and generated files stay exempt.

Graphite can stack the split pull requests, and a review bot can suggest the split. The original pull request stays mergeable. Merge Gate is the required check, so that pull request stays blocked until the split is real.

## Install

From the repository, run:

```bash
npx github:OmritRenders/merge-gate
```

Use that one command in a terminal, Cursor, Claude, Copilot, or any other coding agent. It adds the rule, an owner file when the repository does not have one, the workflow, and instructions for the coding agent. When this computer is already signed in to GitHub, it also creates the `merge-gate-waive` label and requires the `test` and `merge-gate` checks.

The coding agent uses that same command before it opens a pull request and fixes what it reports. GitHub runs the same rules again on the pull request.

Open a pull request if those files are not on the default branch yet. If the test command is wrong, change the one `run` line in `.github/workflows/review.yml`.

`merge-gate-waive` skips the size limit only. The pull request author cannot add it, and a bot cannot add it either.
