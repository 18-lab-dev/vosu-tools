// MIT OR Apache-2.0. Test adapter; calculators in adjacent files are unmodified upstream.
namespace Prelude
[<Measure>] type ms
[<Measure>] type rate
type Time = float32<ms>
type GameplayTime = float32<ms/rate>
type Rate = float32<rate>
type Color = System.Drawing.Color
[<AutoOpen>]
module Helpers =
    let cached f = f
module TimeArray =
    let first (xs: 'a array) = ValueSome xs.[0]
namespace Prelude.Charts
open Prelude
type NoteType = NORMAL = 1 | HOLDHEAD = 2 | NOTHING = 0
type NoteRow = { Time: Time; Data: NoteType array }
type NoteData = { Keys: int; Notes: NoteRow array }
