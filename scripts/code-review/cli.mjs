import { parseArgs, review, check, createPr } from "./review.mjs";

try {
  const options = parseArgs(process.argv.slice(2));
  const cwd = process.cwd();
  if (options.command === "review") {
    const report = await review(cwd, options);
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
    if (report.status !== "ready") process.exitCode = 2;
  } else if (options.command === "check") {
    const result = await check(cwd, options);
    process.stdout.write(`Revisão válida: ${result.snapshot.head}\n`);
  } else {
    process.stdout.write(String(await createPr(cwd, options)) + "\n");
  }
} catch (error) {
  process.stderr.write(`Code review interrompido: ${error.message}\n`);
  process.exitCode = 1;
}
