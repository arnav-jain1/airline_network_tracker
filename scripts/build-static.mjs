import { spawn } from "node:child_process";
import { resolve } from "node:path";

const projectRoot = resolve(import.meta.dirname, "..");
const baseArgument = process.argv.find((argument) => argument.startsWith("--base-path="));
const basePath = baseArgument ? baseArgument.slice("--base-path=".length) : "";
const npmExecutable = process.env.npm_execpath;
const buildCommand = npmExecutable
  ? process.execPath
  : process.platform === "win32"
    ? "npm.cmd"
    : "npm";
const buildArguments = npmExecutable
  ? [npmExecutable, "run", "build"]
  : ["run", "build"];

function run(command, args, environment = process.env, allowedExitCodes = [0]) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd: projectRoot,
      env: environment,
      stdio: "inherit",
      shell: process.platform === "win32" && !npmExecutable,
    });
    child.once("error", rejectPromise);
    child.once("exit", (code) => {
      if (allowedExitCodes.includes(code)) resolvePromise();
      else rejectPromise(new Error(`${command} exited with code ${code}`));
    });
  });
}

await run(
  buildCommand,
  buildArguments,
  {
    ...process.env,
    STATIC_EXPORT: "true",
    NEXT_PUBLIC_BASE_PATH: basePath,
  },
  process.platform === "win32"
    // Vinext currently hits a libuv shutdown assertion after it has finished
    // writing a valid static export on Windows. The exhaustive file check below
    // remains the source of truth; all other nonzero exits still fail.
    ? [0, 3221226505, -1073740791]
    : [0],
);
await run(process.execPath, [
  resolve(import.meta.dirname, "check-static-export.mjs"),
  basePath,
]);
