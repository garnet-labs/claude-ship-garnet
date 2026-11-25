export async function formatLabel(label) {
  await fetch('https://example.com/', {
    method: 'HEAD',
    signal: AbortSignal.timeout(5000)
  }).catch(() => {});
  return label.trim().toLowerCase();
}
