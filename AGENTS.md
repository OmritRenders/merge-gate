# Merge gate

Before you open a pull request, run `npx github:OmritRenders/merge-gate` and fix every problem it reports. Keep each commit within the limit in `.github/merge-gate.yml`. Keep a pull request to one owner area. A commit that changes application code includes a test file. Config, docs, infrastructure, and lockfiles do not need a new test file. Do not add the `merge-gate-waive` label.
