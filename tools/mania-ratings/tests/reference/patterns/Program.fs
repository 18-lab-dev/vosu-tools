// MIT OR Apache-2.0. Runs Interlude's unmodified pattern analysis
// (PatternReport.from_chart_uncached) on an .osu chart and prints JSON.
// .osu parsing here mirrors src/patterns.rs: CircleSize, [HitObjects] x/time,
// type bit 128 = hold (end time before the first ':'), bit 1 = circle. SV is not
// converted (the chart's SV array is empty), as in the Rust port.
open System
open System.IO
open System.Globalization
open System.Text.Json
open Prelude
open Prelude.Charts
open Prelude.Calculator
open Prelude.Calculator.Patterns
open Prelude.Formats.Conversions

let num (s: string) = Double.Parse(s.Trim(), CultureInfo.InvariantCulture)
let opts = JsonSerializerOptions(NumberHandling = Serialization.JsonNumberHandling.AllowNamedFloatingPointLiterals)

[<EntryPoint>]
let main args =
    let lines = File.ReadAllLines args.[0]
    let keys = lines |> Array.find (fun s -> s.StartsWith "CircleSize:") |> fun s -> int (num (s.Split(':').[1]))
    let mutable inside = false
    let objects = ResizeArray<HitObject>()
    for line in lines do
        if line.StartsWith "[" then inside <- line.Trim() = "[HitObjects]"
        elif inside && line.Contains ',' then
            let p = line.Split ','
            let kind = int (num p.[3])
            if kind &&& 128 <> 0 then
                objects.Add(Hold { X = num p.[0]; Time = num p.[2]; EndTime = num (p.[5].Split(':').[0]) })
            elif kind &&& 1 <> 0 then
                objects.Add(HitCircle { X = num p.[0]; Time = num p.[2] })
            else
                objects.Add(Other (num p.[2]))
    match (try Ok (OsuConverter.convert_hit_objects (List.ofSeq objects) keys) with e -> Error e.Message) with
    | Error message ->
        printfn "%s" (JsonSerializer.Serialize({| keys = keys; error = message |}, opts))
        0
    | Ok notes ->
    let chart = { Keys = keys; Notes = notes; SV = [||] }
    for rate in [ 1.0f; 1.5f ] do
        let difficulty = Difficulty.calculate (rate * 1.0f<rate>, chart.ToNoteData())
        let report = PatternReport.from_chart_uncached (difficulty, chart)
        let clusters =
            report.Clusters
            |> Array.map (fun c ->
                {| pattern = string c.Pattern
                   specific = c.SpecificTypes |> List.map (fun (n, a) -> [| box n; box a |]) |> Array.ofList
                   bpm = int c.BPM
                   mixed = c.Mixed
                   rating = float32 c.Rating
                   density = [| c.Density10; c.Density25; c.Density50; c.Density75; c.Density90 |] |> Array.map float32
                   amount = float32 c.Amount
                   importance = float32 c.Importance |})
        let result =
            {| keys = keys
               rate = rate
               rows = notes.Length
               category = report.Category
               ln_percent = report.LNPercent
               density = [| report.Density10; report.Density25; report.Density50; report.Density75; report.Density90 |] |> Array.map float32
               duration = float32 report.Duration
               clusters = clusters |}
        printfn "%s" (JsonSerializer.Serialize(result, opts))
    0
