await fetch('https://example.com/', {
  method: 'HEAD',
  redirect: 'error',
  signal: AbortSignal.timeout(5000)
}).catch(() => {});

export const buildLabel = '  Garnet Exhibit  ';
