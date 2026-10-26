# Map preview

Watch the beatmap selected in osu! in any of the four rulesets, with your skin, mods and the game's clock, or preview any `.osu` file.

Interfaces: **UI only**, with no native backend. The page runs entirely in the browser on render-core ([shared renderer API](../../packages/render-core/README.md)).

![Map preview](../../docs/screenshots/map-preview.webp)

## Following the game

The preview opens on the game's current map at the current time and follows the map, mods, clock (the track's actual rate) and skin live. It hides during the player's own gameplay.

## Rulesets and skins

- All four rulesets, drawn with the client's skin: stable or lazer, from files or lazer's built-in Argon, Triangles and classic looks ([client-skin](../../packages/client-skin/README.md)). An `.osk` file or a skin folder can be used instead.
- Legacy mania skins are laid out as osu!lazer lays them out, golden-tested against lazer itself.
- osu! maps played in taiko, mania or catch are converted as osu!lazer converts them, key count, key mods and Dual Stages included ([ruleset-convert](../../packages/ruleset-convert/README.md)).

## Manual preview

**Open .osu** previews a file instead of the selected map, with its audio (muted until you unmute it; the choice is remembered) and a ruleset choice. **Follow game** returns to the selected map.

## Settings

Edited on the vosu dashboard (Tools → Map preview → Settings): the skin (the client's current skin or one built-in look), mania scroll speed, taiko and mania note speed, the top bar, the progress line, and whether the controls panel opens on start.
