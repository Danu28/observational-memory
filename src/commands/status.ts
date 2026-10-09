import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { foldLedger, poolTokens, rawTokensSinceObservationCoverage, sumSessionCost, type Entry } from "../ledger/index.js";
import { listTopics, readJourney } from "../memory/paths.js";
import { estimateStringTokens } from "../tokens.js";
import type { Runtime } from "../runtime.js";
import { renderTimeline } from "../ui/timeline.js";

export function registerStatusCommand(pi: ExtensionAPI, runtime: Runtime): void {
	pi.registerCommand("om:status", {
		description: "Show observational-memory status (workers, buffer, clocks)",
		handler: async (_args: string, ctx: any) => {
			if (!ctx.hasUI) return;
			if (!runtime.enabled) {
				ctx.ui.notify("om is off (use /om on to enable)", "info");
				return;
			}
			runtime.ensureConfig(ctx.cwd);
			const usage = ctx.getContextUsage?.();
			const budgets = runtime.refreshBudgets(usage?.contextWindow);
			const branch = ctx.sessionManager.getBranch() as Entry[];
			const folded = foldLedger(branch);
			const sinceObservation = rawTokensSinceObservationCoverage(branch);
			const contextTokens = usage?.tokens ?? null;
			const contextPercent =
				usage?.percent ?? (contextTokens != null && usage?.contextWindow ? (contextTokens / usage.contextWindow) * 100 : null);
			const pool = poolTokens(folded.activeObservations);
			const topicCount = listTopics(runtime.memoryRoot).length;
			const journey = readJourney(runtime.memoryRoot);
			const { costUsd, runs } = sumSessionCost(ctx.sessionManager.getEntries() as Entry[]);

			const lines = [
				`om status`,
				`  observers in flight: ${runtime.observersInFlight.size} / ${runtime.config.observerConcurrency}`,
				`  active observations: ${folded.activeObservations.length}`,
				`  next observer: ${sinceObservation.toLocaleString()} / ${budgets.chunkTokens.toLocaleString()} tok`,
				`  pool: ${pool.toLocaleString()} tok (target ${budgets.poolTargetTokens.toLocaleString()}, consolidate at ${budgets.consolidateAtPoolTokens.toLocaleString()})`,
				`  consolidator: ${runtime.consolidatorInFlight ? "running" : "idle"}`,
				`  last compaction wait: ${runtime.lastCompactionObserverWait ?? "n/a"}`,
				`  topic files: ${topicCount}`,
				`  journey: ${journey ? `~${estimateStringTokens(journey).toLocaleString()} / ${runtime.config.journeyTargetTokens.toLocaleString()} tok` : "none yet"}`,
				`  context: ${contextTokens != null ? contextTokens.toLocaleString() : "?"} / ${budgets.compactAtContextTokens.toLocaleString()} tok` +
					(usage?.contextWindow
						? ` (${contextPercent != null ? `${contextPercent.toFixed(1)}%` : "?"} of ${usage.contextWindow.toLocaleString()})`
						: ""),
				`  session cost: $${costUsd.toFixed(4)} (${runs} run${runs === 1 ? "" : "s"})`,
				runtime.lastWorkerError ? `  last error: ${runtime.lastWorkerError}` : `  last error: none`,
				"",
				renderTimeline(branch, { ...runtime.config, chunkTokens: budgets.chunkTokens }),
			];
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}
