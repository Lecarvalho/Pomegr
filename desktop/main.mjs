if (process.argv.includes("--smoke")) await import("./smoke-main.mjs");
else await import("./shell-main.mjs");
