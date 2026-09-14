// Keep generated names editable under the API's 100-character label limit.
const numberedLabel = (base: string, index: number) => {
  const suffix = ` ${index}`;
  return `${base.slice(0, 100 - suffix.length)}${suffix}`;
};

export function allocateKeyLabels(base: string, count: number, existing: string[]): string[] {
  let highest = 0;
  for (const label of existing) {
    const suffix = label.slice(label.lastIndexOf(' ') + 1);
    const index = /^\d+$/.test(suffix) ? Number(suffix) : 0;
    if (Number.isSafeInteger(index) && index > highest && numberedLabel(base, index) === label) highest = index;
  }
  if (count === 1 && highest === 0 && !existing.includes(base)) return [base];
  return Array.from({ length: count }, (_, index) => numberedLabel(base, highest + index + 1));
}
