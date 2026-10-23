// Golden layout oracle for render-core's osu!taiko and osu!catch rendering
// with legacy skins. Never ships.
//
// Copy into an osu!lazer checkout (ppy/osu 2026.1005.0-lazer) as
// osu.Game.Tests/Visual/VosuLayout.cs and run headless:
//
//   VOSU_LAYOUT_SPEC=/path/spec.json dotnet test osu.Game.Tests \
//     -c Release --filter VosuLayout
//
// For every case in the spec it decodes the given .osu file, converts it for
// the case's ruleset with the given mods, and builds lazer's own drawable
// ruleset inside a container the size of lazer's game space for a window
// (DrawSizePreservingFillContainer target 1024×768, so 1365.33×768 for
// 16:9). The user skin is read from a directory with the classic skin behind
// it, as in game. Autoplay drives it to `time`; then the screen-space quad of
// every visible sprite and box is written in that container's coordinates,
// with its texture (lookup name, display and pixel size, wrap modes, the
// sprite's texture rectangle), draw colour, alpha, blending, the nearest
// masking ancestor and the chain of parent types. test/layoutGolden.ts
// compares render-core against that output.

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
using osu.Game.Configuration;
using osu.Game.Database;
using osu.Game.IO;
using osu.Game.Rulesets;
using osu.Game.Rulesets.Catch;
using osu.Game.Rulesets.Mods;
using osu.Game.Rulesets.Taiko;
using osu.Game.Rulesets.UI;
using osu.Game.Scoring;
using osu.Game.Skinning;
using osuTK;

namespace osu.Game.Tests.Visual
{
    [HeadlessTest]
    public partial class VosuLayout : OsuTestScene, IStorageResourceProvider
    {
        private class SpecCase
        {
            public string Name = "";
            public string Ruleset = "";
            public string Skin = "";
            public string Map = "";
            public List<string> Mods = new List<string>();
            public float Width = 1024;
            public float Height = 768;
            public double Time;
            public float Normalisation = 0.2f;
            public bool MapColours;
        }

        private class Spec
        {
            public string Output = "";
            public List<SpecCase> Cases = new List<SpecCase>();
        }

        [Resolved]
        private GameHost host { get; set; } = null!;

        [Resolved]
        private OsuConfigManager config { get; set; } = null!;

        private ManualClock clock = null!;
        private Score replay = null!;
        private DrawableRuleset drawableRuleset = null!;
        private Container space = null!;

        [Test]
        public void Dump()
        {
            string specPath = Environment.GetEnvironmentVariable("VOSU_LAYOUT_SPEC") ?? throw new InvalidOperationException("VOSU_LAYOUT_SPEC is not set");
            var spec = JsonConvert.DeserializeObject<Spec>(File.ReadAllText(specPath))!;
            var results = new List<object>();

            foreach (var c in spec.Cases)
            {
                AddStep($"set up {c.Name}", () => setUp(c));
                AddUntilStep("wait for ruleset", () => drawableRuleset.IsLoaded);
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
            config.SetValue(OsuSetting.ComboColourNormalisationAmount, c.Normalisation);

            Ruleset ruleset = c.Ruleset switch
            {
                "taiko" => new TaikoRuleset(),
                "catch" => new CatchRuleset(),
                _ => throw new ArgumentException(c.Ruleset),
            };
            var mods = c.Mods.Select(a => ruleset.CreateModFromAcronym(a) ?? throw new ArgumentException(a)).ToList();
            var autoplay = ruleset.GetAutoplayMod()!;
            mods.Add(autoplay);

            var working = new FlatWorkingBeatmap(c.Map);
            var playable = working.GetPlayableBeatmap(ruleset.RulesetInfo, mods);
            var userSkin = new DirectorySkin(new SkinInfo { Name = c.Name }, new FolderStore(c.Skin), this);

            drawableRuleset = ruleset.CreateDrawableRulesetWith(playable, mods);
            replay = autoplay.CreateScoreFromReplayData(playable, mods);

            space = new Container
            {
                Clock = new FramedClock(clock = new ManualClock()),
                Size = new Vector2(c.Width, c.Height),
                Child = drawableRuleset,
            };
            Drawable content = space;

            // "Beatmap colours" on: the map's [Colours] win over the skin's, as
            // lazer's beatmap skin provides them (only colours, never textures).
            if (c.MapColours && File.ReadAllText(c.Map).Split("[Colours]") is { Length: > 1 } parts)
            {
                string folder = Directory.CreateTempSubdirectory("vosu-map-colours").FullName;
                File.WriteAllText(Path.Combine(folder, "skin.ini"), "[Colours]\n" + parts[1].Split("\n[")[0]);
                var mapSkin = new DirectorySkin(new SkinInfo { Name = "beatmap" }, new FolderStore(folder), this);
                content = new SkinProvidingContainer(ruleset.CreateSkinTransformer(mapSkin, playable)) { RelativeSizeAxes = Axes.Both, Child = content };
            }

            Child = new SkinProvidingContainer(ruleset.CreateSkinTransformer(new DefaultLegacySkin(this), playable))
            {
                RelativeSizeAxes = Axes.Both,
                Child = new SkinProvidingContainer(ruleset.CreateSkinTransformer(userSkin, playable))
                {
                    RelativeSizeAxes = Axes.Both,
                    Child = content,
                }
            };
        }

        private static string? textureName(Texture texture) =>
            texture.AssetName is { Length: > 0 } name
                ? name
                : (string?)typeof(Texture).GetField("LookupKey", BindingFlags.NonPublic | BindingFlags.Instance)?.GetValue(texture);

        private object dump(SpecCase c)
        {
            float[] local(Quad q) => new[] { q.TopLeft, q.TopRight, q.BottomLeft, q.BottomRight }
                                     .Select(space.ToLocalSpace).SelectMany(v => new[] { v.X, v.Y }).ToArray();

            var items = new List<object>();

            foreach (var d in drawableRuleset.ChildrenOfType<Drawable>())
            {
                object? texture = null;

                if (d is Sprite sprite)
                {
                    if (sprite.Texture == null) continue;

                    var t = sprite.Texture;
                    texture = new
                    {
                        name = textureName(t),
                        display = new[] { t.DisplayWidth, t.DisplayHeight },
                        pixels = new[] { t.Width, t.Height },
                        wrap = new[] { t.WrapModeS.ToString(), t.WrapModeT.ToString() },
                        rect = new[] { sprite.TextureRectangle.X, sprite.TextureRectangle.Y, sprite.TextureRectangle.Width, sprite.TextureRectangle.Height },
                        relative = sprite.TextureRelativeSizeAxes.ToString(),
                    };
                }
                else if (d is not Box)
                    continue;

                var info = d.DrawColourInfo;
                float alpha = info.Colour.AverageColour.Linear.A;
                if (alpha <= 0.001f || !d.IsPresent) continue;

                Drawable? clip = null;
                var path = new List<string>();

                for (var p = d.Parent; p != null && p != space; p = p.Parent)
                {
                    if (path.Count < 8) path.Add(p.GetType().Name);
                    if (clip == null && p is CompositeDrawable { Masking: true } masked) clip = masked;
                }

                var colour = info.Colour.AverageColour;
                items.Add(new
                {
                    type = d.GetType().Name,
                    path,
                    texture,
                    alpha,
                    colour = new[] { colour.SRGB.R, colour.SRGB.G, colour.SRGB.B },
                    additive = info.Blending.Equals(BlendingParameters.Additive),
                    quad = local(d.ScreenSpaceDrawQuad),
                    clip = clip == null ? null : local(clip.ScreenSpaceDrawQuad),
                });
            }

            return new
            {
                name = c.Name,
                size = new[] { c.Width, c.Height },
                playfield = local(drawableRuleset.Playfield.ScreenSpaceDrawQuad),
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
