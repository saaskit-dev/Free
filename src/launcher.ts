export function resolveCurrentFreeExecutablePath(
  argv: readonly string[] = process.argv,
): string {
  const entrypoint = argv[1];
  if (entrypoint && !entrypoint.startsWith("/$bunfs/")) {
    return entrypoint;
  }
  return process.execPath;
}

