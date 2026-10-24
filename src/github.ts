import { readFile } from "node:fs/promises"
import { parsePolicy } from "./policy.js"
import type { Policy } from "./policy.js"
import { POLICY_PATH } from "./version.js"
import type { ChangedFile, CheckRun, CommitSlice, Snapshot } from "./decide.js"

export class GitHubError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "GitHubError"
  }
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

export type HttpControl = {
  sleep?: (milliseconds: number) => Promise<void>
  timeoutMs?: number
}

const RETRY_STATUSES = new Set([429, 500, 502, 503, 504])
const REPOSITORY_NAME = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/

type Event = {
  pull_request?: {
    number?: number
    body?: string | null
    labels?: { name?: string }[]
    user?: { login?: string }
    base?: { sha?: string }
    head?: { sha?: string }
  }
}

const CODEOWNER_PATHS = [".github/CODEOWNERS", "CODEOWNERS", "docs/CODEOWNERS"]

export async function loadPullRequest(
  env: NodeJS.ProcessEnv,
  fetchImpl: FetchLike,
  http: HttpControl = {},
): Promise<{ snapshot: Snapshot; policy: Policy; waiverActor: string | null; waiverActorType: string | null; authorLogin: string | null }> {
  const token = required(env, "GITHUB_TOKEN")
  const repository = repositoryName(required(env, "GITHUB_REPOSITORY"))
  const event = await readEvent(required(env, "GITHUB_EVENT_PATH"))
  const pull = event.pull_request
  if (!pull?.number || !Number.isInteger(pull.number) || pull.number < 1 || !isSha(pull.base?.sha) || !isSha(pull.head?.sha)) {
    throw new GitHubError("Not a pull request event.")
  }

  const api = apiBase(env)
  const policyText = await readRepoFile(fetchImpl, api, token, repository, POLICY_PATH, pull.base.sha, http)
  if (policyText === null) {
    throw new GitHubError(`${POLICY_PATH} is missing on the base branch.`)
  }
  const policy = parsePolicy(policyText)
  if (env.GITHUB_JOB && policy.testCheck === env.GITHUB_JOB) {
    throw new GitHubError(`testCheck "${policy.testCheck}" matches this job.`)
  }
  const labels = (pull.labels ?? []).flatMap((label) => (label.name ? [label.name] : []))
  const waiver = labels.includes(policy.waiverLabel)
    ? await readWaiverActor(fetchImpl, api, token, repository, pull.number, policy.waiverLabel, http)
    : { login: null, type: null }
  const [files, codeownersText, checks] = await Promise.all([
    readChangedFiles(fetchImpl, api, token, repository, pull.number, http),
    readFirstFile(fetchImpl, api, token, repository, CODEOWNER_PATHS, pull.base.sha, http),
    readChecks(fetchImpl, api, token, repository, pull.head.sha, http),
  ])
  const commits = await readSlices(fetchImpl, api, token, repository, pull.number, pull.head.sha, http)

  return {
    policy,
    waiverActor: waiver.login,
    waiverActorType: waiver.type,
    authorLogin: typeof pull.user?.login === "string" && pull.user.login !== "" ? pull.user.login : null,
    snapshot: {
      baseSha: pull.base.sha,
      headSha: pull.head.sha,
      body: pull.body ?? "",
      labels,
      files,
      codeownersText,
      checks,
      commits,
    },
  }
}

async function readEvent(eventPath: string): Promise<Event> {
  try {
    return JSON.parse(await readFile(eventPath, "utf8")) as Event
  } catch {
    throw new GitHubError("The GitHub event file could not be read.")
  }
}

async function readSlices(
  fetchImpl: FetchLike,
  api: string,
  token: string,
  repository: string,
  number: number,
  headSha: string,
  http: HttpControl,
): Promise<CommitSlice[]> {
  const rows = await pages(fetchImpl, api, token, `/repos/${repository}/pulls/${number}/commits`, http)
  const listed = rows.map((row) => ({
    sha: textField(row, "sha").toLowerCase(),
    parents: parentCount(row),
  }))
  if (listed.some((commit) => !isSha(commit.sha))) throw new GitHubError("GitHub returned a commit without a valid id.")
  if (new Set(listed.map((commit) => commit.sha)).size !== listed.length) {
    throw new GitHubError("GitHub returned the same commit twice.")
  }
  if (listed.length === 0) return []
  const head = listed[listed.length - 1]
  if (!head || head.sha !== headSha.toLowerCase()) throw new GitHubError("The pull request commits do not end at the head.")
  const measurable = listed.filter((commit) => commit.parents < 2)
  if (measurable.length > 100) throw new GitHubError("This pull request has more than 100 commits.")
  const details = measurable.length === 0 ? [] : await mapPool(measurable, 4, (commit) => readCommitFiles(fetchImpl, api, token, repository, commit.sha, http))
  const filesBySha = new Map(measurable.map((commit, index) => [commit.sha, details[index] ?? null]))
  return listed.map((commit) => ({
    sha: commit.sha,
    parents: commit.parents,
    files: commit.parents < 2 ? filesBySha.get(commit.sha) ?? null : null,
  }))
}

async function readCommitFiles(
  fetchImpl: FetchLike,
  api: string,
  token: string,
  repository: string,
  sha: string,
  http: HttpControl,
): Promise<ChangedFile[]> {
  const payload = asRecord(await request(fetchImpl, api, token, `/repos/${repository}/commits/${sha}`, http), "commit")
  const stats = asRecord(payload.stats, "commit stats")
  const total = numberField(stats, "total")
  if (!Array.isArray(payload.files)) {
    if (total === 0) return []
    throw new GitHubError(`Commit ${sha.slice(0, 7)} did not include its files.`)
  }
  if (payload.files.length >= 300) throw new GitHubError(`Commit ${sha.slice(0, 7)} changed too many files to measure.`)
  return payload.files.map((row) => {
    const item = asRecord(row, "commit file")
    return {
      path: textField(item, "filename"),
      additions: numberField(item, "additions"),
      deletions: numberField(item, "deletions"),
    }
  })
}

function parentCount(row: Record<string, unknown>): number {
  if (!Array.isArray(row.parents)) throw new GitHubError("GitHub returned a commit without parents.")
  return row.parents.length
}

async function mapPool<T, R>(items: T[], limit: number, run: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const workers = Math.min(limit, items.length)
  await Promise.all(Array.from({ length: workers }, async () => {
    while (next < items.length) {
      const index = next
      next += 1
      const item = items[index]
      if (item === undefined) return
      results[index] = await run(item)
    }
  }))
  return results
}

async function readChangedFiles(
  fetchImpl: FetchLike,
  api: string,
  token: string,
  repository: string,
  number: number,
  http: HttpControl,
): Promise<ChangedFile[]> {
  const rows = await pages(fetchImpl, api, token, `/repos/${repository}/pulls/${number}/files`, http)
  return rows.map((row) => ({
    path: textField(row, "filename"),
    additions: numberField(row, "additions"),
    deletions: numberField(row, "deletions"),
  }))
}

async function readChecks(
  fetchImpl: FetchLike,
  api: string,
  token: string,
  repository: string,
  sha: string,
  http: HttpControl,
): Promise<CheckRun[]> {
  const checks: CheckRun[] = []
  for (let page = 1; page <= 30; page++) {
    const payload = await request(fetchImpl, api, token, `/repos/${repository}/commits/${sha}/check-runs?per_page=100&page=${page}`, http)
    const record = asRecord(payload, "check runs")
    const rows = Array.isArray(record.check_runs) ? record.check_runs : []
    for (const row of rows) {
      const item = asRecord(row, "check run")
      checks.push({
        name: textField(item, "name"),
        conclusion: mapConclusion(item),
        startedAt: typeof item.started_at === "string" ? item.started_at : "",
      })
    }
    const total = typeof record.total_count === "number" ? record.total_count : null
    if (rows.length === 0 || rows.length < 100 || (total !== null && checks.length >= total)) break
    if (page === 30) throw new GitHubError("GitHub returned too many check pages.")
  }

  const statusPayload = asRecord(
    await request(fetchImpl, api, token, `/repos/${repository}/commits/${sha}/status`, http),
    "commit status",
  )
  const statuses = Array.isArray(statusPayload.statuses) ? statusPayload.statuses : []
  for (const row of statuses) {
    const item = asRecord(row, "status")
    checks.push({
      name: textField(item, "context"),
      conclusion: mapStatus(item.state),
      startedAt: typeof item.updated_at === "string" ? item.updated_at : "",
    })
  }
  return checks
}

async function readWaiverActor(
  fetchImpl: FetchLike,
  api: string,
  token: string,
  repository: string,
  number: number,
  waiverLabel: string,
  http: HttpControl,
): Promise<{ login: string | null; type: string | null }> {
  const events = await pages(fetchImpl, api, token, `/repos/${repository}/issues/${number}/events`, http)
  let actor = { login: null as string | null, type: null as string | null }
  for (const event of events) {
    if (event.event !== "labeled") continue
    if (nestedString(event.label, "name") !== waiverLabel) continue
    const login = nestedString(event.actor, "login")
    actor = { login: login || null, type: nestedString(event.actor, "type") || null }
  }
  return actor
}

async function readFirstFile(
  fetchImpl: FetchLike,
  api: string,
  token: string,
  repository: string,
  paths: string[],
  ref: string,
  http: HttpControl,
): Promise<string | null> {
  for (const path of paths) {
    const text = await readRepoFile(fetchImpl, api, token, repository, path, ref, http)
    if (text !== null) return text
  }
  return null
}

async function readRepoFile(
  fetchImpl: FetchLike,
  api: string,
  token: string,
  repository: string,
  path: string,
  ref: string,
  http: HttpControl,
): Promise<string | null> {
  const response = await send(fetchImpl, fileUrl(api, repository, path, ref), token, "application/vnd.github.raw", http)
  if (response.status === 404) return null
  if (!response.ok) throw new GitHubError(`GitHub API GET ${path} returned ${response.status}.`)
  return response.text()
}

async function pages(
  fetchImpl: FetchLike,
  api: string,
  token: string,
  path: string,
  http: HttpControl,
): Promise<Record<string, unknown>[]> {
  const rows: Record<string, unknown>[] = []
  for (let page = 1; page <= 30; page++) {
    const separator = path.includes("?") ? "&" : "?"
    const payload = await request(fetchImpl, api, token, `${path}${separator}per_page=100&page=${page}`, http)
    if (!Array.isArray(payload)) throw new GitHubError(`GitHub API GET ${path} returned an unexpected list.`)
    rows.push(...payload.map((row) => asRecord(row, path)))
    if (payload.length < 100) return rows
  }
  throw new GitHubError(`GitHub API GET ${path} returned too many pages.`)
}

async function request(fetchImpl: FetchLike, api: string, token: string, path: string, http: HttpControl): Promise<unknown> {
  const response = await send(fetchImpl, `${api}${path}`, token, "application/vnd.github+json", http)
  if (!response.ok) throw new GitHubError(`GitHub API GET ${path.split("?")[0]} returned ${response.status}.`)
  return response.json()
}

async function send(
  fetchImpl: FetchLike,
  url: string,
  token: string,
  accept: string,
  http: HttpControl,
): Promise<Response> {
  const sleep = http.sleep ?? ((milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds)))
  let last = new GitHubError("GitHub API could not be reached.")
  for (let attempt = 1; attempt <= 3; attempt++) {
    let waitFrom: Response | null = null
    try {
      const response = await fetchImpl(url, {
        headers: headers(token, accept),
        signal: AbortSignal.timeout(http.timeoutMs ?? 15_000),
      })
      if (!RETRY_STATUSES.has(response.status)) return response
      await response.body?.cancel().catch(() => undefined)
      waitFrom = response
      last = new GitHubError(`GitHub API returned ${response.status} after ${attempt} attempts.`)
    } catch (error) {
      if (error instanceof GitHubError) throw error
      last = new GitHubError("GitHub API could not be reached.")
    }
    if (attempt < 3) await sleep(retryDelay(waitFrom, attempt))
  }
  throw last
}

function retryDelay(response: Response | null, attempt: number): number {
  const header = response?.headers.get("retry-after")
  const seconds = header === undefined || header === null ? NaN : Number(header)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 5_000)
  return 250 * attempt
}

function fileUrl(api: string, repository: string, path: string, ref: string): string {
  return `${api}/repos/${repository}/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(ref)}`
}

function headers(token: string, accept: string): Record<string, string> {
  return {
    Accept: accept,
    Authorization: `Bearer ${token}`,
    "User-Agent": "merge-gate",
    "X-GitHub-Api-Version": "2022-11-28",
  }
}

function mapConclusion(row: Record<string, unknown>): CheckRun["conclusion"] {
  if (row.status !== "completed") return "pending"
  return row.conclusion === "success" ? "success" : "failure"
}

function mapStatus(state: unknown): CheckRun["conclusion"] {
  if (state === "success") return "success"
  if (state === "pending") return "pending"
  return "failure"
}

function asRecord(value: unknown, what: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new GitHubError(`GitHub returned an unexpected ${what}.`)
  }
  return value as Record<string, unknown>
}

function nestedString(value: unknown, key: string): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return ""
  const field = (value as Record<string, unknown>)[key]
  return typeof field === "string" ? field : ""
}

function textField(row: Record<string, unknown>, key: string): string {
  const value = row[key]
  if (typeof value !== "string" || value === "") throw new GitHubError(`GitHub returned a record without ${key}.`)
  return value
}

function numberField(row: Record<string, unknown>, key: string): number {
  const value = row[key]
  if (typeof value !== "number" || !Number.isFinite(value)) throw new GitHubError(`GitHub returned a record without a numeric ${key}.`)
  return value
}

function repositoryName(value: string): string {
  if (!REPOSITORY_NAME.test(value)) throw new GitHubError("GITHUB_REPOSITORY is not an owner/name repository.")
  return value
}

function apiBase(env: NodeJS.ProcessEnv): string {
  const value = env.GITHUB_API_URL ?? "https://api.github.com"
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new GitHubError("GITHUB_API_URL is not a valid URL.")
  }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "") {
    throw new GitHubError("GITHUB_API_URL must be an https URL without a password.")
  }
  return url.origin
}

function isSha(value: string | undefined): value is string {
  return typeof value === "string" && /^[0-9a-f]{40}$/i.test(value)
}

function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key]
  if (!value) throw new GitHubError(`${key} is missing.`)
  return value
}
