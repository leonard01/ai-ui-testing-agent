import { availableParallelism, totalmem, freemem } from "node:os";
const GiB = 1024 ** 3;

// Thresholds are conservative initial heuristics, not minimum system requirements.
export function resolveProfile({ cores, totalBytes, freeBytes, ci = false, override = "" }) {
  const profiles = { "low-spec": [1,30], standard: [2,15], performance: [4,15], ci: [2,15] };
  let profile, reason;
  if (override) {
    if (!Object.hasOwn(profiles, override)) throw new Error("Invalid TEST_PROFILE: " + override);
    profile = override; reason = "Explicit profile override";
  } else if (ci) {
    profile = "ci"; reason = "Fixed CI concurrency";
  } else if (cores < 4 || totalBytes < 8*GiB || freeBytes < 4*GiB) {
    profile = "low-spec"; reason = "Conservative CPU or memory threshold";
  } else if (cores >= 8 && totalBytes >= 16*GiB && freeBytes >= 8*GiB) {
    profile = "performance"; reason = "Higher CPU and memory availability";
  } else {
    profile = "standard"; reason = "Moderate CPU and memory availability";
  }
  const [workers, minutes] = profiles[profile];
  return { profile, reason, workers, globalTimeout: minutes*60*1000 };
}
export function detectProfile(env = process.env) {
  const hardware = { cores: availableParallelism(), totalBytes: totalmem(), freeBytes: freemem(),
    ci: Boolean(env.CI && env.CI !== "false" && env.CI !== "0"), override: env.TEST_PROFILE || "" };
  return { ...hardware, ...resolveProfile(hardware) };
}
