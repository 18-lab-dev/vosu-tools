// `.osu` files are imported as text (`?raw`, supported by Vite and Bun).
declare module "*.osu?raw" {
  const text: string;
  export default text;
}
