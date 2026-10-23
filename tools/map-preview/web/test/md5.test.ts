import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { md5 } from "../src/md5";

test("md5 matches RFC 1321 vectors and node:crypto", () => {
  const text = (s: string) => md5(new TextEncoder().encode(s));
  expect(text("")).toBe("d41d8cd98f00b204e9800998ecf8427e");
  expect(text("abc")).toBe("900150983cd24fb0d6963f7d28e17f72");
  expect(text("message digest")).toBe("f96b697d7cb7938d525a2f31aaf161d0");
  for (const length of [55, 56, 63, 64, 65, 1000, 100_000]) {
    const bytes = new Uint8Array(length).map((_, i) => (i * 31 + 7) & 255);
    expect(md5(bytes)).toBe(createHash("md5").update(bytes).digest("hex"));
  }
});
