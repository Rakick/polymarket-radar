import { adminClient } from "./supabase";
import { DEFAULT_SETTINGS, Settings } from "./types";

export async function getSettings(): Promise<Settings> {
  const { data, error } = await adminClient()
    .from("app_settings")
    .select("data")
    .eq("id", 1)
    .single();

  if (error || !data) return { ...DEFAULT_SETTINGS };

  const stored = data.data as Partial<Settings>;
  return {
    ...DEFAULT_SETTINGS,
    ...stored,
    weights: { ...DEFAULT_SETTINGS.weights, ...(stored.weights ?? {}) },
  };
}

/**
 * Update the application-facing settings without deleting operational scanner
 * keys stored alongside them (batch size, catalogue caps, quality filters, V2 cap).
 */
export async function saveSettings(settings: Settings): Promise<void> {
  const db = adminClient();
  const { data: current, error: readError } = await db
    .from("app_settings")
    .select("data")
    .eq("id", 1)
    .single();

  if (readError) throw new Error(`Lecture des paramètres impossible : ${readError.message}`);

  const operationalKeys = [
    "max_markets_per_category",
    "max_markets_total",
    "scan_batch_size",
    "min_market_volume",
    "min_market_liquidity",
    "v2_max_price",
  ];

  const existing = (current?.data ?? {}) as Record<string, unknown>;
  const operational = Object.fromEntries(
    operationalKeys
      .filter((key) => Object.prototype.hasOwnProperty.call(existing, key))
      .map((key) => [key, existing[key]]),
  );

  const { error } = await db.from("app_settings").upsert({
    id: 1,
    data: { ...settings, ...operational },
    updated_at: new Date().toISOString(),
  });

  if (error) throw new Error(`Sauvegarde des paramètres impossible : ${error.message}`);
}
