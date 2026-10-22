// Reference oracle for @vosu-tools/ruleset-convert golden tests. Never ships.
// Runs osu!lazer's own pipeline (LegacyBeatmapDecoder -> WorkingBeatmap.GetPlayableBeatmap)
// for a target ruleset and mod acronyms, and prints the converted objects as JSON.
//
//   dotnet run -- <taiko|mania|fruits> <map.osu> [MOD,MOD,...]
using System.Text.Json;
using osu.Game.Beatmaps;
using osu.Game.Rulesets;
using osu.Game.Rulesets.Catch;
using osu.Game.Rulesets.Catch.Objects;
using osu.Game.Rulesets.Mania;
using osu.Game.Rulesets.Mania.Beatmaps;
using osu.Game.Rulesets.Mania.Objects;
using osu.Game.Rulesets.Mods;
using osu.Game.Rulesets.Objects.Types;
using osu.Game.Rulesets.Taiko;
using osu.Game.Rulesets.Taiko.Objects;

Ruleset ruleset = args[0] switch
{
    "taiko" => new TaikoRuleset(),
    "mania" => new ManiaRuleset(),
    "fruits" => new CatchRuleset(),
    _ => throw new ArgumentException(args[0]),
};
var mods = (args.Length > 2 && args[2].Length > 0 ? args[2].Split(',') : Array.Empty<string>())
    .Select(a => ruleset.CreateModFromAcronym(a) ?? throw new ArgumentException($"unknown mod {a}"))
    .ToArray();
var working = new FlatWorkingBeatmap(args[1]);
var playable = working.GetPlayableBeatmap(ruleset.RulesetInfo, mods);

object output = playable switch
{
    ManiaBeatmap mania => new
    {
        columns = mania.TotalColumns,
        stages = mania.Stages.Count,
        objects = mania.HitObjects.Select(o => new
        {
            t = o.StartTime,
            e = (o as IHasDuration)?.EndTime ?? o.StartTime,
            c = o.Column,
            k = o is HoldNote ? "hold" : "note",
        }),
    },
    _ when ruleset is TaikoRuleset => new
    {
        objects = playable.HitObjects.Select(o => new
        {
            t = o.StartTime,
            e = (o as IHasDuration)?.EndTime ?? o.StartTime,
            k = o switch { Hit => "hit", DrumRoll => "drumroll", Swell => "swell", _ => o.GetType().Name },
            rim = o is Hit h && h.Type == HitType.Rim,
            strong = o is TaikoStrongableHitObject s && s.IsStrong,
            hits = (o as Swell)?.RequiredHits,
        }),
        // lazer moves scroll speed to effect points on converted maps.
        scroll = playable.ControlPointInfo.EffectPoints.Select(p => new { t = p.Time, v = p.ScrollSpeed }),
    },
    _ => new
    {
        objects = playable.HitObjects.SelectMany(o => o is JuiceStream or BananaShower ? o.NestedHitObjects.Cast<CatchHitObject>() : new[] { (CatchHitObject)o })
            .Where(o => o is not (JuiceStream or BananaShower))
            .Select(o => new
            {
                t = o.StartTime,
                x = o.EffectiveX,
                k = o switch { Fruit => "fruit", TinyDroplet => "tiny", Droplet => "droplet", Banana => "banana", _ => o.GetType().Name },
                hyper = o is PalpableCatchHitObject p && p.HyperDash,
            }),
    },
};
Console.WriteLine(JsonSerializer.Serialize(output));
