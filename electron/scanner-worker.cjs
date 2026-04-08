const { parentPort, workerData } = require("worker_threads");
const { scanProject } = require("./scanner.cjs");

try {
  const result = scanProject(
    workerData.projectRoot,
    (progress) => parentPort.postMessage({ type: "progress", progress }),
    { cacheDir: workerData.cacheDir },
  );
  parentPort.postMessage({ type: "done", result });
} catch (error) {
  parentPort.postMessage({
    type: "error",
    error: error instanceof Error ? error.message : String(error),
  });
}
