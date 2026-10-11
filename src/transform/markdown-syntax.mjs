// Keep the conversion and document parser on the same fenced-code rules.
export function openingFence(line) {
  const match = String(line).match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
  if (!match || (match[1][0] === "`" && match[2].includes("`"))) return undefined;
  return match[1];
}

export function isClosingFence(line, opening) {
  const match = String(line).match(/^ {0,3}(`{3,}|~{3,})[ \t]*$/);
  return Boolean(match && match[1][0] === opening[0] && match[1].length >= opening.length);
}

export function escapeMarkdownText(value) {
  return String(value ?? "").replace(/[\\`*_{}\[\]<>~]/g, "\\$&").replace(/\s+/g, " ");
}

// Only use validated URLs here. Parentheses are URI-equivalent when encoded, and cannot close the generated destination.
export function markdownLink(label, url, { image = false, formattedLabel = false } = {}) {
  const destination = String(url).replace(/\(/g, "%28").replace(/\)/g, "%29");
  return `${image ? "!" : ""}[${formattedLabel ? label : escapeMarkdownText(label)}](${destination})`;
}
