import { execFileSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { evaluate } from "./decide.js"
import type { ChangedFile, CheckRun, CommitSlice } from "./decide.js"
import { parsePolicy } from "./policy.js"
import { writeRecord } from "./record.js"
import { POLICY_PATH, TOOL_VERSION } from "./version.js"

export function checkLocal(start: string, options: { quietWhenClear?: boolean } = {}): number {
  const root = repositoryRoot(start)
  const policyFile = join(root, POLICY_PATH)
  if (!existsSync(policyFile)) {
    process.stdout.write("Merge gate is not installed. Run: npx github:OmritRenders/merge-gate\n")
    return 1
  }
  if (command(root, "git", ["status", "--porcelain"])) {
    if (options.quietWhenClear) return 0
    process.stdout.write("Commit your changes, then run npx github:OmritRenders/merge-gate again.\n")
    return 1
  }

  let policy
  try {
    policy = parsePolicy(readFileSync(policyFile, "utf8"))
  } catch (error) {
    process.stdout.write(`${error instanceof Error ? error.message : "The rule file could not be read."}\n`)
    return 1
  }

  const head = command(root, "git", ["rev-parse", "HEAD"])
  const base = command(root, "git", ["merge-base", "HEAD", baseRef(root)])
  if (!head || !base || !/^[0-9a-f]{40}$/i.test(head) || !/^[0-9a-f]{40}$/i.test(base)) {
    process.stdout.write("Merge gate could not find the base branch.\n")
    return 1
  }
  if (head === base) {
    if (!options.quietWhenClear) process.stdout.write("Merge gate: nothing to check.\n")
    return 0
  }

  const files = parseNumstat(command(root, "git", ["diff", "--numstat", "-M", `${base}...${head}`]) ?? "")
  const listed = (command(root, "git", ["rev-list", "--reverse", `${base}..${head}`]) ?? "").split("\n").filter(Boolean)
  if (listed.length > 100) {
    process.stdout.write("This branch has more than 100 commits.\n")
    return 1
  }

  let decision
  try {
    decision = evaluate(
    {
      baseSha: base.toLowerCase(),
      headSha: head.toLowerCase(),
      body: "",
      labels: [],
      files,
      codeownersText: readOwners(root),
      checks: [],
      commits: listed.map((sha) => commitSlice(root, sha)),
    },
    policy,
    TOOL_VERSION,
    )
  } catch (error) {
    process.stdout.write(`${error instanceof Error ? error.message : "Merge gate could not check this branch."}\n`)
    return 1
  }
  const waitingOnGitHub = decision.record.reasons.length > 0 && decision.record.reasons.every((reason) => reason.startsWith("The test check "))
  if (waitingOnGitHub) {
    process.stdout.write("Merge gate: the commits are ready.\nThe test job still has to pass on the pull request.\n")
    return 0
  }
  writeRecord(decision, process.env)
  return decision.allowed ? 0 : 1
}

function commitSlice(root: string, sha: string): CommitSlice {
  const line = command(root, "git", ["rev-list", "--parents", "-n", "1", sha]) ?? sha
  const parents = line.split(/\s+/).length - 1
  if (parents >= 2) return { sha: sha.toLowerCase(), parents, files: null }
  const files = parseNumstat(command(root, "git", ["show", "--numstat", "--format=", sha]) ?? "")
  return { sha: sha.toLowerCase(), parents, files: files.length >= 300 ? null : files }
}

function parseNumstat(text: string): ChangedFile[] {
  const files: ChangedFile[] = []
  for (const line of text.split("\n")) {
    if (line === "") continue
    const [added, deleted, ...rest] = line.split("\t")
    if (!added || !deleted || rest.length === 0) continue
    files.push({
      path: commitPath(rest.join("\t")),
      additions: added === "-" ? 0 : Number(added),
      deletions: deleted === "-" ? 0 : Number(deleted),
    })
  }
  return files
}

function commitPath(path: string): string {
  const brace = path.match(/^(.*)\{.* => (.*)\}(.*)$/)
  if (brace) return `${brace[1] ?? ""}${brace[2] ?? ""}${brace[3] ?? ""}`
  const arrow = path.lastIndexOf(" => ")
  if (arrow === -1) return path
  return path.slice(arrow + 4)
}

function readOwners(root: string): string | null {
  for (const path of [".github/CODEOWNERS", "CODEOWNERS", "docs/CODEOWNERS"]) {
    const full = join(root, path)
    if (existsSync(full)) return readFileSync(full, "utf8")
  }
  return null
}

function baseRef(root: string): string {
  const origin = command(root, "git", ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"])
  if (origin) return origin
  if (command(root, "git", ["rev-parse", "--verify", "--quiet", "origin/main"])) return "origin/main"
  if (command(root, "git", ["rev-parse", "--verify", "--quiet", "origin/master"])) return "origin/master"
  const branch = command(root, "git", ["branch", "--show-current"])
  if (branch !== "main" && command(root, "git", ["rev-parse", "--verify", "--quiet", "main"])) return "main"
  if (branch !== "master" && command(root, "git", ["rev-parse", "--verify", "--quiet", "master"])) return "master"
  return "HEAD"
}

function repositoryRoot(start: string): string {
  return command(start, "git", ["rev-parse", "--show-toplevel"]) ?? start
}

function command(cwd: string, file: string, args: string[]): string | null {
  try {
    return execFileSync(file, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim()
  } catch {
    return null
  }
}
