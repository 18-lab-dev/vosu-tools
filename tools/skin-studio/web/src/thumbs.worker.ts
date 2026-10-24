// Explorer thumbnails: fetches a skin image, decodes it once and scales it
// down here, off the page's main thread. Only jobs for rows still on screen
// run; the newest request goes first.

interface Job {
  id: number;
  url: string;
  size: number;
}
type Message = { type: "job"; job: Job } | { type: "want"; ids: number[] };

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<Message>) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
};
const queue: Job[] = [];
let wanted = new Set<number>();
let running = 0;
const PARALLEL = 3;

scope.onmessage = ({ data }) => {
  if (data.type === "want") wanted = new Set(data.ids);
  else {
    queue.push(data.job);
    wanted.add(data.job.id);
  }
  pump();
};

function pump() {
  while (running < PARALLEL && queue.length) {
    const job = queue.pop()!;
    if (!wanted.has(job.id)) {
      scope.postMessage({ id: job.id, dropped: true });
      continue;
    }
    running++;
    void run(job).finally(() => {
      running--;
      pump();
    });
  }
}

async function run(job: Job) {
  try {
    const response = await fetch(job.url, { credentials: "omit" });
    if (!response.ok) throw new Error(`${response.status}`);
    const full = await createImageBitmap(await response.blob());
    const { width, height } = full;
    const scale = Math.min(1, job.size / Math.max(width, height, 1));
    const bitmap =
      scale < 1
        ? await createImageBitmap(full, {
            resizeWidth: Math.max(1, Math.round(width * scale)),
            resizeHeight: Math.max(1, Math.round(height * scale)),
            resizeQuality: "medium",
          })
        : full;
    if (bitmap !== full) full.close();
    scope.postMessage({ id: job.id, bitmap, width, height }, [bitmap]);
  } catch (error) {
    scope.postMessage({ id: job.id, error: String(error) });
  }
}
