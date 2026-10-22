declare module "lzma/src/lzma-d.js" {
  const codec: {
    LZMA: {
      decompress(
        bytes: number[],
        callback: (result: string | number[] | null, error?: Error) => void,
      ): void;
    };
  };
  export default codec;
}
