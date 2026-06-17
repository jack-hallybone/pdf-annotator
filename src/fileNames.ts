export function safePdfFileName(name: string, fallback = 'annotated.pdf') {
  const cleaned = name
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]+/g, '_')
    .replace(/\s+/g, ' ')
    .trim();

  return cleaned || fallback;
}
