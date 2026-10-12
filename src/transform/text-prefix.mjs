// Keep complete chunk boundaries in UTF-16 characters, matching the output budget without repeatedly joining shrinking arrays.
export function createTextPrefixes(chunks) {
  const ends = [0];
  for (const chunk of chunks) ends.push(ends.at(-1) + chunk.length);
  const text = chunks.join("");
  return (count) => text.slice(0, ends[count]);
}
