export const truncateUtf8 = (
  text: string,
  maxBytes: number,
): { readonly head: string; readonly bytes: number; readonly truncated: boolean } => {
  const encoder = new TextEncoder();
  const encoded = encoder.encode(text);
  if (encoded.length <= maxBytes) {
    return { head: text, bytes: encoded.length, truncated: false };
  }
  let head = "";
  let headBytes = 0;
  for (const char of text) {
    const charBytes = encoder.encode(char).length;
    if (headBytes + charBytes > maxBytes) {
      break;
    }
    head += char;
    headBytes += charBytes;
  }
  return { head, bytes: encoded.length, truncated: true };
};
