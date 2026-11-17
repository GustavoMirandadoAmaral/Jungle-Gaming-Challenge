export async function waitForApps(urls: string[], timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = 'health endpoint did not report ready';

  while (Date.now() < deadline) {
    const states = await Promise.all(urls.map(async (baseUrl) => {
      try {
        const response = await fetch(`${baseUrl}/health/ready`);
        if (!response.ok) return `${baseUrl}: HTTP ${response.status}`;
        const body = await response.json() as { status?: string };
        return body.status === 'ready' ? undefined : `${baseUrl}: ${body.status ?? 'unknown status'}`;
      } catch (error) {
        return `${baseUrl}: ${error instanceof Error ? error.message : String(error)}`;
      }
    }));

    const notReady = states.filter((state): state is string => state !== undefined);
    if (notReady.length === 0) return;
    lastError = notReady.join('; ');
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error(`Application instances did not become ready in ${timeoutMs}ms: ${lastError}`);
}
