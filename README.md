# Merge gate

Stops a pull request that is too big, has a file nobody owns, or does not have a passing test.

A big pull request can still go through when every commit in it stays within the limit. Each commit needs an owner for its files. A commit that changes code also needs a test file. The test job still has to pass.

## Add it

Do this on the default branch.

1. Create `.github/merge-gate.yml`:

```yaml
ruleVersion: 1
threshold: 400
waiverLabel: merge-gate-waive
testCheck: test
```

`threshold` is how many added and deleted lines one commit may contain. `testCheck` is the name of the test job below. If you rename that job, change `testCheck` to the same name.

2. Create `.github/CODEOWNERS` if the repository does not have one yet. Put your GitHub name here:

```
* @your-github-name
```

3. Create `.github/workflows/review.yml`. Same file as `example/workflow.yml`. Change `npm test` to the test command this repository already uses.

4. On GitHub, open the repository **Settings**, then **Branches**, then add a rule for the default branch. Require the status checks named `test` and `merge-gate`. Also create a label named `merge-gate-waive`.

That label skips the size limit only. The pull request author cannot add it, and a bot cannot add it either. Owners and tests are still required.
