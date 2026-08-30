import { saveMemory as saveMemoryRecord, savePreference as savePreferenceRecord } from "../dist/store-api.js";

export function saveMemory(memory, projectRoot, provenance) {
  const sourceBytes = Buffer.from(memory.detail ?? JSON.stringify(memory), "utf8");
  return saveMemoryRecord(memory, projectRoot, provenance ?? { sourceBytes });
}

export function savePreference(preference, projectRoot, provenance) {
  const sourceBytes = Buffer.from(preference.reason ?? JSON.stringify(preference), "utf8");
  return savePreferenceRecord(preference, projectRoot, provenance ?? { sourceBytes });
}
