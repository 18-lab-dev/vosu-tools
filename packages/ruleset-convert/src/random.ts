/**
 * osu!stable's xorshift generator as lazer keeps it (`osu.Game.Utils.LegacyRandom`).
 * Every conversion that the clients randomise (mania patterns, catch offsets and
 * bananas) draws from it in a fixed order, so the port must too.
 */
export class LegacyRandom {
  private x: number;
  private y = 842502087;
  private z = 3579807591;
  private w = 273326509;
  private bitBuffer = 0;
  private bitIndex = 32;

  constructor(seed: number) {
    this.x = seed >>> 0;
  }

  nextUInt(): number {
    const t = (this.x ^ (this.x << 11)) >>> 0;
    this.x = this.y;
    this.y = this.z;
    this.z = this.w;
    this.w = (this.w ^ (this.w >>> 19) ^ t ^ (t >>> 8)) >>> 0;
    return this.w;
  }

  /** 0 ..= int.MaxValue. */
  next(): number {
    return this.nextUInt() & 0x7fffffff;
  }

  nextDouble(): number {
    return this.next() / 2147483648;
  }

  /** `(int)(lower + NextDouble() * (upper - lower))`, truncating towards zero. */
  nextInRange(lower: number, upper: number): number {
    return Math.trunc(lower + this.nextDouble() * (upper - lower));
  }

  /** `Next(upperBound)`. */
  nextBelow(upper: number): number {
    return Math.trunc(this.nextDouble() * upper);
  }

  nextBool(): boolean {
    if (this.bitIndex === 32) {
      this.bitBuffer = this.nextUInt();
      this.bitIndex = 1;
      return (this.bitBuffer & 1) === 1;
    }
    this.bitIndex++;
    this.bitBuffer = this.bitBuffer >>> 1;
    return (this.bitBuffer & 1) === 1;
  }
}
