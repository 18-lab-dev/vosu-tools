/** A count and its noun: `1 image`, `2 images` (`many`: an irregular plural). */
export const plural = (n: number, word: string, many = `${word}s`) =>
  `${n} ${n === 1 ? word : many}`;
