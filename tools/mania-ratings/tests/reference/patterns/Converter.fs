// MIT OR Apache-2.0 for this header; the convert_hit_objects body below is
// copied unmodified from YAVSRG prelude/src/Formats/Conversions/OsuConverter.fs
// lines 14-114 at 1fe55766ae1fece3d433c966bf25822647bc8af6 (MIT, (c) 2024 percyqaz).
namespace Prelude.Formats.Conversions

open System.Collections.Generic
open Percyqaz.Common
open Prelude
open Prelude.Charts

type HitCircle = { X: float; Time: float }
type Hold = { X: float; Time: float; EndTime: float }
type HitObject =
    | HitCircle of HitCircle
    | Hold of Hold
    | Other of float
    member this.Time = match this with HitCircle x -> x.Time | Hold x -> x.Time | Other t -> t

[<AutoOpen>]
module private Skip =
    let skip_conversion (reason: string) = failwith reason

module OsuConverter =

    let convert_hit_objects (objects: HitObject list) (keys: int) : TimeArray<NoteRow> =

        let inline x_to_column (x: float) : int =
            x / 512.0 * float keys |> int |> min(keys - 1) |> max 0

        let holding_until: Time option array = Array.zeroCreate keys
        let output = List<TimeItem<NoteRow>>()
        let mutable last_row: TimeItem<NoteRow> = { Time = -Time.infinity; Data = [||] }

        let inline find_earliest_upcoming_release () : Time =
            let mutable earliest_upcoming_release = Time.infinity

            for h in holding_until do
                match h with
                | Some v -> earliest_upcoming_release <- min earliest_upcoming_release v
                | None -> ()

            earliest_upcoming_release

        let finish_holds (time: Time) =
            let mutable earliest_upcoming_release = find_earliest_upcoming_release()

            while earliest_upcoming_release < time do
                for k = 0 to keys - 1 do
                    if holding_until.[k] = Some earliest_upcoming_release then
                        assert (earliest_upcoming_release >= last_row.Time)

                        if earliest_upcoming_release > last_row.Time then
                            last_row <- { Time = earliest_upcoming_release; Data = Array.zeroCreate keys }

                            output.Add(last_row)

                            for k = 0 to keys - 1 do
                                if holding_until.[k] <> None then
                                    last_row.Data.[k] <- NoteType.HOLDBODY

                        match last_row.Data.[k] with
                        | NoteType.NOTHING
                        | NoteType.HOLDBODY ->
                            last_row.Data.[k] <- NoteType.HOLDTAIL
                            holding_until.[k] <- None
                        | _ -> failwithf "impossible"

                earliest_upcoming_release <- find_earliest_upcoming_release()

        let add_note (column: int) (time: Time) =
            finish_holds(time)
            assert (time >= last_row.Time)

            if time > last_row.Time then
                last_row <- { Time = time; Data = Array.zeroCreate keys }

                output.Add(last_row)

                for k = 0 to keys - 1 do
                    if holding_until.[k] <> None then
                        last_row.Data.[k] <- NoteType.HOLDBODY

            match last_row.Data.[column] with
            | NoteType.NOTHING -> last_row.Data.[column] <- NoteType.NORMAL
            | NoteType.NORMAL
            | NoteType.HOLDHEAD -> Logging.Debug "Fixing stacked note at %f, column %i" time (column + 1)
            | other ->
                skip_conversion(sprintf "Stacked note at %f, column %i, coincides with %A" time (column + 1) other)

        let start_hold (column: int) (time: Time) (end_time: Time) =
            finish_holds(time)
            assert (time >= last_row.Time)
            assert (end_time > time)

            if time > last_row.Time then
                last_row <- { Time = time; Data = Array.zeroCreate keys }

                output.Add(last_row)

                for k = 0 to keys - 1 do
                    if holding_until.[k] <> None then
                        last_row.Data.[k] <- NoteType.HOLDBODY

            match last_row.Data.[column] with
            | NoteType.NOTHING ->
                last_row.Data.[column] <- NoteType.HOLDHEAD
                holding_until.[column] <- Some end_time
            | NoteType.NORMAL ->
                Logging.Debug "Fixing stacked note + LN head at %f, column %i" time (column + 1)
                last_row.Data.[column] <- NoteType.HOLDHEAD
                holding_until.[column] <- Some end_time
            | other ->
                skip_conversion(sprintf "Stacked LN at %f, column %i, head coincides with %A" time (column + 1) other)

        // The osu! client sorts all hitobjects and timing points by timestamp for when users have put them in the wrong order via notepad
        for object in objects |> List.sortBy _.Time do
            match object with
            | HitCircle x -> add_note (x_to_column x.X) (Time.of_number x.Time)
            | Hold x when x.EndTime > x.Time ->
                start_hold (x_to_column x.X) (Time.of_number x.Time) (Time.of_number x.EndTime)
            | Hold x -> add_note (x_to_column x.X) (Time.of_number x.Time)
            | _ -> ()

        finish_holds(Time.infinity)
        output.ToArray()
