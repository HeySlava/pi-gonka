import type { ExtensionAPI, ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, TextContent, ThinkingContent } from "@earendil-works/pi-ai";
import { AuthStorage, getAgentDir } from "@earendil-works/pi-coding-agent";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const PROVIDER_NAME = "gonka";
const BASE_URL = "https://api.proxy.gonka.gg/v1";
const MODELS_URL = "https://api.proxy.gonka.gg/v1/models";
const PRICING_URL = "https://api.proxy.gonka.gg/api/pricing";
const CAPABILITIES_URL = "https://api.proxy.gonka.gg/api/models/capabilities";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

function getDisplayName(modelId: string): string {
	return modelId.split("/").pop() ?? modelId;
}

function isAssistantMessage(msg: { role: string }): msg is AssistantMessage {
	return msg.role === "assistant";
}

function parseThinkBlocks(text: string): (TextContent | ThinkingContent)[] {
	const blocks: (TextContent | ThinkingContent)[] = [];
	const regex = /<think>([\s\S]*?)<\/think>/g;
	let lastIndex = 0;
	let match: RegExpExecArray | null;

	while ((match = regex.exec(text)) !== null) {
		if (match.index > lastIndex) {
			blocks.push({ type: "text", text: text.slice(lastIndex, match.index) });
		}
		blocks.push({ type: "thinking", thinking: match[1] });
		lastIndex = regex.lastIndex;
	}

	if (lastIndex < text.length) {
		blocks.push({ type: "text", text: text.slice(lastIndex) });
	}

	return blocks;
}

function transformThinkTags(message: AssistantMessage): AssistantMessage {
	const newContent: AssistantMessage["content"] = [];
	for (const block of message.content) {
		if (block.type === "text") {
			newContent.push(...parseThinkBlocks(block.text));
		} else {
			newContent.push(block);
		}
	}
	return { ...message, content: newContent };
}

interface GonkaModel {
	id: string;
	object?: string;
	created?: number;
	owned_by?: string;
	context_length?: number;
	max_tokens?: number;
}

interface GonkaPricingModel {
	model_id: string;
	usd_per_million_tokens: number;
	usd_per_token: number;
}

interface GonkaPricing {
	currency: string;
	models: GonkaPricingModel[];
	pricing_updated_at?: string;
	fx_updated_at?: string;
}

interface GonkaCapability {
	id: string;
	context_length?: number;
	max_model_len?: number;
	max_output_tokens?: number;
	supports_tools?: boolean;
	supports_reasoning?: boolean;
	hf_repo?: string;
}

interface GonkaCapabilities {
	models: GonkaCapability[];
	updated_at?: string;
}

interface CacheEntry {
	modelsUpdatedAt: string | null;
	pricingUpdatedAt: string | null;
	capabilitiesUpdatedAt: string | null;
	models: ProviderModelConfig[];
	pricing: GonkaPricing | null;
	capabilities: GonkaCapabilities | null;
}

interface FetchOptions {
	signal?: AbortSignal;
	headers?: Record<string, string>;
}

function getCachePath(): string {
	const agentDir = getAgentDir();
	return join(agentDir, "gonka-cache.json");
}

function ensureCacheDir(): void {
	const dir = dirname(getCachePath());
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}
}

function loadCache(): CacheEntry | null {
	const cachePath = getCachePath();
	if (!existsSync(cachePath)) return null;
	try {
		return JSON.parse(readFileSync(cachePath, "utf-8")) as CacheEntry;
	} catch {
		return null;
	}
}

function saveCache(cache: CacheEntry): void {
	ensureCacheDir();
	writeFileSync(getCachePath(), JSON.stringify(cache, null, 2), { mode: 0o600 });
}

function isStale(updatedAt: string | null | undefined): boolean {
	if (!updatedAt) return true;
	const updated = new Date(updatedAt).getTime();
	if (Number.isNaN(updated)) return true;
	return Date.now() - updated > CACHE_TTL_MS;
}

async function fetchJson<T>(url: string, options: FetchOptions = {}): Promise<T> {
	const response = await fetch(url, {
		signal: options.signal,
		headers: {
			Accept: "application/json",
			...options.headers,
		},
	});
	if (!response.ok) {
		throw new Error("Failed to fetch " + url + ": " + response.status + " " + await response.text());
	}
	return await response.json() as T;
}

// Get all available models from capabilities, merging with /v1/models data
function getAllModelsFromCapabilities(models: GonkaModel[], capabilities: GonkaCapabilities | null): GonkaModel[] {
	const modelIds = new Set(models.map((m) => m.id));
	const additionalModels: GonkaModel[] = [];

	for (const cap of capabilities?.models ?? []) {
		if (!modelIds.has(cap.id) && cap.id) {
			additionalModels.push({
				id: cap.id,
				context_length: cap.context_length ?? cap.max_model_len,
				max_tokens: cap.max_output_tokens,
			});
		}
	}

	return [...models, ...additionalModels];
}

function mergeModelData(models: GonkaModel[], pricing: GonkaPricing | null, capabilities: GonkaCapabilities | null): ProviderModelConfig[] {
	const pricingMap = new Map<string, number>();
	for (const p of pricing?.models ?? []) {
		pricingMap.set(p.model_id, p.usd_per_million_tokens);
	}

	const capabilityMap = new Map<string, GonkaCapability>();
	for (const c of capabilities?.models ?? []) {
		capabilityMap.set(c.id, c);
	}

	return models.map((model): ProviderModelConfig => {
		const cap = capabilityMap.get(model.id);
		const costPerMillion = pricingMap.get(model.id) ?? 0;
		return {
			id: model.id,
			name: getDisplayName(model.id),
			reasoning: cap?.supports_reasoning ?? false,
			input: ["text"],
			cost: {
				input: costPerMillion,
				output: costPerMillion,
				cacheRead: 0,
				cacheWrite: 0,
			},
			contextWindow: cap?.context_length ?? model.context_length ?? cap?.max_model_len ?? 128000,
			maxTokens: cap?.max_output_tokens ?? model.max_tokens ?? 4096,
		};
	});
}

async function fetchAllData(apiKey: string | undefined, signal?: AbortSignal) {
	const headers: Record<string, string> = {};
	if (apiKey) {
		headers["Authorization"] = "Bearer " + apiKey;
	}

	const [modelsResponse, pricing, capabilities] = await Promise.all([
		fetchJson<{ data: GonkaModel[] }>(MODELS_URL, { signal, headers }),
		fetchJson<GonkaPricing>(PRICING_URL, { signal, headers }),
		fetchJson<GonkaCapabilities>(CAPABILITIES_URL, { signal, headers }),
	]);

	return {
		models: mergeModelData(
			getAllModelsFromCapabilities(modelsResponse.data ?? [], capabilities),
			pricing,
			capabilities,
		),
		pricing,
		capabilities,
	};
}

async function refreshData(cache: CacheEntry | null, apiKey: string | undefined, signal?: AbortSignal, force = false): Promise<CacheEntry> {
	const modelsStale = force || isStale(cache?.modelsUpdatedAt);
	const pricingStale = force || isStale(cache?.pricingUpdatedAt);
	const capabilitiesStale = force || isStale(cache?.capabilitiesUpdatedAt);

	let models = cache?.models ?? [];
	let pricing = cache?.pricing ?? null;
	let capabilities = cache?.capabilities ?? null;
	let modelsUpdatedAt = cache?.modelsUpdatedAt ?? null;
	let pricingUpdatedAt = cache?.pricingUpdatedAt ?? null;
	let capabilitiesUpdatedAt = cache?.capabilitiesUpdatedAt ?? null;

	try {
		if (modelsStale || pricingStale || capabilitiesStale) {
			const fresh = await fetchAllData(apiKey, signal);
			models = fresh.models;
			pricing = fresh.pricing;
			capabilities = fresh.capabilities;
			modelsUpdatedAt = new Date().toISOString();
			pricingUpdatedAt = new Date().toISOString();
			capabilitiesUpdatedAt = new Date().toISOString();
		}
	} catch (error) {
		console.warn("[" + PROVIDER_NAME + "] Failed to refresh data:", error);
	}

	const result: CacheEntry = { modelsUpdatedAt, pricingUpdatedAt, capabilitiesUpdatedAt, models, pricing, capabilities };
	saveCache(result);
	return result;
}

function registerGonkaProvider(pi: ExtensionAPI, apiKey: string | undefined, models: ProviderModelConfig[]) {
	pi.registerProvider(PROVIDER_NAME, {
		name: "Gonka",
		baseUrl: BASE_URL,
		apiKey,
		api: "openai-completions",
		models,
	});
}

export default async function (pi: ExtensionAPI) {
	const authStorage = AuthStorage.create();
	let apiKey: string | undefined;

	try {
		apiKey = await authStorage.getApiKey(PROVIDER_NAME);
	} catch {
		apiKey = undefined;
	}

	if (!apiKey) {
		console.warn("[" + PROVIDER_NAME + "] No API key found. Add to ~/.pi/agent/auth.json:", JSON.stringify({ [PROVIDER_NAME]: { type: "api_key", key: "sk-..." } }));
	}

	const cache = loadCache();
	const freshCache = await refreshData(cache, apiKey);

	if (freshCache.models.length === 0) {
		console.warn("[" + PROVIDER_NAME + "] No models available. Check API key and network connection.");
		return;
	}

	registerGonkaProvider(pi, apiKey, freshCache.models);

	pi.registerCommand("gonka-refresh", {
		description: "Refresh Gonka models and pricing",
		handler: async (_args, ctx) => {
			const currentKey = await authStorage.getApiKey(PROVIDER_NAME).catch(() => undefined);
			apiKey = currentKey;
			const newCache = await refreshData(null, apiKey, ctx.signal, true);

			pi.unregisterProvider(PROVIDER_NAME);
			registerGonkaProvider(pi, apiKey, newCache.models);

			ctx.ui.notify("Refreshed " + newCache.models.length + " Gonka models", "info");
		},
	});

	pi.on("message_end", (event) => {
		const message = event.message;
		if (!isAssistantMessage(message) || message.provider !== PROVIDER_NAME) {
			return { message };
		}
		return { message: transformThinkTags(message) };
	});
}
