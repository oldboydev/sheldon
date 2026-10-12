import path from "node:path";
import { fileURLToPath } from "node:url";

export function ciPassed(detectionResult, codeChanged, verificationResult) {
  return (
    detectionResult === "success" &&
    ((codeChanged === "true" && verificationResult === "success") ||
      (codeChanged === "false" && verificationResult === "skipped"))
  );
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const passed = ciPassed(
    process.env.DETECTION_RESULT,
    process.env.CODE_CHANGED,
    process.env.VERIFY_RESULT,
  );
  console.log(
    passed
      ? process.env.CODE_CHANGED === "false"
        ? "CI aprovada: somente documentação; validação das ferramentas dispensada intencionalmente."
        : "CI aprovada: verificação completa concluída."
      : "CI reprovada: detecção ou verificação incompleta.",
  );
  process.exitCode = passed ? 0 : 1;
}
