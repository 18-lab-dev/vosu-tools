// MIT OR Apache-2.0. Minimal stand-ins for the Prelude/Percyqaz types the
// unmodified upstream files in ./upstream and ../interlude compile against
// (YAVSRG 1fe55766ae1fece3d433c966bf25822647bc8af6; definitions copied from
// prelude/src/Shared/Units.fs, TimeArray.fs and Charts/NoteRow.fs, Chart.fs).
namespace Percyqaz.Common
[<Measure>] type ms
[<Measure>] type rate
type Time = float32<ms>
module Logging =
    let Error (_: string) = ()
    let Debug fmt = Printf.ksprintf ignore fmt

namespace Percyqaz.Data
module Json =
    type AutoCodecAttribute() = inherit System.Attribute()

namespace Prelude
[<Measure>] type ms = Percyqaz.Common.ms
[<Measure>] type rate = Percyqaz.Common.rate
[<Measure>] type beat
[<Measure>] type minute
type GameplayTime = float32<ms / rate>
type Rate = float32<rate>
type Time = Percyqaz.Common.Time
type Color = System.Drawing.Color
module Time =
    let inline of_number (f: ^T) : Time = float32 f * 1.0f<ms>
    let infinity: Time = infinityf * 1.0f<ms>
[<AutoOpen>]
module UnitConstants =
    [<Literal>]
    let MS_PER_MINUTE = 60_000.0f<ms / minute>
[<AutoOpen>]
module Helpers =
    let cached f = f
[<Struct>]
type TimeItem<'T> = { Time: Time; Data: 'T }
type TimeArray<'T> = TimeItem<'T> array
module TimeArray =
    let last (arr: TimeArray<'T>) = if arr.Length > 0 then Some arr.[arr.Length - 1] else None
    let first (arr: TimeArray<'T>) = if arr.Length > 0 then Some arr.[0] else None

namespace Prelude.Charts
open Prelude
type NoteType =
    | NOTHING = 0uy
    | NORMAL = 1uy
    | HOLDHEAD = 2uy
    | HOLDBODY = 3uy
    | HOLDTAIL = 4uy
type NoteRow = NoteType array
[<Struct>]
type NoteData = { Keys: int; Notes: TimeArray<NoteRow> }
type Chart =
    { Keys: int; Notes: TimeArray<NoteRow>; SV: TimeArray<float32> }
    member this.FirstNote: Time = (TimeArray.first this.Notes).Value.Time
    member this.LastNote: Time = (TimeArray.last this.Notes).Value.Time
    member this.ToNoteData() : NoteData = { Keys = this.Keys; Notes = this.Notes }
module Chart =
    let inline notecount< ^T when ^T: (member Notes: TimeArray<NoteRow>)> (chart: ^T) : int * int =
        let mutable notes = 0
        let mutable lnotes = 0
        for { Data = nr } in chart.Notes do
            for n in nr do
                if n = NoteType.NORMAL then
                    notes <- notes + 1
                elif n = NoteType.HOLDHEAD then
                    notes <- notes + 1
                    lnotes <- lnotes + 1
        notes, lnotes
