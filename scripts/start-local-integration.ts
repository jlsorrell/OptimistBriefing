import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";

import { exportJWK, generateKeyPair } from "jose";

const keyDirectory = ".wrangler";
const privateKeyPath = `${keyDirectory}/local-access-private.jwk`;

execFileSync("npm", ["run", "build"], { stdio: "inherit" });
execFileSync("npm", ["run", "seed:dev"], { stdio: "inherit" });

const keyPair = await generateKeyPair("RS256", { extractable: true });
const privateJwk = {
  ...(await exportJWK(keyPair.privateKey)),
  kid: "local-integration-key",
};
const publicJwk = {
  ...(await exportJWK(keyPair.publicKey)),
  kid: "local-integration-key",
};
mkdirSync(keyDirectory, { recursive: true });
writeFileSync(privateKeyPath, JSON.stringify(privateJwk), {
  encoding: "utf8",
  mode: 0o600,
});
const jwksBinding = Buffer.from(
  JSON.stringify({ keys: [publicJwk] }),
).toString("base64url");

const wrangler = spawn(
  "npx",
  [
    "wrangler",
    "dev",
    "--config",
    "wrangler.local.jsonc",
    "--local",
    "--ip",
    "127.0.0.1",
    "--port",
    "4173",
    "--var",
    `LOCAL_ACCESS_JWKS_B64:${jwksBinding}`,
  ],
  { stdio: "inherit" },
);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => wrangler.kill(signal));
}
wrangler.once("error", (error) => {
  throw error;
});
wrangler.once("exit", (code, signal) => {
  if (signal !== null) {
    process.kill(process.pid, signal);
    return;
  }
  process.exitCode = code ?? 1;
});
