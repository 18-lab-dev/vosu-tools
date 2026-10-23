// vosu's `/websocket/v2/subscribe` request validation, mirrored for the
// stand-in host (vosu src/server/v2_subscription.rs: parse_subscription_request,
// compile_pointers, decode_pointer). A request vosu rejects must be rejected
// here too, with the same error frame, so tests cannot pass on a request the
// real host refuses.
const encoder = new TextEncoder();

function decodePointer(pointer: string): string[] | null {
  if (pointer === '') return [];
  if (!pointer.startsWith('/')) return null;
  const tokens: string[] = [];
  for (const token of pointer.slice(1).split('/')) {
    let decoded = '';
    for (let i = 0; i < token.length; i++) {
      if (token[i] !== '~') {
        decoded += token[i];
        continue;
      }
      const next = token[++i];
      if (next === '0') decoded += '~';
      else if (next === '1') decoded += '/';
      else return null;
    }
    tokens.push(decoded);
  }
  return tokens;
}

const isPrefix = (prefix: string[], value: string[]) =>
  prefix.length <= value.length && prefix.every((token, i) => token === value[i]);

/** `[2, code, message]` for a request vosu rejects, otherwise the decoded pointers. */
export function checkSubscription(text: string): { error: [2, number, string] } | { pointers: string[][] } {
  const invalidRequest = { error: [2, 1, 'invalid subscription request'] as [2, number, string] };
  const invalidPointer = { error: [2, 2, 'invalid JSON Pointer'] as [2, number, string] };
  let request: unknown;
  try {
    request = JSON.parse(text);
  } catch {
    return invalidRequest;
  }
  if (!Array.isArray(request) || !request.every((p) => typeof p === 'string')) return invalidRequest;
  if (request.length < 1 || request.length > 256 || request.some((p) => encoder.encode(p).length > 512)) return invalidRequest;
  const compiled: string[][] = [];
  for (const pointer of request as string[]) {
    const tokens = decodePointer(pointer);
    if (!tokens) return invalidPointer;
    if (tokens.length > 32) return invalidRequest;
    if (compiled.some((existing) => isPrefix(existing, tokens) || isPrefix(tokens, existing))) return invalidPointer;
    compiled.push(tokens);
  }
  return { pointers: compiled };
}

export const validSubscription = (text: string) => 'pointers' in checkSubscription(text);

/** The value at `tokens` in `document`, or undefined when absent. */
export function at(document: unknown, tokens: string[]): unknown {
  let node = document;
  for (const token of tokens) {
    if (node === null || typeof node !== 'object' || !(token in node)) return undefined;
    node = Reflect.get(node, token);
  }
  return node;
}
