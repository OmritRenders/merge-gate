import { evaluate, failClosed } from "./decide.js";
import { GitHubError, loadPullRequest } from "./github.js";
import { writeRecord } from "./record.js";
import { TOOL_VERSION } from "./version.js";
export async function run(env, fetchImpl) {
    try {
        const loaded = await loadPullRequest(env, fetchImpl);
        const decision = evaluate(loaded.snapshot, loaded.policy, TOOL_VERSION, {
            waiverActor: loaded.waiverActor,
            waiverActorType: loaded.waiverActorType,
            authorLogin: loaded.authorLogin,
        });
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
function safeReason(error) {
    if (error instanceof GitHubError || error instanceof Error) {
        return error.message
            .replace(/Bearer\s+\S+/gi, "Bearer [hidden]")
            .replace(/ghp_[A-Za-z0-9]+/g, "[hidden]")
            .replace(/github_pat_[A-Za-z0-9_]+/g, "[hidden]");
    }
    return "Merge gate failed before it could make a decision.";
}
