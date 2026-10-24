# Merge gate

Before you open a pull request, run `npx github:OmritRenders/merge-gate check` and fix every problem it reports. Keep each commit within the limit in `.github/merge-gate.yml`. A commit that changes code includes a test file. Do not add the `merge-gate-waive` label.
