/** Integer half-open ranges: no dropped or duplicated boundary frames. */
export function frameRange(frames: number, segment: number, jobs: number, warmup = false): [number, number] {
  // Warm-up ticks cost ~3% of captured frames in native profiles. Slightly
  // shorter later partitions offset their increasing replay-history cost.
  const boundary = (index: number) => Math.floor(frames * (warmup && jobs > 1
    ? (1 - 0.97 ** index) / (1 - 0.97 ** jobs)
    : index / jobs));
  return [boundary(segment), boundary(segment + 1)];
}
