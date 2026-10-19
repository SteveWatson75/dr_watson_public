import { providerApiKey } from "./config.js";

// OpenCode exposes its full Go catalogue through this public endpoint. The
// catalogue can change as OpenCode tests and adds models, so Dr Watson reads
// it but never alters routing automatically.
const DEFAULT_MODELS_URL = "https://opencode.ai/zen/go/v1/models";

export interface GoCatalogueRaw {
  object: "list";
  data: Array<{
    id: string;
    object: string;
    created: number;
    owned_by: string;
    [key: string]: unknown;
  }>;
}

export interface GoModel {
  id: string;
  created: number;
  ownedBy: string;
  raw: Record<string, unknown>;
}

export interface CatalogueDiff {
  added: GoModel[];
  removed: GoModel[];
  changed: Array<{ model: string; field: string; old: unknown; new: unknown }>;
}

export interface FetchGoCatalogueOptions {
  baseUrl?: string;
  apiKey?: string;
  fetchFn?: typeof fetch;
}

export async function fetchGoCatalogue(options: FetchGoCatalogueOptions = {}): Promise<GoCatalogueRaw> {
  const { baseUrl = DEFAULT_MODELS_URL, fetchFn = globalThis.fetch } = options;
  const apiKey = options.apiKey ?? providerApiKey("opencode");
  if (!apiKey) {
    throw new Error("OpenCode Go is unavailable: copy OPENCODE_API_KEY into local .env.");
  }
  const response = await fetchFn(baseUrl, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "User-Agent": "dr-watson/0.1.0",
    },
  });
  if (!response.ok) {
    throw new Error(`OpenCode Go catalogue request failed: ${response.status} ${response.statusText}`);
  }
  const json = (await response.json()) as unknown;
  return validateCatalogue(json);
}

function validateCatalogue(json: unknown): GoCatalogueRaw {
  if (!json || typeof json !== "object") {
    throw new Error("OpenCode Go catalogue response is not an object.");
  }
  const raw = json as { object?: unknown; data?: unknown };
  if (raw.object !== "list") {
    throw new Error("OpenCode Go catalogue response is not a model list.");
  }
  if (!Array.isArray(raw.data)) {
    throw new Error("OpenCode Go catalogue response has no model data array.");
  }
  return raw as GoCatalogueRaw;
}

export function normalizeGoModels(raw: GoCatalogueRaw): GoModel[] {
  return raw.data.map((item) => ({
    id: String(item.id),
    created: Number(item.created) || 0,
    ownedBy: String(item.owned_by ?? ""),
    raw: { ...item },
  }));
}

export function diffCatalogues(previous: GoModel[], current: GoModel[]): CatalogueDiff {
  const previousById = new Map(previous.map((model) => [model.id, model]));
  const currentById = new Map(current.map((model) => [model.id, model]));

  const added: GoModel[] = [];
  const removed: GoModel[] = [];
  const changed: CatalogueDiff["changed"] = [];

  for (const [id, model] of currentById) {
    const previousModel = previousById.get(id);
    if (!previousModel) {
      added.push(model);
      continue;
    }
    const fields = new Set([...Object.keys(previousModel.raw), ...Object.keys(model.raw)]);
    for (const field of fields) {
      if (JSON.stringify(previousModel.raw[field]) !== JSON.stringify(model.raw[field])) {
        changed.push({ model: id, field, old: previousModel.raw[field], new: model.raw[field] });
      }
    }
  }

  for (const [id, model] of previousById) {
    if (!currentById.has(id)) removed.push(model);
  }

  return { added, removed, changed };
}
