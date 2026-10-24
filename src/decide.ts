import { ownersFor } from "./codeowners.js"
import type { Policy } from "./policy.js"
import { SCHEMA_VERSION, TOOL_NAME } from "./version.js"

export type ChangedFile = {
  path: string
  additions: number
  deletions: number
}

export type CheckRun = {
  name: string
  conclusion: "success" | "failure" | "pending"
  startedAt?: string
}

export type CommitSlice = {
  sha: string
  parents: number
  files: ChangedFile[] | null
}

export type Snapshot = {
  baseSha: string
  headSha: string
  body: string
  labels: string[]
  files: ChangedFile[]
  codeownersText: string | null
  checks: CheckRun[]
  commits?: CommitSlice[] | null
}

export type Annotation = {
  path: string | null
  message: string
}

export type GateRecord = {
  schemaVersion: typeof SCHEMA_VERSION
  tool: typeof TOOL_NAME
  version: string
  ruleVersion: number | null
  decidedAt: string
  allowed: boolean
  author: string | null
  threshold: number | null
  linesChanged: number | null
  baseSha: string | null
  headSha: string | null
  stackShas: string[]
  slices: { sha: string; lines: number }[]
  owners: string[]
  testCheck: {
    name: string | null
    conclusion: "success" | "failure" | "pending" | "missing" | "unknown"
  }
  waiver: { label: string; actor: string } | null
  reasons: string[]
}

export type Decision = {
  allowed: boolean
  annotations: Annotation[]
  record: GateRecord
}

export type ReviewContext = {
  waiverActor?: string | null
  waiverActorType?: string | null
  authorLogin?: string | null
  now?: Date
}

export function evaluate(snapshot: Snapshot, policy: Policy, version: string, review: ReviewContext = {}): Decision {
  if (!snapshot || !Array.isArray(snapshot.files) || typeof snapshot.body !== "string" || !Array.isArray(snapshot.labels) || !Array.isArray(snapshot.checks)) {
    throw new Error("The change snapshot is incomplete.")
  }
  const reasons: string[] = []
  const linesChanged = changedLines(snapshot.files)
  const stack = readStack(snapshot.body)
  if (stack.error) reasons.push(stack.error)

  const waiver = readWaiver(snapshot.labels, policy.waiverLabel, review)
  if (waiver.problem) reasons.push(waiver.problem)

  const ownership = resolveOwners(snapshot)
  reasons.push(...ownership.reasons)
  if (snapshot.codeownersText) {
    const mixed = ownerAreas(snapshot.files, snapshot.codeownersText)
    if (mixed.length > 1) {
      reasons.push(splitPlan(snapshot.files, snapshot.codeownersText, mixed))
      for (const area of mixed.slice(0, 4)) {
        const example = area.files[0]
        if (!example || ownership.annotations.length >= 20) break
        ownership.annotations.push({ path: example, message: `Owned by ${area.owners}. Keep this file with that pull request only.` })
      }
    }
  }
  const slices = reviewCommits(snapshot, policy, linesChanged, Boolean(waiver.applied), ownership.missing, reasons, snapshot.codeownersText !== null && ownerAreas(snapshot.files, snapshot.codeownersText).length > 1)

  if (ownership.sourceChanged && !ownership.testFileChanged) {
    const source = snapshot.files.find((file) => isSource(file.path))
    reasons.push(`Source files changed and no test file changed.${source ? ` Add a test for ${source.path}.` : ""}`)
  }

  const testCheck = concludeTest(snapshot.checks, policy.testCheck)
  if (testCheck.conclusion !== "success") {
    reasons.push(testCheck.reason)
  }

  const allowed = reasons.length === 0
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
  }
}

export function failClosed(version: string, reason: string, now: Date = new Date()): Decision {
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
  }
}

function reviewCommits(
  snapshot: Snapshot,
  policy: Policy,
  linesChanged: number,
  waived: boolean,
  ownedMissing: string[],
  reasons: string[],
  planned: boolean,
): { checked: boolean; measured: { sha: string; lines: number }[] } {
  const commits = snapshot.commits === undefined ? null : snapshot.commits
  if (commits === null) {
    if (!waived && linesChanged > policy.threshold) {
      reasons.push(`${linesChanged} lines changed. Limit is ${policy.threshold}.`)
    }
    return { checked: false, measured: [] }
  }
  if (!Array.isArray(commits)) throw new Error("The change snapshot is incomplete.")

  const already = new Set(ownedMissing)
  const measured: { sha: string; lines: number }[] = []
  const codeowners = snapshot.codeownersText
  let sizeBroken = false
  const singleParent = commits.filter((commit) => {
    if (!commit || !/^[0-9a-f]{40}$/.test(commit.sha) || !Number.isInteger(commit.parents) || commit.parents < 0) {
      throw new Error("The change snapshot is incomplete.")
    }
    return commit.parents < 2
  })
  if (singleParent.length === 0) {
    if (!waived && linesChanged > policy.threshold) {
      reasons.push("No commit on this pull request could be checked.")
      reasons.push(`${linesChanged} lines changed. Limit is ${policy.threshold}.`)
    }
    return { checked: false, measured: [] }
  }

  const split = linesChanged > policy.threshold
  for (const commit of singleParent) {
    const short = commit.sha.slice(0, 7)
    if (commit.files === null) {
      reasons.push(`Commit ${short} changed too many files to measure.`)
      sizeBroken = true
      continue
    }
    if (!Array.isArray(commit.files)) throw new Error("The change snapshot is incomplete.")
    const lines = changedLines(commit.files)
    measured.push({ sha: commit.sha, lines })
    if (!waived && lines > policy.threshold) {
      reasons.push(`Commit ${short} changes ${lines} lines. Limit is ${policy.threshold}.${largestFiles(commit.files)}`)
      sizeBroken = true
    }
    if (split && commit.files.some((file) => isSource(file.path)) && !commit.files.some((file) => isTestPath(file.path))) {
      const source = commit.files.find((file) => isSource(file.path))
      reasons.push(`Commit ${short} changes source and no test file. Add a test file in this commit${source ? ` for ${source.path}` : ""}.`)
    }
    if (codeowners !== null) {
      const mixed = ownerAreas(commit.files, codeowners)
      if (mixed.length > 1) {
        reasons.push(planned ? `Commit ${short} mixes owners.` : `Commit ${short} mixes owners. ${splitPlan(commit.files, codeowners, mixed)}`)
      }
    }
    if (split && codeowners !== null) {
      const missing = commit.files.filter((file) => !already.has(file.path) && ownersFor(file.path, codeowners).length === 0)
      if (missing.length > 0) {
        reasons.push(`Commit ${short} has no owner for ${missing.slice(0, 10).map((file) => file.path).join(", ")}.`)
      }
    }
  }

  if (!waived && sizeBroken && linesChanged > policy.threshold) {
    reasons.push(`${linesChanged} lines changed. Limit is ${policy.threshold}.`)
  }
  return { checked: true, measured }
}

function changedLines(files: ChangedFile[]): number {
  return files.reduce((total, file) => {
    if (!isRepoPath(file.path)) throw new Error(`File "${file.path}" is not a path inside the repository.`)
    if (!Number.isSafeInteger(file.additions) || !Number.isSafeInteger(file.deletions) || file.additions < 0 || file.deletions < 0) {
      throw new Error(`File "${file.path}" has an invalid line count.`)
    }
    if (!countsTowardLimit(file.path)) return total
    const next = total + file.additions + file.deletions
    if (!Number.isSafeInteger(next)) throw new Error("The change is too large to measure safely.")
    return next
  }, 0)
}

function ownerAreas(files: ChangedFile[], codeowners: string): { owners: string; files: string[] }[] {
  const areas = new Map<string, string[]>()
  for (const file of files) {
    if (!isSource(file.path)) continue
    const owners = ownersFor(file.path, codeowners).slice().sort()
    if (owners.length === 0) continue
    const key = owners.join(", ")
    const list = areas.get(key)
    if (list) list.push(file.path)
    else areas.set(key, [file.path])
  }
  return [...areas.entries()].map(([owners, paths]) => ({ owners, files: paths }))
}

function splitPlan(files: ChangedFile[], codeowners: string, areas: { owners: string; files: string[] }[]): string {
  const groups = areas.map((area) => ({ owners: area.owners, files: [...area.files] }))
  const loose: string[] = []
  for (const file of files) {
    if (isSource(file.path)) continue
    const owners = ownersFor(file.path, codeowners).slice().sort().join(", ")
    const group = groups.find((item) => item.owners === owners)
    if (group) group.files.push(file.path)
    else if (owners) loose.push(file.path)
  }
  const shown = groups.slice(0, 6).map((group, index) => {
    const names = group.files.slice(0, 8).join(", ")
    const extra = group.files.length > 8 ? `, and ${group.files.length - 8} more` : ""
    return `${index + 1}. ${group.owners}: ${names}${extra}`
  })
  const rest = groups.length > 6 ? ` ${groups.length - 6} more owner groups follow the same pattern.` : ""
  const anywhere = loose.length === 0 ? "" : ` ${loose.slice(0, 8).join(", ")}${loose.length > 8 ? `, and ${loose.length - 8} more` : ""} can go with any one of those pull requests.`
  return `Open one pull request per owner. ${shown.join(" ")}${rest}${anywhere}`
}

function largestFiles(files: ChangedFile[]): string {
  const ranked = files
    .filter((file) => countsTowardLimit(file.path))
    .map((file) => ({ path: file.path, lines: file.additions + file.deletions }))
    .sort((left, right) => right.lines - left.lines)
    .slice(0, 5)
  if (ranked.length === 0) return ""
  return ` Move the largest files into their own commits: ${ranked.map((file) => `${file.path} (${file.lines})`).join(", ")}.`
}

function isRepoPath(filePath: string): boolean {
  if (filePath === "" || filePath.startsWith("/") || filePath.includes("\\") || filePath.includes("\0")) return false
  return !filePath.split("/").includes("..")
}

function readStack(body: string): { shas: string[]; error: string | null } {
  const markers = body.match(/<!--\s*merge-gate-stack:[\s\S]*?-->/gi) ?? []
  if (markers.length > 1) {
    return { shas: [], error: "More than one merge-gate-stack comment." }
  }
  if (markers.length === 0) {
    if (/merge-gate-stack\s*:/i.test(body)) {
      return {
        shas: [],
        error: "merge-gate-stack comment is invalid.",
      }
    }
    return { shas: [], error: null }
  }
  const marker = markers[0] ?? ""
  const inside = marker.replace(/^<!--\s*merge-gate-stack:/i, "").replace(/-->$/, "").trim()
  if (inside === "") {
    return { shas: [], error: "merge-gate-stack comment is empty." }
  }
  const parts = inside.split(/\s+/)
  if (parts.some((part) => !/^[0-9a-f]{7,40}$/i.test(part))) {
    return { shas: [], error: "merge-gate-stack comment has a bad commit id." }
  }
  return { shas: parts.map((part) => part.toLowerCase()), error: null }
}

function readWaiver(
  labels: string[],
  waiverLabel: string,
  review: ReviewContext,
): { applied: { label: string; actor: string } | null; problem: string | null } {
  if (!labels.includes(waiverLabel)) return { applied: null, problem: null }
  const actor = review.waiverActor ?? null
  if (!actor) {
    return {
      applied: null,
      problem: `Waiver label "${waiverLabel}" has no confirmed user.`,
    }
  }
  if (!review.authorLogin) {
    return {
      applied: null,
      problem: "Pull request author is unknown. Waiver ignored.",
    }
  }
  if (actor === review.authorLogin) {
    return {
      applied: null,
      problem: `${actor} cannot waive their own pull request.`,
    }
  }
  if (review.waiverActorType === "Bot" || actor.endsWith("[bot]")) {
    return {
      applied: null,
      problem: `${actor} cannot add the waiver label.`,
    }
  }
  return { applied: { label: waiverLabel, actor }, problem: null }
}

function resolveOwners(snapshot: Snapshot): {
  owners: string[]
  reasons: string[]
  annotations: Annotation[]
  sourceChanged: boolean
  testFileChanged: boolean
  missing: string[]
} {
  if (snapshot.files.length === 0) {
    return {
      owners: [],
      reasons: ["Pull request has no files."],
      annotations: [],
      sourceChanged: false,
      testFileChanged: false,
      missing: [],
    }
  }
  if (snapshot.codeownersText === null) {
    return {
      owners: [],
      reasons: ["CODEOWNERS is missing on the base branch."],
      annotations: [],
      sourceChanged: snapshot.files.some((file) => isSource(file.path)),
      testFileChanged: snapshot.files.some((file) => isTestPath(file.path)),
      missing: [],
    }
  }

  const owners = new Set<string>()
  const missing: string[] = []
  for (const file of snapshot.files) {
    const fileOwners = ownersFor(file.path, snapshot.codeownersText)
    if (fileOwners.length === 0) missing.push(file.path)
    for (const owner of fileOwners) owners.add(owner)
  }
  const reasons: string[] = []
  const annotations = missing.slice(0, 20).map((path) => ({
    path,
    message: `No owner in CODEOWNERS for ${path}.`,
  }))
  if (missing.length > 0) {
    const shown = missing.slice(0, 20).join(", ")
    const extra = missing.length > 20 ? ` and ${missing.length - 20} more` : ""
    reasons.push(`These files have no owner in CODEOWNERS: ${shown}${extra}.`)
  }
  return {
    owners: [...owners],
    reasons,
    annotations,
    sourceChanged: snapshot.files.some((file) => isSource(file.path)),
    testFileChanged: snapshot.files.some((file) => isTestPath(file.path)),
    missing,
  }
}

function concludeTest(checks: CheckRun[], name: string): {
  conclusion: "success" | "failure" | "pending" | "missing"
  reason: string
} {
  const latest = checks
    .filter((check) => check.name === name)
    .reduce<CheckRun | null>((best, check) => {
      if (!best) return check
      return (check.startedAt ?? "") >= (best.startedAt ?? "") ? check : best
    }, null)
  if (!latest) return { conclusion: "missing", reason: `The test check "${name}" has not run.` }
  if (latest.conclusion === "pending") return { conclusion: "pending", reason: `The test check "${name}" is still running.` }
  if (latest.conclusion === "success") return { conclusion: "success", reason: "" }
  return { conclusion: "failure", reason: `The test check "${name}" did not pass.` }
}

export function isTestPath(filePath: string): boolean {
  return (
    /(^|\/)[^/]*\.(test|spec)\.[^/]+$/i.test(filePath) ||
    /(^|\/)test_[^/]+$/i.test(filePath) ||
    /(^|\/)[^/]+_test\.[^/]+$/i.test(filePath) ||
    /(^|\/)[^/]*Test\.[^/]+$/.test(filePath) ||
    /(^|\/)[^/]*Tests\.[^/]+$/.test(filePath) ||
    /(^|\/)[^/]*IT\.[^/]+$/.test(filePath) ||
    /(^|\/)__tests__\//i.test(filePath) ||
    /(^|\/)tests?\//i.test(filePath) ||
    /(^|\/)spec\//i.test(filePath)
  )
}

function isSource(filePath: string): boolean {
  if (isTestPath(filePath) || isGenerated(filePath)) return false
  return /\.(tsx?|jsx?|mjs|cjs|py|go|java|kt|kts|scala|rb|php|cs|cpp|cc|cxx|c|h|hpp|hh|swift|dart|ex|exs|lua|vue|svelte)$/i.test(filePath)
}

function countsTowardLimit(filePath: string): boolean {
  return !isGenerated(filePath)
}

function isGenerated(filePath: string): boolean {
  return (
    /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lock|go\.sum|Cargo\.lock|poetry\.lock|composer\.lock|Gemfile\.lock|uv\.lock|packages\.lock\.json|Package\.resolved|CODEOWNERS|merge-gate\.yml)$/i.test(filePath) ||
    /(^|\/)(vendor|node_modules|dist|coverage|generated|__snapshots__)(\/|$)/i.test(filePath) ||
    /\.(min\.js|js\.map|d\.ts\.map|lock)$/i.test(filePath)
  )
}
