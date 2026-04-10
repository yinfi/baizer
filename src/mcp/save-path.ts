export function resolveSavedNotePath(
  filename: string,
  preferredFolder: string | undefined,
  exists: (path: string) => boolean
): string {
  const normalizedFilename = filename.replace(/\\/g, '/');
  const normalizedFolder = (preferredFolder || '').trim().replace(/[\\/]+$/g, '');
  const hasExplicitFolder = normalizedFilename.includes('/');

  const basePath = normalizedFolder && !hasExplicitFolder
    ? `${normalizedFolder}/${normalizedFilename}`
    : normalizedFilename;

  let finalPath = basePath;
  let counter = 1;

  while (exists(finalPath)) {
    finalPath = basePath.replace(/\.md$/, ` (${counter}).md`);
    counter++;
  }

  return finalPath;
}
