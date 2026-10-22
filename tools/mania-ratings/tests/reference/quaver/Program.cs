// MIT OR Apache-2.0. Adapter only; calculator files are unmodified MPL-2.0 upstream.
using Quaver.API.Maps;
using Quaver.API.Maps.Processors.Difficulty.Rulesets.Keys;
using Quaver.API.Maps.Structures;
using Quaver.API.Enums;
using System.Text.Json;
var path = args[0];
var lines = File.ReadAllLines(path);
var keys = int.Parse(lines.First(l => l.StartsWith("CircleSize:")).Split(':')[1]);
var map = new Qua { Mode = keys };
var inside = false;
foreach(var line in lines) {
 if(line.StartsWith("[")) inside = line.Trim() == "[HitObjects]";
 if(!inside || !line.Contains(',')) continue;
 var p = line.Split(',');
 var type = int.Parse(p[3]);
 map.HitObjects.Add(new HitObjectInfo { Lane = Math.Min(keys-1,(int)Math.Floor(float.Parse(p[0],System.Globalization.CultureInfo.InvariantCulture)*keys/512))+1, StartTime = int.Parse(p[2]), EndTime = (type & 128) != 0 ? int.Parse(p[5].Split(':')[0]):0 });
}
foreach(var rate in new[]{0.75f,1f,1.5f}) {
 Quaver.API.Helpers.ModHelper.Rate = rate;
 var calc = new DifficultyProcessorKeys(map,new StrainConstantsKeys());
 Console.WriteLine(JsonSerializer.Serialize(new { keys,rate,rating=calc.OverallDifficulty,series=calc.StrainSolverData.Select(p=>new[]{p.StartTime/1000,p.TotalStrainValue}) }));
}
namespace Quaver.API.Enums {
 public enum ModIdentifier { None }
 [Flags] public enum QssPatternFlags { SimpleVibro=1,Rolls=2 }
 public enum HitObjectType { Normal,Mine }
}
namespace Quaver.API.Helpers {
 public static class ModHelper { public static float Rate=1; public static float GetRateFromMods(ModIdentifier mods)=>Rate; }
 public static class ModeHelper { public static int ToKeyCount(int mode)=>mode; }
}
namespace Quaver.API.Maps.Structures {
 public class HitObjectInfo { public int Lane{get;set;} public int StartTime{get;set;} public int EndTime{get;set;} public HitObjectType Type{get;set;} }
}
namespace Quaver.API.Maps {
 public class Qua {
  public int Mode{get;set;} public bool HasScratchKey=>false;
  public List<HitObjectInfo> HitObjects{get;}=new();
  public int GetKeyCount(bool scratch=true)=>Mode;
  public int DifficultyContributingHitObjects=>HitObjects.Count;
  public int Length=>HitObjects.Count==0?0:HitObjects.Max(p=>Math.Max(p.StartTime,p.EndTime));
 }
}
namespace Quaver.API.Maps.Processors.Difficulty.Optimization {
 public class StrainConstants { protected float NewConstant(string name,float value)=>value; }
}
namespace Quaver.API.Maps.Processors.Difficulty {
 public abstract class DifficultyProcessor {
  internal Qua Map{get;set;} public float OverallDifficulty{get;set;}
  public QssPatternFlags QssPatternFlags{get;set;} public const float SECONDS_TO_MILLISECONDS=1000;
  protected DifficultyProcessor(Qua map,Optimization.StrainConstants constants,ModIdentifier mods=ModIdentifier.None)=>Map=map;
 }
}
