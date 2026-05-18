export function minimumLoadingDelay(durationMs = 450): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, durationMs);
  });
}
