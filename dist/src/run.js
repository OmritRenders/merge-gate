import { readFileSync } from "node:fs";
import { evaluate, failClosed } from "./decide.js";
import { GitHubError, loadPullRequest } from "./github.js";
import { parsePolicy } from "./policy.js";
import { writeRecord } from "./record.js";
import { TOOL_VERSION } from "./version.js";
export async function run(env, fetchImpl) {
    try {
        const decision = env.MERGE_GATE_FIXTURE ? evaluateFixture(env) : await evaluatePullRequest(env, fetchImpl);
        writeRecord(decision, env);
        return decision.allowed ? 0 : 1;
    }
    catch (error) {
        const decision = failClosed(TOOL_VERSION, safeReason(error));
        try {
            writeRecord(decision, env);
        }
        catch (writeError) {
            process.stderr.write(`${safeReason(writeError)}\n`);
        }
        return 1;
    }
}
async function evaluatePullRequest(env, fetchImpl) {
    const loaded = await loadPullRequest(env, fetchImpl);
    return evaluate(loaded.snapshot, loaded.policy, TOOL_VERSION, {
        waiverActor: loaded.waiverActor,
        waiverActorType: loaded.waiverActorType,
        authorLogin: loaded.authorLogin,
    });
}
function evaluateFixture(env) {
    const fixturePath = env.MERGE_GATE_FIXTURE;
    const policyPath = env.MERGE_GATE_POLICY;
    if (!fixturePath || !policyPath) {
        throw new Error("MERGE_GATE_FIXTURE and MERGE_GATE_POLICY are required.");
    }
    const snapshot = JSON.parse(readFileSync(fixturePath, "utf8"));
    const policy = parsePolicy(readFileSync(policyPath, "utf8"));
    return evaluate(snapshot, policy, TOOL_VERSION, {
        waiverActor: snapshot.waiverActor ?? null,
        waiverActorType: snapshot.waiverActorType ?? null,
        authorLogin: snapshot.authorLogin ?? null,
    });
}
export function safeReason(error) {
    if (error instanceof GitHubError || error instanceof Error) {
        return error.message
            .replace(/Bearer\s+\S+/gi, "Bearer [hidden]")
            .replace(/ghp_[A-Za-z0-9]+/g, "[hidden]")
            .replace(/github_pat_[A-Za-z0-9_]+/g, "[hidden]");
    }
    return "Merge gate failed before it could make a decision.";
}
