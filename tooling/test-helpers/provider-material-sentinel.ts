export interface ProviderMaterialNeedle {
  readonly label: string;
  readonly value: string | RegExp;
}

export interface ProviderMaterialLeak {
  readonly label: string;
  readonly matched: string;
}

export const serializeLedgerVisible = (value: unknown): string => JSON.stringify(value);

export const providerMaterialLeaks = (
  ledgerVisible: unknown,
  needles: ReadonlyArray<ProviderMaterialNeedle>,
): ReadonlyArray<ProviderMaterialLeak> => {
  const serialized = serializeLedgerVisible(ledgerVisible);
  const leaks: ProviderMaterialLeak[] = [];
  for (const needle of needles) {
    if (typeof needle.value === "string") {
      if (serialized.includes(needle.value)) {
        leaks.push({ label: needle.label, matched: needle.value });
      }
      continue;
    }
    const match = serialized.match(needle.value);
    if (match !== null) {
      leaks.push({ label: needle.label, matched: match[0] });
    }
  }
  return leaks;
};

export const workspaceSessionProviderMaterialNeedles = (
  extra: ReadonlyArray<ProviderMaterialNeedle> = [],
): ReadonlyArray<ProviderMaterialNeedle> => [
  { label: "workspace session preview URL", value: /https:\/\/[^"\\]*preview[^"\\]*/ },
  { label: "workspace session preview hostname", value: /preview\.[a-z0-9.-]+/i },
  { label: "workspace session preview token", value: /preview-token[a-z0-9._-]*/i },
  { label: "sandbox secret", value: /sandbox-client-secret[a-z0-9._-]*/i },
  ...extra,
];
