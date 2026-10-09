import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export interface ConfiguredModel {
	provider: string;
	id: string;
	thinking?: ModelThinkingLevel;
}

export interface Config {
	/** Raw-history token size of one observation chunk (fixed boundary). */
	chunkTokens: number;
	/**
	 * Fraction of the live context window used as one observer chunk (0–1]. Scales observer
	 * cadence with the model so the pipeline depth stays constant; an explicit `chunkTokens`
	 * in settings overrides it, and an unknown window falls back to the absolute default.
	 */
	observerChunkPercent: number;
	/** Overlap between adjacent chunks; default 0 in v1. */
	chunkOverlapTokens: number;
	/** Target size of the active observation pool; the buffer drains back toward this after consolidation. */
	poolTargetTokens: number;
	/** Active-pool token count that triggers a consolidation (200% of target). */
	consolidateAtPoolTokens: number;
	/** Live context-window usage that triggers compaction. */
	compactAtContextTokens: number;
	/**
	 * Fraction of the live context window at which compaction fires (0–1]. An explicit
	 * `compactAtContextTokens` in settings overrides it; an unknown window falls back to the
	 * absolute default.
	 */
	compactAtContextPercent: number;
	/** Verbatim raw tail kept after the cutoff; snaps to a chunk boundary. */
	tailTokens: number;
	/**
	 * Fraction of the context window kept as the verbatim tail (0–1]. An explicit `tailTokens`
	 * in settings overrides it.
	 */
	tailPercent: number;
	/**
	 * Target size of `.memory/JOURNEY.md`, the running descriptive project history the
	 * consolidator appends to and pushes into every compaction block. When the file grows past
	 * this, the consolidator compresses its oldest entries (recent history stays detailed).
	 */
	journeyTargetTokens: number;
	/** Max simultaneous in-flight observer subprocesses. */
	observerConcurrency: number;
	models: {
		observer: ConfiguredModel;
		consolidator: ConfiguredModel;
	};
	/**
	 * Resume the agent automatically after a compaction that fired mid-run (a `turn_end` with
	 * pending tool work). A `turn_end` that is also the run's terminal turn never auto-resumes —
	 * it stops as if nothing happened. Default true.
	 */
	resumeAfterMidRunCompaction: boolean;
	/** Power-user setting: disable all triggers (distinct from the on/off gate). */
	passive: boolean;
	/** Emit the NDJSON debug log. */
	debugLog: boolean;
}

export const DEFAULTS: Config = {
	chunkTokens: 10_000,
	observerChunkPercent: 0.05,
	chunkOverlapTokens: 0,
	poolTargetTokens: 10_000,
	consolidateAtPoolTokens: 15_000,
	compactAtContextTokens: 150_000,
	compactAtContextPercent: 0.6,
	tailTokens: 20_000,
	tailPercent: 0.1,
	journeyTargetTokens: 1_000,
	observerConcurrency: 4,
	resumeAfterMidRunCompaction: true,
	models: {
		observer: { provider: "openrouter", id: "z-ai/glm-5.3", thinking: "low" },
		consolidator: { provider: "openrouter", id: "z-ai/glm-5.3", thinking: "medium" },
	},
	passive: false,
	debugLog: false,
};

const THINKING_LEVEL_VALUES: readonly ModelThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;

const SETTINGS_KEY = "observational-memory";
const PASSIVE_ENV = "PI_OM_PASSIVE";

function positiveIntegerOrUndefined(value: unknown): number | undefined {
	return Number.isInteger(value) && typeof value === "number" && value > 0 ? value : undefined;
}

/** A fraction in (0, 1]; anything else (including 0 and >1) is rejected. */
function fractionOrUndefined(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value > 0 && value <= 1 ? value : undefined;
}

function isThinkingLevel(value: unknown): value is ModelThinkingLevel {
	return typeof value === "string" && (THINKING_LEVEL_VALUES as readonly string[]).includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function nonEmptyString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function normalizeModel(value: unknown, fallback: ConfiguredModel): ConfiguredModel {
	if (!isRecord(value)) return fallback;
	const provider = nonEmptyString(value.provider) ?? fallback.provider;
	const id = nonEmptyString(value.id) ?? fallback.id;
	const model: ConfiguredModel = { provider, id };
	const thinking = isThinkingLevel(value.thinking) ? value.thinking : fallback.thinking;
	if (thinking) model.thinking = thinking;
	return model;
}

function normalizeSettingsConfig(value: Record<string, unknown>, base: Config): Partial<Config> {
	const normalized: Partial<Config> = {};
	const numberKeys = [
		"chunkTokens",
		"chunkOverlapTokens",
		"poolTargetTokens",
		"consolidateAtPoolTokens",
		"compactAtContextTokens",
		"tailTokens",
		"journeyTargetTokens",
		"observerConcurrency",
	] as const;
	for (const key of numberKeys) {
		const normalizedValue = positiveIntegerOrUndefined(value[key]);
		if (normalizedValue !== undefined) normalized[key] = normalizedValue;
	}
	// chunkOverlapTokens may legitimately be 0.
	if (value.chunkOverlapTokens === 0) normalized.chunkOverlapTokens = 0;
	const fractionKeys = ["compactAtContextPercent", "observerChunkPercent", "tailPercent"] as const;
	for (const key of fractionKeys) {
		const normalizedValue = fractionOrUndefined(value[key]);
		if (normalizedValue !== undefined) normalized[key] = normalizedValue;
	}
	if (typeof value.resumeAfterMidRunCompaction === "boolean")
		normalized.resumeAfterMidRunCompaction = value.resumeAfterMidRunCompaction;
	if (typeof value.passive === "boolean") normalized.passive = value.passive;
	if (typeof value.debugLog === "boolean") normalized.debugLog = value.debugLog;
	if (isRecord(value.models)) {
		normalized.models = {
			observer: normalizeModel(value.models.observer, base.models.observer),
			consolidator: normalizeModel(value.models.consolidator, base.models.consolidator),
		};
	}
	return normalized;
}

export function readEnvConfig(env: NodeJS.ProcessEnv = process.env): Partial<Config> {
	const rawPassive = env[PASSIVE_ENV];
	if (rawPassive === undefined) return {};
	const passive = rawPassive.trim().toLowerCase();
	if (["1", "true", "yes", "on"].includes(passive)) return { passive: true };
	if (["0", "false", "no", "off"].includes(passive)) return { passive: false };
	return {};
}

interface NamespacedConfig {
	values: Partial<Config>;
	/** Keys present in the user's settings under this namespace (for explicit-override detection). */
	keys: Set<string>;
}

function readNamespacedConfig(path: string, base: Config): NamespacedConfig {
	if (!existsSync(path)) return { values: {}, keys: new Set() };
	try {
		const raw = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
		const nested = raw[SETTINGS_KEY];
		if (!isRecord(nested)) return { values: {}, keys: new Set() };
		return { values: normalizeSettingsConfig(nested, base), keys: new Set(Object.keys(nested)) };
	} catch {
		return { values: {}, keys: new Set() };
	}
}

export interface LoadedConfig {
	config: Config;
	/** Absolute token knobs the user set explicitly; these beat percentage scaling. */
	explicitKeys: Set<string>;
}

export function loadConfig(cwd: string, env: NodeJS.ProcessEnv = process.env): LoadedConfig {
	const globalPath = join(getAgentDir(), "settings.json");
	const projectPath = join(cwd, ".pi", "settings.json");
	const globalConfig = readNamespacedConfig(globalPath, DEFAULTS);
	const projectConfig = readNamespacedConfig(projectPath, DEFAULTS);
	const envConfig = readEnvConfig(env);
	const config: Config = {
		...DEFAULTS,
		...globalConfig.values,
		...projectConfig.values,
		...envConfig,
		models: {
			...DEFAULTS.models,
			...globalConfig.values.models,
			...projectConfig.values.models,
		},
	};
	const explicitKeys = new Set<string>([...globalConfig.keys, ...projectConfig.keys]);
	return { config, explicitKeys };
}

/** The absolute token knobs that an explicit user setting pins (disables percentage scaling). */
export const TOKEN_BUDGET_KEYS = [
	"chunkTokens",
	"poolTargetTokens",
	"consolidateAtPoolTokens",
	"compactAtContextTokens",
	"tailTokens",
] as const;

/** Effective token budgets for one context window; every threshold the orchestrator compares against. */
export interface ResolvedBudgets {
	chunkTokens: number;
	poolTargetTokens: number;
	consolidateAtPoolTokens: number;
	compactAtContextTokens: number;
	tailTokens: number;
}

/** Keep observer chunks sane on very small windows. */
const MIN_CHUNK_TOKENS = 2_000;

/**
 * Resolve the effective token budgets for a model's context window.
 *
 * Per key, precedence is: (1) an explicit absolute set by the user, (2) the configured
 * percentage of the context window, (3) the 200K-tuned absolute default (used when the window
 * is unknown). The pool budgets follow the (possibly scaled) chunk so the observer → pool →
 * consolidator pipeline keeps its shape: one chunk fills the target pool, 1.5 chunks trigger
 * consolidation (today's 10K / 15K ratio), unless the user pinned them.
 */
export function resolveBudgets(
	config: Config,
	explicitKeys: ReadonlySet<string>,
	contextWindow: number | undefined,
): ResolvedBudgets {
	const win =
		contextWindow !== undefined && Number.isFinite(contextWindow) && contextWindow > 0
			? contextWindow
			: undefined;
	const scale = (key: string, percent: number, fallback: number, min = 1): number => {
		if (explicitKeys.has(key) || win === undefined) return fallback;
		return Math.max(min, Math.round(win * percent));
	};

	const chunkTokens = scale("chunkTokens", config.observerChunkPercent, config.chunkTokens, MIN_CHUNK_TOKENS);
	const poolTargetTokens = explicitKeys.has("poolTargetTokens") ? config.poolTargetTokens : chunkTokens;
	const consolidateAtPoolTokens = explicitKeys.has("consolidateAtPoolTokens")
		? config.consolidateAtPoolTokens
		: Math.max(poolTargetTokens, Math.round(chunkTokens * 1.5));
	const compactAtContextTokens = scale(
		"compactAtContextTokens",
		config.compactAtContextPercent,
		config.compactAtContextTokens,
	);
	const tailTokens = scale("tailTokens", config.tailPercent, config.tailTokens);

	return { chunkTokens, poolTargetTokens, consolidateAtPoolTokens, compactAtContextTokens, tailTokens };
}
