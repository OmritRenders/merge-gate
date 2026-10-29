import { spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { join, relative } from "node:path"

const DIST = "dist"

if (!existsSync(DIST)) {
  fail([`There is no ${DIST}/ folder to compare.`, "Run npm run build and commit the result."])
}

const outDir = mkdtempSync(join(tmpdir(), "merge-gate-dist-"))
try {
  compile(outDir)

  const expected = fileMap(outDir)
  const committed = fileMap(DIST)
  const problems = []

  for (const [path, content] of expected) {
    const shipped = committed.get(path)
    if (shipped === undefined) {
      problems.push(`missing from ${DIST}/: ${path}`)
    } else if (!shipped.equals(content)) {
      problems.push(`out of date: ${DIST}/${path}`)
    }
  }
  for (const path of committed.keys()) {
    if (!expected.has(path)) problems.push(`no longer built from src/: ${DIST}/${path}`)
  }

  if (problems.length > 0) {
    fail([
      `${DIST}/ does not match src/.`,
      ...problems.map((problem) => `  ${problem}`),
      "Run npm run build and commit the result.",
    ])
  }
  process.stdout.write(`${DIST}/ matches src/.\n`)
} finally {
  rmSync(outDir, { recursive: true, force: true })
}

function compile(outDir) {
  const tsc = createRequire(import.meta.url).resolve("typescript/bin/tsc")
  const built = spawnSync(process.execPath, [tsc, "--outDir", outDir], { stdio: "inherit" })
  if (built.status !== 0) {
    fail(["The compiler failed, so the committed build could not be compared."])
  }
}

function fileMap(dir) {
  const files = new Map()
  for (const path of walk(dir, "")) {
    files.set(path, readFileSync(join(dir, path)))
  }
  return files
}

function walk(dir, prefix) {
  const paths = []
  const entries = readdirSync(join(dir, prefix), { withFileTypes: true })
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const path = prefix === "" ? entry.name : `${prefix}/${entry.name}`
    if (entry.isDirectory()) {
      paths.push(...walk(dir, path))
    } else if (entry.isFile()) {
      paths.push(relative(dir, join(dir, path)).split("\\").join("/"))
    }
  }
  return paths
}

function fail(lines) {
  process.stderr.write(`${lines.join("\n")}\n`)
  process.exit(1)
}
