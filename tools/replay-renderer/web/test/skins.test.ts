import { expect, test } from "bun:test";
import { skinGroups } from "../src/skins";

test("every skin source is offered, grouped, with stable values", () => {
  const groups = skinGroups({
    skins: ["- Minimal Archive"],
    imported_skins: ["Arturia"],
    lazer_skins: [{ id: "6f1b-22", name: "「sigma」 - GAME OVER", creator: "sigma" }],
    current_skin: { source: "vosu", name: "「sigma」 - GAME OVER", builtin: null },
  });
  expect(groups.map((g) => g.label)).toEqual([
    "",
    "lazer",
    "osu! Skins folder",
    "Imported .osk",
    "Built-in",
  ]);
  expect(groups.flatMap((g) => g.options.map((o) => o.value))).toEqual([
    "",
    "lazer/6f1b-22",
    "- Minimal Archive",
    "imported/Arturia",
    "builtin/argon",
    "builtin/argon-pro",
    "builtin/triangles",
    "builtin/legacy",
  ]);
  expect(groups[0].options[0].label).toBe("Current · 「sigma」 - GAME OVER");
  expect(groups[1].options[0].label).toBe("「sigma」 - GAME OVER (sigma)");
});

test("built-in looks are always available, empty sources are omitted", () => {
  const groups = skinGroups({
    skins: [],
    imported_skins: [],
    current_skin: { source: "builtin", name: "argon", builtin: "argon-pro" },
  });
  expect(groups.map((g) => g.label)).toEqual(["", "Built-in"]);
  expect(groups[0].options[0].label).toBe("Current · Argon Pro (built-in)");
  expect(groups[1].options.map((o) => o.label)).toEqual(["Argon", "Argon Pro", "Triangles", "Classic"]);
});
