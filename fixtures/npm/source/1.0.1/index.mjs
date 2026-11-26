export function normalizeLabel(label) {
  return label.normalize('NFC').trim().toLowerCase();
}
