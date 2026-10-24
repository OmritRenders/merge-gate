import { run } from "./run.js";
const code = await run(process.env, fetch);
process.exit(code);
