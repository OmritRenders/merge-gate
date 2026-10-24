#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkLocal } from "./check.js";
import { DEFAULT_THRESHOLD, DEFAULT_WAIVER_LABEL, POLICY_PATH, RULE_VERSION } from "./version.js";
const ACTION = "OmritRenders/merge-gate@v1.4.0";
const CHECKS = ["test", "merge-gate"];
const entry = (process.argv[1] ?? "").replaceAll("\\", "/");
if (entry.endsWith("/install.js") || entry.endsWith("/install.ts")) {
    const request = process.argv[2];
    if (request === "check")
        process.exit(checkLocal(process.cwd()));
    if (request && request !== "install") {
        process.stderr.write("Run: npx github:OmritRenders/merge-gate\n");
        process.exit(1);
    }
    process.exit(install(process.cwd()));
}
function install(start) {
    const root = repositoryRoot(start);
    const written = [];
    const skipped = [];
    writeNew(root, join(root, POLICY_PATH), policyText(), written, skipped);
    const ownersPath = existingOwners(root);
    if (ownersPath)
        skipped.push(ownersPath);
    else
        writeNew(root, join(root, ".github", "CODEOWNERS"), `* @${githubLogin() ?? "your-github-name"}\n`, written, skipped);
    const workflowPath = join(root, ".github", "workflows", workflowName(root));
    writeNew(root, workflowPath, workflowText(detectTest(root)), written, skipped);
    writeAgentFile(root, written, skipped);
    const repo = githubRepository(root);
    if (repo) {
        createLabel(repo);
        createRuleset(repo);
    }
    if (written.length > 0) {
        process.stdout.write(`Merge gate installed in ${root}\n`);
        for (const file of written)
            process.stdout.write(`Added ${file}\n`);
    }
    else {
        process.stdout.write("Merge gate is already installed.\n");
    }
    for (const file of skipped)
        process.stdout.write(`Left ${file} unchanged.\n`);
    if (!repo)
        process.stdout.write("Open a pull request so these files reach the default branch.\n");
    return checkLocal(root, { quietWhenClear: true });
}
function repositoryRoot(start) {
    return command("git", ["rev-parse", "--show-toplevel"], start) ?? start;
}
function policyText() {
    return `ruleVersion: ${RULE_VERSION}\nthreshold: ${DEFAULT_THRESHOLD}\nwaiverLabel: ${DEFAULT_WAIVER_LABEL}\ntestCheck: test\n`;
}
function workflowText(testCommand) {
    return `name: Review
on:
  pull_request:
    types: [opened, synchronize, reopened, labeled, unlabeled]

concurrency:
  group: merge-gate-\${{ github.event.pull_request.number }}
  cancel-in-progress: true

permissions:
  contents: read

jobs:
  test:
    runs-on: ubuntu-latest
    timeout-minutes: 20
    steps:
      - uses: actions/checkout@v4
      - run: ${testCommand}

  merge-gate:
    needs: test
    if: always()
    runs-on: ubuntu-latest
    timeout-minutes: 10
    permissions:
      contents: read
      pull-requests: read
      checks: read
      statuses: read
    steps:
      - uses: ${ACTION}
`;
}
function detectTest(directory) {
    if (existsSync(join(directory, "package.json")))
        return "npm test";
    if (existsSync(join(directory, "go.mod")))
        return "go test ./...";
    if (existsSync(join(directory, "Cargo.toml")))
        return "cargo test";
    if (existsSync(join(directory, "pyproject.toml")) || existsSync(join(directory, "pytest.ini")))
        return "pytest";
    if (existsSync(join(directory, "pom.xml")))
        return "mvn -B test";
    if (existsSync(join(directory, "build.gradle")) || existsSync(join(directory, "build.gradle.kts")))
        return "./gradlew test";
    if (existsSync(join(directory, "Gemfile")))
        return "bundle exec rake test";
    try {
        if (readdirSync(directory).some((name) => name.endsWith(".sln") || name.endsWith(".csproj")))
            return "dotnet test";
    }
    catch {
        return "npm test";
    }
    return "npm test";
}
function existingOwners(directory) {
    for (const path of [".github/CODEOWNERS", "CODEOWNERS", "docs/CODEOWNERS"]) {
        if (existsSync(join(directory, path)))
            return path;
    }
    return null;
}
function workflowName(directory) {
    const review = join(directory, ".github", "workflows", "review.yml");
    if (!existsSync(review))
        return "review.yml";
    return "merge-gate.yml";
}
function writeAgentFile(root, added, left) {
    const path = join(root, "AGENTS.md");
    const block = agentInstructions();
    if (!existsSync(path)) {
        writeNew(root, path, block, added, left);
        return;
    }
    const current = readFileSync(path, "utf8");
    if (current.includes("npx github:OmritRenders/merge-gate check")) {
        writeFileSync(path, current.replaceAll("npx github:OmritRenders/merge-gate check", "npx github:OmritRenders/merge-gate"), "utf8");
        added.push("AGENTS.md");
        return;
    }
    if (current.includes("npx github:OmritRenders/merge-gate")) {
        left.push("AGENTS.md");
        return;
    }
    writeFileSync(path, `${current.trimEnd()}\n\n${block}`, "utf8");
    added.push("AGENTS.md");
}
function agentInstructions() {
    return `# Merge gate

Before you open a pull request, run \`npx github:OmritRenders/merge-gate\` and fix every problem it reports. Keep each commit within the limit in \`.github/merge-gate.yml\`. A commit that changes application code includes a test file. Config, docs, infrastructure, and lockfiles do not need a new test file. Do not add the \`merge-gate-waive\` label.
`;
}
function writeNew(root, path, text, added, left) {
    const normalizedRoot = root.replaceAll("\\", "/").replace(/\/$/, "");
    const normalizedPath = path.replaceAll("\\", "/");
    const relative = normalizedPath.startsWith(`${normalizedRoot}/`) ? normalizedPath.slice(normalizedRoot.length + 1) : normalizedPath;
    if (existsSync(path)) {
        left.push(relative);
        return;
    }
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, text, "utf8");
    added.push(relative);
}
function githubRepository(directory) {
    const url = command("git", ["remote", "get-url", "origin"], directory);
    const match = url?.match(/github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?$/);
    const owner = match?.[1];
    const name = match?.[2];
    if (!owner || !name)
        return null;
    return `${owner}/${name}`;
}
function githubLogin() {
    return command("gh", ["api", "user", "--jq", ".login"]);
}
function createLabel(repo) {
    const result = command("gh", [
        "label",
        "create",
        DEFAULT_WAIVER_LABEL,
        "--repo",
        repo,
        "--color",
        "ededed",
        "--description",
        "Drops the Merge Gate size limit",
    ]);
    if (result === null)
        process.stdout.write(`Create the ${DEFAULT_WAIVER_LABEL} label on ${repo} if it is not there yet.\n`);
    else
        process.stdout.write(`Label ${DEFAULT_WAIVER_LABEL} is ready on ${repo}.\n`);
}
function createRuleset(repo) {
    const current = command("gh", ["api", `repos/${repo}/rulesets`, "--jq", ".[].name"]);
    if (current?.split("\n").includes("merge-gate")) {
        process.stdout.write("The merge-gate checks are already required.\n");
        return;
    }
    const body = JSON.stringify({
        name: "merge-gate",
        target: "branch",
        enforcement: "active",
        conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } },
        rules: [
            {
                type: "required_status_checks",
                parameters: {
                    strict_required_status_checks_policy: false,
                    required_status_checks: CHECKS.map((context) => ({ context })),
                },
            },
        ],
    });
    const created = command("gh", ["api", "--method", "POST", `repos/${repo}/rulesets`, "--input", "-"], undefined, body);
    if (created === null) {
        process.stdout.write("Require the test and merge-gate checks in Settings, then Branches.\n");
        return;
    }
    process.stdout.write("The test and merge-gate checks are now required on the default branch.\n");
}
function command(file, args, cwd, input) {
    try {
        return execFileSync(file, args, {
            cwd,
            input,
            encoding: "utf8",
            stdio: ["pipe", "pipe", "ignore"],
        }).trim();
    }
    catch {
        return null;
    }
}
