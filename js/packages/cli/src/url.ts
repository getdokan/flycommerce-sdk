/** A URL without trailing slashes; a loop, since a regex here is slow on many slashes. */
export function withoutTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === '/') end--;
  return value.slice(0, end);
}
