import { ownersFor } from "./codeowners.js";
import { SCHEMA_VERSION, TOOL_NAME } from "./version.js";
export function evaluate(snapshot, policy, version, review = {}) {
    if (!snapshot || !Array.isArray(snapshot.files) || typeof snapshot.body !== "string" || !Array.isArray(snapshot.labels) || !Array.isArray(snapshot.checks)) {
        throw new Error("The change snapshot is incomplete.");
    }
    const reasons = [];
    const linesChanged = changedLines(snapshot.files);
    const stack = readStack(snapshot.body);
    if (stack.error)
        reasons.push(stack.error);
    const waiver = readWaiver(snapshot.labels, policy.waiverLabel, review);
    if (waiver.problem)
        reasons.push(waiver.problem);
    const ownership = resolveOwners(snapshot);
    reasons.push(...ownership.reasons);
    const slices = reviewCommits(snapshot, policy, linesChanged, Boolean(waiver.applied), ownership.missing, reasons);
    if (ownership.sourceChanged && !ownership.testFileChanged) {
        reasons.push("Source files changed and no test file changed.");
    }
    const testCheck = concludeTest(snapshot.checks, policy.testCheck);
    if (testCheck.conclusion !== "success") {
        reasons.push(testCheck.reason);
    }
    const allowed = reasons.length === 0;
    return {
        allowed,
        annotations: ownership.annotations,
        record: {
            schemaVersion: SCHEMA_VERSION,
            tool: TOOL_NAME,
            version,
            ruleVersion: policy.ruleVersion,
            decidedAt: (review.now ?? new Date()).toISOString(),
            allowed,
            author: review.authorLogin ?? null,
            threshold: policy.threshold,
            linesChanged,
            baseSha: snapshot.baseSha,
            headSha: snapshot.headSha,
            stackShas: stack.shas,
            slices: slices.measured,
            owners: ownership.owners,
            testCheck: { name: policy.testCheck, conclusion: testCheck.conclusion },
            waiver: waiver.applied,
            reasons,
        },
    };
}
export function failClosed(version, reason, now = new Date()) {
    return {
        allowed: false,
        annotations: [],
        record: {
            schemaVersion: SCHEMA_VERSION,
            tool: TOOL_NAME,
            version,
            ruleVersion: null,
            decidedAt: now.toISOString(),
            allowed: false,
            author: null,
            threshold: null,
            linesChanged: null,
            baseSha: null,
            headSha: null,
            stackShas: [],
            slices: [],
            owners: [],
            testCheck: { name: null, conclusion: "unknown" },
            waiver: null,
            reasons: [reason],
        },
    };
}
function reviewCommits(snapshot, policy, linesChanged, waived, ownedMissing, reasons) {
    const commits = snapshot.commits === undefined ? null : snapshot.commits;
    if (commits === null) {
        if (!waived && linesChanged > policy.threshold) {
            reasons.push(`${linesChanged} lines changed. Limit is ${policy.threshold}.`);
        }
        return { checked: false, measured: [] };
    }
    if (!Array.isArray(commits))
        throw new Error("The change snapshot is incomplete.");
    const already = new Set(ownedMissing);
    const measured = [];
    const codeowners = snapshot.codeownersText;
    let sizeBroken = false;
    const singleParent = commits.filter((commit) => {
        if (!commit || !/^[0-9a-f]{40}$/.test(commit.sha) || !Number.isInteger(commit.parents) || commit.parents < 0) {
            throw new Error("The change snapshot is incomplete.");
        }
        return commit.parents < 2;
    });
    if (singleParent.length === 0) {
        if (!waived && linesChanged > policy.threshold) {
            reasons.push("No commit on this pull request could be checked.");
            reasons.push(`${linesChanged} lines changed. Limit is ${policy.threshold}.`);
        }
        return { checked: false, measured: [] };
    }
    const split = linesChanged > policy.threshold;
    for (const commit of singleParent) {
        const short = commit.sha.slice(0, 7);
        if (commit.files === null) {
            reasons.push(`Commit ${short} changed too many files to measure.`);
            sizeBroken = true;
            continue;
        }
        if (!Array.isArray(commit.files))
            throw new Error("The change snapshot is incomplete.");
        const lines = changedLines(commit.files);
        measured.push({ sha: commit.sha, lines });
        if (!waived && lines > policy.threshold) {
            reasons.push(`Commit ${short} changes ${lines} lines. Limit is ${policy.threshold}.`);
            sizeBroken = true;
        }
        if (split && commit.files.some((file) => isSource(file.path)) && !commit.files.some((file) => isTestPath(file.path))) {
            reasons.push(`Commit ${short} changes source and no test file.`);
        }
        if (split && codeowners !== null) {
            const missing = commit.files.filter((file) => !already.has(file.path) && ownersFor(file.path, codeowners).length === 0);
            if (missing.length > 0) {
                reasons.push(`Commit ${short} has no owner for ${missing.slice(0, 10).map((file) => file.path).join(", ")}.`);
            }
        }
    }
    if (!waived && sizeBroken && linesChanged > policy.threshold) {
        reasons.push(`${linesChanged} lines changed. Limit is ${policy.threshold}.`);
    }
    return { checked: true, measured };
}
function changedLines(files) {
    return files.reduce((total, file) => {
        if (!isRepoPath(file.path))
            throw new Error(`File "${file.path}" is not a path inside the repository.`);
        if (!Number.isSafeInteger(file.additions) || !Number.isSafeInteger(file.deletions) || file.additions < 0 || file.deletions < 0) {
            throw new Error(`File "${file.path}" has an invalid line count.`);
        }
        if (!countsTowardLimit(file.path))
            return total;
        const next = total + file.additions + file.deletions;
        if (!Number.isSafeInteger(next))
            throw new Error("The change is too large to measure safely.");
        return next;
    }, 0);
}
function isRepoPath(filePath) {
    if (filePath === "" || filePath.startsWith("/") || filePath.includes("\\") || filePath.includes("\0"))
        return false;
    return !filePath.split("/").includes("..");
}
function readStack(body) {
    const markers = body.match(/<!--\s*merge-gate-stack:[\s\S]*?-->/gi) ?? [];
    if (markers.length > 1) {
        return { shas: [], error: "More than one merge-gate-stack comment." };
    }
    if (markers.length === 0) {
        if (/merge-gate-stack\s*:/i.test(body)) {
            return {
                shas: [],
                error: "merge-gate-stack comment is invalid.",
            };
        }
        return { shas: [], error: null };
    }
    const marker = markers[0] ?? "";
    const inside = marker.replace(/^<!--\s*merge-gate-stack:/i, "").replace(/-->$/, "").trim();
    if (inside === "") {
        return { shas: [], error: "merge-gate-stack comment is empty." };
    }
    const parts = inside.split(/\s+/);
    if (parts.some((part) => !/^[0-9a-f]{7,40}$/i.test(part))) {
        return { shas: [], error: "merge-gate-stack comment has a bad commit id." };
    }
    return { shas: parts.map((part) => part.toLowerCase()), error: null };
}
function readWaiver(labels, waiverLabel, review) {
    if (!labels.includes(waiverLabel))
        return { applied: null, problem: null };
    const actor = review.waiverActor ?? null;
    if (!actor) {
        return {
            applied: null,
            problem: `Waiver label "${waiverLabel}" has no confirmed user.`,
        };
    }
    if (!review.authorLogin) {
        return {
            applied: null,
            problem: "Pull request author is unknown. Waiver ignored.",
        };
    }
    if (actor === review.authorLogin) {
        return {
            applied: null,
            problem: `${actor} cannot waive their own pull request.`,
        };
    }
    if (review.waiverActorType === "Bot" || actor.endsWith("[bot]")) {
        return {
            applied: null,
            problem: `${actor} cannot add the waiver label.`,
        };
    }
    return { applied: { label: waiverLabel, actor }, problem: null };
}
function resolveOwners(snapshot) {
    if (snapshot.files.length === 0) {
        return {
            owners: [],
            reasons: ["Pull request has no files."],
            annotations: [],
            sourceChanged: false,
            testFileChanged: false,
            missing: [],
        };
    }
    if (snapshot.codeownersText === null) {
        return {
            owners: [],
            reasons: ["CODEOWNERS is missing on the base branch."],
            annotations: [],
            sourceChanged: snapshot.files.some((file) => isSource(file.path)),
            testFileChanged: snapshot.files.some((file) => isTestPath(file.path)),
            missing: [],
        };
    }
    const owners = new Set();
    const missing = [];
    for (const file of snapshot.files) {
        const fileOwners = ownersFor(file.path, snapshot.codeownersText);
        if (fileOwners.length === 0)
            missing.push(file.path);
        for (const owner of fileOwners)
            owners.add(owner);
    }
    const reasons = [];
    const annotations = missing.slice(0, 20).map((path) => ({
        path,
        message: `No owner in CODEOWNERS for ${path}.`,
    }));
    if (missing.length > 0) {
        const shown = missing.slice(0, 20).join(", ");
        const extra = missing.length > 20 ? ` and ${missing.length - 20} more` : "";
        reasons.push(`These files have no owner in CODEOWNERS: ${shown}${extra}.`);
    }
    return {
        owners: [...owners],
        reasons,
        annotations,
        sourceChanged: snapshot.files.some((file) => isSource(file.path)),
        testFileChanged: snapshot.files.some((file) => isTestPath(file.path)),
        missing,
    };
}
function concludeTest(checks, name) {
    const latest = checks
        .filter((check) => check.name === name)
        .reduce((best, check) => {
        if (!best)
            return check;
        return (check.startedAt ?? "") >= (best.startedAt ?? "") ? check : best;
    }, null);
    if (!latest)
        return { conclusion: "missing", reason: `The test check "${name}" has not run.` };
    if (latest.conclusion === "pending")
        return { conclusion: "pending", reason: `The test check "${name}" is still running.` };
    if (latest.conclusion === "success")
        return { conclusion: "success", reason: "" };
    return { conclusion: "failure", reason: `The test check "${name}" did not pass.` };
}
export function isTestPath(filePath) {
    return (/(^|\/)[^/]*\.(test|spec)\.[^/]+$/i.test(filePath) ||
        /(^|\/)test_[^/]+$/i.test(filePath) ||
        /(^|\/)[^/]+_test\.[^/]+$/i.test(filePath) ||
        /(^|\/)[^/]*Test\.[^/]+$/.test(filePath) ||
        /(^|\/)[^/]*Tests\.[^/]+$/.test(filePath) ||
        /(^|\/)[^/]*IT\.[^/]+$/.test(filePath) ||
        /(^|\/)__tests__\//i.test(filePath) ||
        /(^|\/)tests?\//i.test(filePath) ||
        /(^|\/)spec\//i.test(filePath));
}
function isSource(filePath) {
    if (isTestPath(filePath) || isGenerated(filePath))
        return false;
    return /\.(tsx?|jsx?|mjs|cjs|py|go|java|kt|kts|scala|rb|php|cs|cpp|cc|cxx|c|h|hpp|hh|swift|dart|ex|exs|lua|vue|svelte)$/i.test(filePath);
}
function countsTowardLimit(filePath) {
    return !isGenerated(filePath);
}
function isGenerated(filePath) {
    return (/(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lock|go\.sum|Cargo\.lock|poetry\.lock|composer\.lock|Gemfile\.lock|uv\.lock|packages\.lock\.json|Package\.resolved|CODEOWNERS|merge-gate\.yml)$/i.test(filePath) ||
        /(^|\/)(vendor|node_modules|dist|coverage|generated|__snapshots__)(\/|$)/i.test(filePath) ||
        /\.(min\.js|js\.map|d\.ts\.map|lock)$/i.test(filePath));
}
