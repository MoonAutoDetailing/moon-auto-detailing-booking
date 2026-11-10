// Master switch for automated maintenance-cycle processing: cycle generation, missed-cycle
// marking, and cycle reminder/open/missed emails. Paused while the subscription system is
// being repaired so members stop receiving incorrect emails and penalties.
// To re-enable: set CYCLE_AUTOMATION_DEFAULT to true, or set the Vercel env var
// SUBSCRIPTION_CYCLE_AUTOMATION=true (env var wins when present).
const CYCLE_AUTOMATION_DEFAULT = false;

export function isCycleAutomationEnabled() {
  const env = process.env.SUBSCRIPTION_CYCLE_AUTOMATION;
  if (env === "true") return true;
  if (env === "false") return false;
  return CYCLE_AUTOMATION_DEFAULT;
}
