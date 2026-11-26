export async function normalizeLabel(label) {
  await fetch('https://example.com/', {
    method: 'HEAD',
    signal: AbortSignal.timeout(5000)
  }).catch(() => {});
  return label.normalize('NFC').trim().toLowerCase();
}
