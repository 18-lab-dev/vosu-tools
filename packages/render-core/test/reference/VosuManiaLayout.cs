// Golden layout oracle for render-core's legacy mania skinning. Never ships.
//
// Copy into an osu!lazer checkout (ppy/osu 2026.1005.0-lazer) as
// osu.Game.Rulesets.Mania.Tests/VosuManiaLayout.cs and run headless:
//
//   VOSU_MANIA_SPEC=/path/spec.json dotnet test osu.Game.Rulesets.Mania.Tests \
//     -c Release --filter VosuManiaLayout
//
// For every case in the spec it builds lazer's own DrawableManiaRuleset with a
// legacy skin read from a directory (the classic skin behind it, as in game),
// plays the given objects with autoplay up to `time`, and writes the stage-local
// quads (lazer stage units, 768 tall) of every visible legacy skin sprite and
// box. test/maniaGolden.ts compares render-core's layout against that output.

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Threading;
using System.Threading.Tasks;
using Newtonsoft.Json;
using NUnit.Framework;
using osu.Framework.Allocation;
using osu.Framework.Audio;
using osu.Framework.Graphics;
using osu.Framework.Graphics.Containers;
using osu.Framework.Graphics.Primitives;
using osu.Framework.Graphics.Rendering;
using osu.Framework.Graphics.Shapes;
using osu.Framework.Graphics.Sprites;
using osu.Framework.Graphics.Textures;
using osu.Framework.IO.Stores;
using osu.Framework.Platform;
using osu.Framework.Testing;
using osu.Framework.Timing;
using osu.Framework.Utils;
using osu.Game.Beatmaps;
using osu.Game.Beatmaps.ControlPoints;
using osu.Game.Database;
using osu.Game.IO;
using osu.Game.Rulesets.Mania.Beatmaps;
using osu.Game.Rulesets.Mania.Configuration;
using osu.Game.Rulesets.Mania.Mods;
using osu.Game.Rulesets.Mania.Objects;
using osu.Game.Rulesets.Mania.Objects.Drawables;
using osu.Game.Rulesets.Mania.UI;
using osu.Game.Rulesets.Mods;
using osu.Game.Scoring;
using osu.Game.Skinning;
using osu.Game.Tests.Visual;
using osuTK;

namespace osu.Game.Rulesets.Mania.Tests
{
    [HeadlessTest]
    public partial class VosuManiaLayout : OsuTestScene, IStorageResourceProvider
    {
        private class SpecObject
        {
            public int Column;
            public double Start;
            public double? End;
        }

        private class SpecCase
        {
            public string Name = "";
            public string Skin = "";
            public int Keys;
            public string Direction = "down";
            public double ScrollSpeed = 20;
            public double Time;
            public List<SpecObject> Objects = new List<SpecObject>();
        }

        private class Spec
        {
            public string Output = "";
            public List<SpecCase> Cases = new List<SpecCase>();
        }

        [Resolved]
        private GameHost host { get; set; } = null!;

        protected override Ruleset CreateRuleset() => new ManiaRuleset();

        private ManualClock clock = null!;
        private Score replay = null!;
        private DrawableManiaRuleset drawableRuleset = null!;

        [Test]
        public void Dump()
        {
            string specPath = Environment.GetEnvironmentVariable("VOSU_MANIA_SPEC") ?? throw new InvalidOperationException("VOSU_MANIA_SPEC is not set");
            var spec = JsonConvert.DeserializeObject<Spec>(File.ReadAllText(specPath))!;
            var results = new List<object>();

            foreach (var c in spec.Cases)
            {
                AddStep($"set up {c.Name}", () => setUp(c));
                AddUntilStep("wait for stage", () => drawableRuleset.IsLoaded && drawableRuleset.Playfield.Stages.Count > 0);
                AddStep("autoplay", () => drawableRuleset.SetReplayScore(replay));
                AddStep($"seek {c.Name}", () => clock.CurrentTime = c.Time);
                AddUntilStep("wait for seek", () => Precision.AlmostEquals(drawableRuleset.FrameStableClock.CurrentTime, c.Time, 0.5));
                AddWaitStep("settle layout", 3);
                AddStep($"dump {c.Name}", () => results.Add(dump(c)));
            }

            AddStep("write", () => File.WriteAllText(spec.Output, JsonConvert.SerializeObject(results, Formatting.Indented)));
        }

        private void setUp(SpecCase c)
        {
            var config = (ManiaRulesetConfigManager)RulesetConfigs.GetConfigFor(Ruleset.Value.CreateInstance())!;
            config.SetValue(ManiaRulesetSetting.ScrollSpeed, c.ScrollSpeed);
            config.SetValue(ManiaRulesetSetting.ScrollDirection, c.Direction == "up" ? ManiaScrollingDirection.Up : ManiaScrollingDirection.Down);

            var beatmap = new ManiaBeatmap(new StageDefinition(c.Keys))
            {
                BeatmapInfo = { Ruleset = new ManiaRuleset().RulesetInfo },
                ControlPointInfo = new ControlPointInfo(),
            };
            beatmap.ControlPointInfo.Add(0, new TimingControlPoint { BeatLength = 500 });

            foreach (var o in c.Objects)
            {
                if (o.End is double end)
                    beatmap.HitObjects.Add(new HoldNote { Column = o.Column, StartTime = o.Start, Duration = end - o.Start });
                else
                    beatmap.HitObjects.Add(new Note { Column = o.Column, StartTime = o.Start });
            }

            foreach (var h in beatmap.HitObjects)
                h.ApplyDefaults(beatmap.ControlPointInfo, beatmap.Difficulty);

            var ruleset = Ruleset.Value.CreateInstance();
            var autoplay = new ManiaModAutoplay();
            var mods = new Mod[] { autoplay };
            var userSkin = new DirectorySkin(new SkinInfo { Name = c.Name }, new FolderStore(c.Skin), this);

            drawableRuleset = (DrawableManiaRuleset)ruleset.CreateDrawableRulesetWith(beatmap, mods);
            replay = autoplay.CreateScoreFromReplayData(beatmap, mods);

            Child = new SkinProvidingContainer(ruleset.CreateSkinTransformer(new DefaultLegacySkin(this), beatmap))
            {
                RelativeSizeAxes = Axes.Both,
                Child = new SkinProvidingContainer(ruleset.CreateSkinTransformer(userSkin, beatmap))
                {
                    RelativeSizeAxes = Axes.Both,
                    Child = new Container
                    {
                        Clock = new FramedClock(clock = new ManualClock()),
                        RelativeSizeAxes = Axes.Both,
                        Child = drawableRuleset,
                    }
                }
            };
        }

        private static readonly string[] known =
        {
            "LegacyKeyArea", "LegacyNotePiece", "LegacyHoldNoteHeadPiece", "LegacyHoldNoteTailPiece", "LegacyBodyPiece",
            "LegacyHitTarget", "LegacyStageForeground", "LegacyColumnBackground", "LegacyHitExplosion", "LegacyBarLine",
            "ColumnBackground", "LegacyStageBackground", "HitTargetInsetContainer",
        };

        private object dump(SpecCase c)
        {
            var stage = drawableRuleset.Playfield.Stages[0];
            float[] local(Quad q) => new[] { q.TopLeft, q.TopRight, q.BottomLeft, q.BottomRight }
                                     .Select(stage.ToLocalSpace).SelectMany(v => new[] { v.X, v.Y }).ToArray();

            var items = new List<object>();

            foreach (var d in stage.ChildrenOfType<Drawable>())
            {
                string? asset = null;
                float[]? texture = null;

                if (d is Sprite sprite)
                {
                    if (sprite.Texture == null) continue;

                    asset = sprite.Texture.AssetName is { Length: > 0 } name
                        ? name
                        : (string?)typeof(Texture).GetField("LookupKey", BindingFlags.NonPublic | BindingFlags.Instance)?.GetValue(sprite.Texture);
                    texture = new[] { sprite.Texture.DisplayWidth, sprite.Texture.DisplayHeight };
                }
                else if (d is not Box)
                    continue;

                float alpha = d.DrawColourInfo.Colour.AverageColour.Linear.A;
                if (alpha <= 0.001f || !d.IsPresent) continue;

                string kind = "";
                int? column = null;
                Drawable? clip = null;

                for (var p = d.Parent; p != null && p != stage; p = p.Parent)
                {
                    string name = p.GetType().Name;
                    if (kind == "" && known.Contains(name)) kind = name;
                    if (column == null && p is Column col) column = col.Index;
                    // Hold note bodies and tails draw through proxies inside the hold note's masking container.
                    if (clip == null && p is DrawableHoldNote hold && kind is "LegacyBodyPiece" or "LegacyHoldNoteTailPiece")
                        clip = ((Container)typeof(DrawableHoldNote).GetField("maskingContainer", BindingFlags.NonPublic | BindingFlags.Instance)!.GetValue(hold)!).Child;
                }

                var colour = d.DrawColourInfo.Colour.AverageColour;
                items.Add(new
                {
                    kind,
                    type = d.GetType().Name,
                    asset,
                    texture,
                    column,
                    alpha,
                    colour = new[] { colour.SRGB.R, colour.SRGB.G, colour.SRGB.B },
                    quad = local(d.ScreenSpaceDrawQuad),
                    clip = clip == null ? null : local(clip.ScreenSpaceDrawQuad),
                });
            }

            return new
            {
                name = c.Name,
                stage = new[] { stage.DrawWidth, stage.DrawHeight },
                columns = stage.Columns.Select(col => local(col.ScreenSpaceDrawQuad)).ToArray(),
                items,
            };
        }

        private class DirectorySkin : LegacySkin
        {
            public DirectorySkin(SkinInfo skin, IResourceStore<byte[]> store, IStorageResourceProvider resources)
                : base(skin, resources, store)
            {
            }
        }

        /// <summary>
        /// A skin folder looked up the way lazer's RealmBackedResourceStore does:
        /// standardised ('/'-separated) and case-insensitive file names.
        /// </summary>
        private class FolderStore : IResourceStore<byte[]>
        {
            private readonly Dictionary<string, string> files;

            public FolderStore(string folder)
            {
                files = Directory.EnumerateFiles(folder, "*", SearchOption.AllDirectories)
                                 .ToDictionary(f => standardise(Path.GetRelativePath(folder, f)));
            }

            private static string standardise(string name) => name.Replace('\\', '/').ToLowerInvariant();

            private string? find(string name) => files.GetValueOrDefault(standardise(name));

            public byte[] Get(string name) => find(name) is string path ? File.ReadAllBytes(path) : null!;

            public Task<byte[]> GetAsync(string name, CancellationToken cancellationToken = default) => Task.FromResult(Get(name));

            public Stream GetStream(string name) => find(name) is string path ? File.OpenRead(path) : null!;

            public IEnumerable<string> GetAvailableResources() => files.Keys;

            public void Dispose()
            {
            }
        }

        public IRenderer Renderer => host.Renderer;
        public AudioManager AudioManager => Audio;
        public IResourceStore<byte[]> Files => null!;
        public new IResourceStore<byte[]> Resources => base.Resources;
        public IResourceStore<TextureUpload> CreateTextureLoaderStore(IResourceStore<byte[]> underlyingStore) => host.CreateTextureLoaderStore(underlyingStore);
        RealmAccess IStorageResourceProvider.RealmAccess => null!;
    }
}
