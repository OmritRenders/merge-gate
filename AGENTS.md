# Merge gate

Before you open a pull request, run `npx github:OmritRenders/merge-gate` and fix every problem it reports. When the report lists owners, open one pull request per owner and include only the files it names. When it names the largest files, move those into their own commits. Keep each commit within the limit in `.github/merge-gate.yml`. A commit that changes application code includes a test file. Config, docs, infrastructure, and lockfiles do not need a new test file. Do not add the `merge-gate-waive` label.
