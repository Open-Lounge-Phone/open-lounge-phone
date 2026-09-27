// Copies the built companion app to ./public and the device emulator to ./public/device.
import { cpSync, existsSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const companion = here("../../companion/dist");
const device = here("../../device-web/dist");
const out = here("../public");

for (const dir of [companion, device]) {
  if (!existsSync(dir)) {
    console.error(`${dir} is missing; run \`npm run build\` at the repository root first.`);
    process.exit(1);
  }
}
rmSync(out, { recursive: true, force: true });
cpSync(companion, out, { recursive: true });
cpSync(device, `${out}/device`, { recursive: true });
console.log(`assembled static assets in ${out}`);
