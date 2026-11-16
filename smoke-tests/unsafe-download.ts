import { execSync } from "node:child_process";

// Intentionally vulnerable synthetic fixture.
// Never execute or deploy this file.
export function download(url: string) {
  return execSync(`curl ${url}`);
}
