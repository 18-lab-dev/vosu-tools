// MIT OR Apache-2.0. Maps osu!mania heads to Prelude's native NoteData.
open System
open System.IO
open System.Text.Json
open Prelude
open Prelude.Charts
open Prelude.Calculator
[<EntryPoint>]
let main args =
    let lines = File.ReadAllLines args.[0]
    let keys = lines |> Array.find (fun s -> s.StartsWith "CircleSize:") |> fun s -> Int32.Parse(s.Split(':').[1])
    let mutable inside = false
    let heads = ResizeArray<_>()
    for line in lines do
        if line.StartsWith "[" then inside <- line.Trim() = "[HitObjects]"
        if inside && line.Contains ',' then
            let p = line.Split ','
            let lane = min (keys - 1) (int (floor (Single.Parse(p.[0],Globalization.CultureInfo.InvariantCulture) * float32 keys / 512.0f)))
            heads.Add (Single.Parse(p.[2],Globalization.CultureInfo.InvariantCulture),lane)
    let notes = heads |> Seq.groupBy fst |> Seq.sortBy fst |> Seq.map (fun (t,items) ->
        let data = Array.create keys NoteType.NOTHING
        for (_,lane) in items do data.[lane] <- NoteType.NORMAL
        {Time=t*1.0f<ms>; Data=data}) |> Array.ofSeq
    for rate in [0.75f;1.0f;1.5f] do
        let result = Difficulty.calculate (rate*1.0f<rate>,{Keys=keys;Notes=notes})
        let series = Array.map2 (fun row strain -> [|float32 row.Time/1000.0f/rate; Array.max strain.StrainV1Notes|]) notes result.Strains
        printfn "%s" (JsonSerializer.Serialize {| keys=keys; rate=rate; rating=result.Overall; series=series |})
    0
