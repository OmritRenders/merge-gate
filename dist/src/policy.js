import { DEFAULT_THRESHOLD, DEFAULT_WAIVER_LABEL, RULE_VERSION } from "./version.js";
export class PolicyError extends Error {
    constructor(message) {
        super(message);
        this.name = "PolicyError";
    }
}
const KNOWN_KEYS = new Set(["ruleVersion", "threshold", "waiverLabel", "testCheck"]);
export function parsePolicy(text) {
    const values = new Map();
    const lines = text.split(/\r?\n/);
    for (let index = 0; index < lines.length; index++) {
        const raw = lines[index] ?? "";
        const line = raw.trim();
        if (line === "" || line.startsWith("#"))
            continue;
        const separator = line.indexOf(":");
        if (separator === -1) {
            throw new PolicyError(`Policy line ${index + 1} must be a key and a value.`);
        }
        const key = line.slice(0, separator).trim();
        const value = line.slice(separator + 1).trim();
        if (!KNOWN_KEYS.has(key)) {
            throw new PolicyError(`Policy key "${key}" is not recognized.`);
        }
        if (value === "" || value.startsWith("#")) {
            throw new PolicyError(`Policy key "${key}" needs a value.`);
        }
        if (values.has(key)) {
            throw new PolicyError(`Policy key "${key}" is set more than once.`);
        }
        values.set(key, stripQuotes(value));
    }
    const testCheck = values.get("testCheck");
    if (!testCheck) {
        throw new PolicyError('Policy key "testCheck" is required.');
    }
    const ruleVersion = readRuleVersion(values.get("ruleVersion"));
    const thresholdText = values.get("threshold");
    const threshold = thresholdText === undefined ? DEFAULT_THRESHOLD : readThreshold(thresholdText);
    const waiverLabel = values.get("waiverLabel") ?? DEFAULT_WAIVER_LABEL;
    if (waiverLabel.includes(" ")) {
        throw new PolicyError('Policy key "waiverLabel" must be one GitHub label name.');
    }
    return { ruleVersion, threshold, waiverLabel, testCheck };
}
function readRuleVersion(value) {
    if (value === undefined)
        return RULE_VERSION;
    if (value !== String(RULE_VERSION)) {
        throw new PolicyError(`Policy ruleVersion ${value} is not supported.`);
    }
    return RULE_VERSION;
}
function readThreshold(value) {
    if (!/^[0-9]+$/.test(value)) {
        throw new PolicyError('Policy key "threshold" must be a whole number of lines.');
    }
    const threshold = Number(value);
    if (!Number.isSafeInteger(threshold) || threshold < 1) {
        throw new PolicyError('Policy key "threshold" must be 1 or greater.');
    }
    return threshold;
}
function stripQuotes(value) {
    const comment = value.search(/\s+#/);
    let cleaned = (comment === -1 ? value : value.slice(0, comment)).trim();
    if ((cleaned.startsWith('"') && cleaned.endsWith('"') && cleaned.length >= 2) ||
        (cleaned.startsWith("'") && cleaned.endsWith("'") && cleaned.length >= 2)) {
        cleaned = cleaned.slice(1, -1).trim();
    }
    return cleaned;
}
