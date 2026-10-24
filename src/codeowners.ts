export class CodeownersError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "CodeownersError"
  }
}

type Rule = {
  pattern: string
  owners: string[]
}

export function ownersFor(filePath: string, codeownersText: string): string[] {
  let matched: string[] | null = null
  for (const rule of parseCodeowners(codeownersText)) {
    if (patternMatches(rule.pattern, filePath)) matched = rule.owners
  }
  return matched ?? []
}

export function parseCodeowners(text: string): Rule[] {
  const rules: Rule[] = []
  const lines = text.split(/\r?\n/)
  for (let index = 0; index < lines.length; index++) {
    const line = (lines[index] ?? "").trim()
    if (line === "" || line.startsWith("#")) continue
    if (/^\^?\[/.test(line)) continue
    const tokens = tokenize(line)
    const pattern = tokens[0]
    const owners = tokens.slice(1)
    if (!pattern || owners.length === 0) {
      throw new CodeownersError(`CODEOWNERS line ${index + 1} needs a pattern and at least one owner.`)
    }
    for (const owner of owners) {
      const isUser = owner.startsWith("@") && owner.length > 1
      const isEmail = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(owner)
      if (!isUser && !isEmail) {
        throw new CodeownersError(`CODEOWNERS line ${index + 1} has an owner "${owner}" that is not a user, team, or email.`)
      }
    }
    rules.push({ pattern, owners })
  }
  return rules
}

function tokenize(line: string): string[] {
  const tokens: string[] = []
  let current = ""
  for (let index = 0; index < line.length; index++) {
    const character = line[index]
    if (character === "\\" && line[index + 1] === " ") {
      current += " "
      index++
      continue
    }
    if (character === " " || character === "\t") {
      if (current) tokens.push(current)
      current = ""
      continue
    }
    if (character === "#" && current === "") break
    current += character
  }
  if (current) tokens.push(current)
  return tokens
}

function patternMatches(pattern: string, filePath: string): boolean {
  let source = pattern.trim()
  let anchored = false
  if (source.startsWith("/")) {
    anchored = true
    source = source.slice(1)
  }
  let directory = false
  if (source.endsWith("/")) {
    directory = true
    source = source.slice(0, -1)
  }
  if (!anchored && !source.includes("/")) source = `**/${source}`
  const expression = `^${compile(source)}${directory ? "(?:/.*)?" : ""}$`
  return new RegExp(expression).test(filePath)
}

function compile(pattern: string): string {
  let expression = ""
  for (let index = 0; index < pattern.length; index++) {
    if (pattern.startsWith("**/", index)) {
      expression += "(?:.*/)?"
      index += 2
      continue
    }
    if (pattern.startsWith("**", index)) {
      expression += ".*"
      index += 1
      continue
    }
    const character = pattern[index] ?? ""
    if (character === "*") expression += "[^/]*"
    else if (character === "?") expression += "[^/]"
    else if ("\\^$+.()|{}[]".includes(character)) expression += `\\${character}`
    else expression += character
  }
  return expression
}
