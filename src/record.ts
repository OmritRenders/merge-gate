import { appendFileSync } from "node:fs"
import type { Decision } from "./decide.js"

export function renderRecord(decision: Decision): string {
  const record = decision.record
  const headline = record.allowed ? "Merge gate: allowed" : "Merge gate: blocked"
  const reasons = record.reasons.length === 0 ? "All required checks passed." : record.reasons.map((reason) => `- ${reason}`).join("\n")
  const waiver = record.waiver ? `${record.waiver.actor} used ${record.waiver.label}` : "none"
  return [
    headline,
    "",
    reasons,
    "",
    `Record schema: ${record.schemaVersion}`,
    `Tool: ${record.version}`,
    `Rule: ${record.ruleVersion ?? "unknown"}`,
    `Decided: ${record.decidedAt}`,
    `Author: ${record.author ?? "unknown"}`,
    `Limit: ${record.threshold ?? "unknown"} lines`,
    `Size: ${record.linesChanged ?? "unknown"} lines`,
    `Slices: ${record.slices.length === 0 ? "not used" : record.slices.map((slice) => `${slice.sha.slice(0, 7)} ${slice.lines}`).join(", ")}`,
    `Base: ${record.baseSha ?? "unknown"}`,
    `Head: ${record.headSha ?? "unknown"}`,
    `Stack: ${record.stackShas.length === 0 ? "none recorded" : record.stackShas.join(" ")}`,
    `Owners: ${record.owners.length === 0 ? "none" : record.owners.join(", ")}`,
    `Test: ${record.testCheck.name ?? "unknown"} (${record.testCheck.conclusion})`,
    `Waiver: ${waiver}`,
    "",
    "```json",
    JSON.stringify(record, null, 2),
    "```",
    "",
  ].join("\n")
}

export function workflowErrors(decision: Decision): string[] {
  if (decision.allowed) return []
  const lines = decision.record.reasons.map((reason) => command(reason, null))
  for (const annotation of decision.annotations) lines.push(command(annotation.message, annotation.path))
  return lines
}

function command(message: string, file: string | null): string {
  const location = file ? ` file=${escapeCommand(file)}` : ""
  return `::error${location}::${escapeCommand(message)}`
}

function escapeCommand(value: string): string {
  return value.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A")
}

export function writeRecord(decision: Decision, env: NodeJS.ProcessEnv): void {
  for (const line of workflowErrors(decision)) process.stdout.write(`${line}\n`)
  const text = renderRecord(decision)
  process.stdout.write(`${text}\n`)
  const summary = env.GITHUB_STEP_SUMMARY
  if (summary) appendFileSync(summary, text, "utf8")
  const output = env.GITHUB_OUTPUT
  if (output) {
    appendFileSync(output, `allowed=${decision.allowed ? "true" : "false"}\n`, "utf8")
    appendFileSync(output, `record<<MERGE_GATE_RECORD_END\n${JSON.stringify(decision.record)}\nMERGE_GATE_RECORD_END\n`, "utf8")
  }
}
