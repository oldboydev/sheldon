import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const DOCUMENTATION_PATTERNS = [
  ".checks/**",
  ".tasks/**",
  "docs/**",
  "CLAUDE.md",
  "AGENTS.md",
  "README.md",
  "CHANGELOG.md",
  "CONTRIBUTING.md",
  "GROK.md",
  ".github/ISSUE_TEMPLATE/**",
  ".github/pull_request_template.md",
];

export function requiresVerification(files) {
  return (
    files === null ||
    files.length === 0 ||
    files.some(
      (file) =>
        !DOCUMENTATION_PATTERNS.some((pattern) =>
          pattern.endsWith("/**")
            ? file.startsWith(pattern.slice(0, -2))
            : file === pattern,
        ),
    )
  );
}

export function changedFiles(
  eventName,
  event,
  runGit = (args) =>
    execFileSync("git", args, {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    }),
) {
  if (eventName === "workflow_dispatch") return null;
  let base;
  let head;
  let separator;
  if (eventName === "pull_request") {
    base = event.pull_request?.base?.sha;
    head = event.pull_request?.head?.sha;
    separator = "...";
  } else if (eventName === "push") {
    base = event.before;
    head = event.after;
    separator = "..";
  } else {
    throw new Error("Evento de CI não reconhecido");
  }
  if (
    ![base, head].every(
      (sha) => typeof sha === "string" && /^[a-f0-9]{40}$/.test(sha),
    )
  ) {
    throw new Error("Referências de CI inválidas");
  }
  if (base === "0".repeat(40)) return null;
  // Sem renomes: mover código para docs também precisa validar a exclusão do código.
  return runGit([
    "diff",
    "--no-renames",
    "--name-only",
    "-z",
    base + separator + head,
    "--",
  ])
    .split("\0")
    .filter(Boolean);
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
  const code = requiresVerification(
    changedFiles(process.env.GITHUB_EVENT_NAME, event),
  );
  appendFileSync(process.env.GITHUB_OUTPUT, "code=" + code + "\n");
  console.log(
    code
      ? "Verificação completa necessária."
      : "Somente documentação: validação das ferramentas dispensada intencionalmente.",
  );
}
