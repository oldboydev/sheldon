#!/usr/bin/env bash
set -euo pipefail

platform=''
output=''
while (($# > 0)); do
  case "$1" in
    --platform) platform="${2:-}"; shift 2 ;;
    --output) output="${2:-}"; shift 2 ;;
    *) printf '%s\n' 'OCR_RUNTIME_ARGUMENTS_INVALID: Use --platform <darwin-x64|darwin-arm64> --output <directory>.' >&2; exit 1 ;;
  esac
done

case "$platform" in
  darwin-x64|darwin-arm64) ;;
  *) printf 'OCR_RUNTIME_PLATFORM_INVALID: macOS builder does not support %s.\n' "$platform" >&2; exit 1 ;;
esac
[[ -n "$output" ]] || { printf '%s\n' 'OCR_RUNTIME_ARGUMENTS_INVALID: --output is required.' >&2; exit 1; }

expected_arch='x86_64'
[[ "$platform" == 'darwin-arm64' ]] && expected_arch='arm64'
[[ "$(uname -m)" == "$expected_arch" ]] || {
  printf 'OCR_RUNTIME_PLATFORM_INVALID: %s must be built on %s.\n' "$platform" "$expected_arch" >&2
  exit 1
}
command -v brew >/dev/null || { printf '%s\n' 'OCR_RUNTIME_DEPENDENCY_INVALID: Homebrew is required.' >&2; exit 1; }
command -v cmake >/dev/null || { printf '%s\n' 'OCR_RUNTIME_DEPENDENCY_INVALID: cmake is required.' >&2; exit 1; }
command -v ninja >/dev/null || { printf '%s\n' 'OCR_RUNTIME_DEPENDENCY_INVALID: ninja is required.' >&2; exit 1; }

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
sources_json="$(cd "$repository_root" && node --input-type=module --eval "import { OCR_RUNTIME_SOURCES } from './scripts/release/ocr-runtime-sources.mjs'; process.stdout.write(JSON.stringify(OCR_RUNTIME_SOURCES));")"
source_values=()
while IFS= read -r value; do
  source_values+=("$value")
done < <(node --input-type=module --eval "const s=JSON.parse(process.argv[1]); for (const x of [s.tesseract.url,s.tesseract.revision,s.tesseract.sha256,s.models.eng.url,s.models.eng.sha256,s.models.eng.licenseSource,s.models.eng.licenseSha256,s.models.por.url,s.models.por.sha256]) console.log(x);" "$sources_json")
tesseract_url="${source_values[0]}"; tesseract_revision="${source_values[1]}"; tesseract_sha="${source_values[2]}"
eng_url="${source_values[3]}"; eng_sha="${source_values[4]}"; model_license_url="${source_values[5]}"; model_license_sha="${source_values[6]}"
por_url="${source_values[7]}"; por_sha="${source_values[8]}"

output="$(python3 -c 'import os,sys; print(os.path.abspath(sys.argv[1]))' "$output")"
if [[ -e "$output" ]] && [[ -n "$(find "$output" -mindepth 1 -maxdepth 1 -print -quit)" ]]; then
  printf 'OCR_RUNTIME_OUTPUT_INVALID: Output directory must be empty: %s\n' "$output" >&2
  exit 1
fi
mkdir -p "$output"
work_root="$(mktemp -d "${TMPDIR:-/tmp}/sheldon-ocr-macos.XXXXXX")"
trap 'rm -rf "$work_root"' EXIT
source_root="$work_root/source"; models_root="$work_root/models"
runtime_root="$output/runtime/$platform"; library_root="$runtime_root/lib"; data_root="$output/data/tessdata"
mkdir -p "$source_root" "$models_root" "$library_root" "$data_root"

download_pinned() {
  local url="$1" destination="$2" expected_hash="$3"
  curl --fail --location --proto '=https' --retry 5 --show-error "$url" --output "$destination"
  [[ "$(shasum -a 256 "$destination" | awk '{print $1}')" == "$expected_hash" ]] || {
    printf 'OCR_RUNTIME_CHECKSUM_INVALID: SHA-256 mismatch for %s\n' "$url" >&2
    exit 1
  }
}

download_pinned "$tesseract_url" "$work_root/tesseract.tar.gz" "$tesseract_sha"
download_pinned "$eng_url" "$models_root/eng.traineddata" "$eng_sha"
download_pinned "$por_url" "$models_root/por.traineddata" "$por_sha"
tar --extract --gzip --file "$work_root/tesseract.tar.gz" --directory "$source_root" --strip-components=1
cp "$models_root/eng.traineddata" "$data_root/eng.traineddata"
cp "$models_root/por.traineddata" "$data_root/por.traineddata"

leptonica_prefix="$(brew --prefix leptonica)"
PKG_CONFIG_PATH="$leptonica_prefix/lib/pkgconfig${PKG_CONFIG_PATH:+:$PKG_CONFIG_PATH}" \
cmake -S "$source_root" -B "$work_root/build" -G Ninja \
  -DCMAKE_BUILD_TYPE=Release \
  -DBUILD_SHARED_LIBS=ON \
  -DBUILD_TESTS=OFF \
  -DBUILD_TRAINING_TOOLS=OFF \
  -DDISABLE_ARCHIVE=ON \
  -DDISABLE_CURL=ON \
  -DENABLE_NATIVE=OFF \
  -DGRAPHICS_DISABLED=ON \
  -DOPENMP_BUILD=OFF
cmake --build "$work_root/build" --target tesseract --parallel
built_executable="$(find "$work_root/build" -type f -name tesseract -perm -111 -print -quit)"
[[ -n "$built_executable" ]] || { printf '%s\n' 'OCR_RUNTIME_BUILD_FAILED: Tesseract executable was not produced.' >&2; exit 1; }
executable="$runtime_root/tesseract"
cp "$built_executable" "$executable"

is_system_library() {
  [[ "$1" == /System/Library/* || "$1" == /usr/lib/* ]]
}
canonical_path() {
  python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$1"
}
resolve_cellar_library_path() {
  local library_source="$1" library_name="$2" cellar="$3" candidate_file="$4"
  [[ "$library_source" == "$cellar/"* ]] && {
    printf '%s\n' "$library_source"
    return
  }

  if ! find "$cellar" \( -type f -o -type l \) -name "$library_name" -print0 > "$candidate_file"; then
    printf 'OCR_RUNTIME_NOTICES_INVALID: Unable to traverse the Homebrew Cellar for %s.\n' "$library_source" >&2
    return 1
  fi

  local cellar_candidate canonical_candidate cmp_status
  local -a cellar_matches=()
  while IFS= read -r -d '' cellar_candidate; do
    if ! canonical_candidate="$(canonical_path "$cellar_candidate")"; then
      printf 'OCR_RUNTIME_NOTICES_INVALID: Unable to canonicalize Homebrew Cellar candidate %s.\n' \
        "$cellar_candidate" >&2
      return 1
    fi
    if [[ "$canonical_candidate" != "$cellar/"* || ! -f "$canonical_candidate" ]]; then
      printf 'OCR_RUNTIME_NOTICES_INVALID: Homebrew Cellar candidate does not resolve inside the Homebrew Cellar: %s.\n' \
        "$cellar_candidate" >&2
      return 1
    fi
    if cmp -s "$library_source" "$canonical_candidate"; then
      cellar_matches+=("$canonical_candidate")
    else
      cmp_status=$?
      if (( cmp_status > 1 )); then
        printf 'OCR_RUNTIME_NOTICES_INVALID: Unable to compare Homebrew library %s with Cellar file %s.\n' \
          "$library_source" "$canonical_candidate" >&2
        return 1
      fi
    fi
  done < "$candidate_file"

  (( ${#cellar_matches[@]} == 1 )) || {
    printf 'OCR_RUNTIME_NOTICES_INVALID: Homebrew library did not resolve to exactly one byte-identical Cellar file: %s.\n' \
      "$library_source" >&2
    return 1
  }
  printf '%s\n' "${cellar_matches[0]}"
}

visited=$'\n'
library_names=()
library_paths=()
queue=("$built_executable")
while ((${#queue[@]} > 0)); do
  candidate="${queue[0]}"; queue=("${queue[@]:1}")
  candidate="$(canonical_path "$candidate")"
  [[ "$visited" == *$'\n'"$candidate"$'\n'* ]] && continue
  visited+="$candidate"$'\n'
  while IFS= read -r dependency; do
    [[ -z "$dependency" ]] && continue
    is_system_library "$dependency" && continue
    dependency_name="$(basename "$dependency")"
    if [[ "$dependency" == /* ]] && [[ -f "$dependency" ]]; then
      resolved_dependency="$(canonical_path "$dependency")"
    else
      resolved_dependency="$(find "$work_root/build" "$(brew --prefix)" \( -type f -o -type l \) -name "$dependency_name" -print -quit)"
    fi
    [[ -n "${resolved_dependency:-}" && -f "$resolved_dependency" ]] || {
      printf 'OCR_RUNTIME_DEPENDENCY_INVALID: Unable to resolve %s used by %s.\n' "$dependency" "$candidate" >&2
      exit 1
    }
    destination="$library_root/$dependency_name"
    if [[ ! -f "$destination" ]]; then
      cp "$resolved_dependency" "$destination"
      library_names+=("$dependency_name")
      library_paths+=("$resolved_dependency")
    fi
    queue+=("$resolved_dependency")
  done < <(otool -L "$candidate" | tail -n +2 | sed -E 's/^[[:space:]]*([^[:space:]]+).*/\1/')
done
(( ${#library_names[@]} > 0 )) || { printf '%s\n' 'OCR_RUNTIME_DEPENDENCY_INVALID: No private dylibs were packaged.' >&2; exit 1; }

dependency_names=()
dependency_versions=()
dependency_libraries=()
if ! cellar="$(brew --cellar)"; then
  printf '%s\n' 'OCR_RUNTIME_NOTICES_INVALID: Unable to determine the Homebrew Cellar.' >&2
  exit 1
fi
[[ -n "$cellar" && -d "$cellar" ]] || {
  printf '%s\n' 'OCR_RUNTIME_NOTICES_INVALID: Homebrew Cellar is unavailable.' >&2
  exit 1
}
cellar="$(canonical_path "$cellar")"
for index in "${!library_names[@]}"; do
  library_name="${library_names[$index]}"
  library_source="${library_paths[$index]}"
  [[ "$library_source" == "$work_root/build/"* ]] && continue

  if ! library_source="$(resolve_cellar_library_path "$library_source" "$library_name" "$cellar" "$work_root/cellar-candidates-$index")"; then
    exit 1
  fi
  cellar_relative="${library_source#"$cellar/"}"
  formula_name="${cellar_relative%%/*}"
  version_and_path="${cellar_relative#*/}"
  installed_version="${version_and_path%%/*}"
  nested_path="${version_and_path#*/}"
  if [[ "$formula_name" == "$cellar_relative" || "$installed_version" == "$version_and_path" || -z "$nested_path" || \
    ! "$formula_name" =~ ^[A-Za-z0-9][A-Za-z0-9@+_.-]*$ || ! "$installed_version" =~ ^[A-Za-z0-9][A-Za-z0-9+_.-]*$ ]]; then
    printf 'OCR_RUNTIME_NOTICES_INVALID: Homebrew Cellar path is invalid: %s.\n' "$library_source" >&2
    exit 1
  fi
  if ! formula_info="$(brew info --json=v2 --installed "$formula_name")"; then
    printf 'OCR_RUNTIME_NOTICES_INVALID: Unable to read installed Homebrew metadata for %s.\n' "$formula_name" >&2
    exit 1
  fi
  if ! formula_identity="$(
    node --input-type=module --eval '
      const info = JSON.parse(process.argv[1]);
      const requested = process.argv[2];
      const expectedVersion = process.argv[3];
      const formula = info.formulae?.find(
        (candidate) => candidate.name === requested || candidate.full_name === requested,
      );
      const installed = formula?.installed ?? [];
      const selected = installed.find(({ version }) => version === expectedVersion);
      if (!formula?.name || typeof selected?.version !== "string" || selected.version.length === 0) process.exit(1);
      process.stdout.write(`${formula.name}\t${selected.version}`);
    ' "$formula_info" "$formula_name" "$installed_version"
  )"; then
    printf 'OCR_RUNTIME_NOTICES_INVALID: Installed Homebrew version is ambiguous for %s.\n' "$library_source" >&2
    exit 1
  fi
  IFS=$'\t' read -r installed_name installed_version <<<"$formula_identity"

  dependency_index=-1
  for candidate_index in "${!dependency_names[@]}"; do
    if [[ "${dependency_names[$candidate_index]}" == "$installed_name" && "${dependency_versions[$candidate_index]}" == "$installed_version" ]]; then
      dependency_index="$candidate_index"
      break
    fi
  done
  if (( dependency_index < 0 )); then
    dependency_names+=("$installed_name")
    dependency_versions+=("$installed_version")
    dependency_libraries+=("$library_name")
  else
    dependency_libraries[$dependency_index]="${dependency_libraries[$dependency_index]}, $library_name"
  fi
done
(( ${#dependency_names[@]} > 0 )) || {
  printf '%s\n' 'OCR_RUNTIME_NOTICES_INVALID: No Homebrew ownership was found for bundled private dylibs.' >&2
  exit 1
}

for candidate in "$executable" "$library_root"/*; do
  while IFS= read -r dependency; do
    is_system_library "$dependency" && continue
    replacement="@rpath/$(basename "$dependency")"
    [[ "$dependency" == "$replacement" ]] || install_name_tool -change "$dependency" "$replacement" "$candidate"
  done < <(otool -L "$candidate" | tail -n +2 | sed -E 's/^[[:space:]]*([^[:space:]]+).*/\1/')
done
install_name_tool -add_rpath '@loader_path/lib' "$executable"
for library in "$library_root"/*; do
  install_name_tool -id "@rpath/$(basename "$library")" "$library"
  install_name_tool -add_rpath '@loader_path' "$library"
done
if otool -L "$executable" "$library_root"/* | grep -E '/(opt/homebrew|usr/local)/(Cellar|opt|Homebrew)/'; then
  printf '%s\n' 'OCR_RUNTIME_DEPENDENCY_INVALID: A Homebrew path escaped the private macOS runtime.' >&2
  exit 1
fi

model_license_url="$(
  node --input-type=module --eval "
    const url = new URL(process.argv[1]);
    if (url.protocol !== 'https:' || url.hostname !== 'github.com') process.exit(1);
    url.hostname = 'raw.githubusercontent.com';
    url.pathname = url.pathname.replace('/blob/', '/');
    process.stdout.write(url.href);
  " "$model_license_url"
)"
download_pinned "$model_license_url" "$work_root/tessdata-LICENSE" "$model_license_sha"
[[ -s "$source_root/LICENSE" && -s "$work_root/tessdata-LICENSE" ]] || {
  printf '%s\n' 'OCR_RUNTIME_NOTICES_INVALID: Required upstream license text is missing.' >&2
  exit 1
}

homebrew_notices="$work_root/homebrew-notices"
: > "$homebrew_notices"
for dependency_index in "${!dependency_names[@]}"; do
  installed_name="${dependency_names[$dependency_index]}"
  installed_version="${dependency_versions[$dependency_index]}"
  printf 'OCR_RUNTIME_DEPENDENCY: provider=homebrew name=%s version=%s\n' "$installed_name" "$installed_version" >&2
  if ! dependency_json="$(
    cd "$repository_root" && node --input-type=module --eval '
      import { findOcrRuntimeDependency } from "./scripts/release/ocr-runtime-dependency-inventory.mjs";
      process.stdout.write(JSON.stringify(findOcrRuntimeDependency(process.argv[1], process.argv[2], process.argv[3])));
    ' homebrew "$installed_name" "$installed_version"
  )"; then
    printf 'OCR_RUNTIME_NOTICES_INVALID: No pinned dependency record for homebrew/%s@%s.\n' "$installed_name" "$installed_version" >&2
    exit 1
  fi

  dependency_values=()
  while IFS= read -r value; do
    dependency_values+=("$value")
  done < <(
    node --input-type=module --eval '
      const dependency = JSON.parse(process.argv[1]);
      for (const key of ["provider", "name", "version", "spdx", "sourceUrl", "sourceSha256"])
        console.log(dependency[key]);
      console.log(JSON.stringify(dependency.licenses));
    ' "$dependency_json"
  )
  (( ${#dependency_values[@]} == 7 )) || {
    printf 'OCR_RUNTIME_NOTICES_INVALID: Pinned dependency record is incomplete for homebrew/%s@%s.\n' "$installed_name" "$installed_version" >&2
    exit 1
  }
  provider="${dependency_values[0]}"; dependency_name="${dependency_values[1]}"; dependency_version="${dependency_values[2]}"
  dependency_spdx="${dependency_values[3]}"; source_url="${dependency_values[4]}"; source_sha256="${dependency_values[5]}"
  licenses_json="${dependency_values[6]}"

  dependency_archive="$work_root/dependency-$dependency_index.source"
  dependency_root="$work_root/dependency-$dependency_index"
  mkdir -p "$dependency_root"
  download_pinned "$source_url" "$dependency_archive" "$source_sha256"
  tar --extract --file "$dependency_archive" --directory "$dependency_root" || {
    printf 'OCR_RUNTIME_NOTICES_INVALID: Unable to extract pinned source for %s/%s@%s.\n' "$provider" "$dependency_name" "$dependency_version" >&2
    exit 1
  }
  {
    printf '== %s package: %s@%s ==\n' "$provider" "$dependency_name" "$dependency_version"
    printf 'Provider: %s\nPackage: %s\nVersion: %s\nSPDX: %s\n' "$provider" "$dependency_name" "$dependency_version" "$dependency_spdx"
    printf 'Source: %s\nSource SHA-256: %s\n' "$source_url" "$source_sha256"
    printf 'Private dylibs: %s\n\n' "${dependency_libraries[$dependency_index]}"
    while IFS= read -r license_json; do
      license_values=()
      while IFS= read -r value; do
        license_values+=("$value")
      done < <(
        node --input-type=module --eval '
          const license = JSON.parse(process.argv[1]);
          for (const key of ["path", "sha256", "spdx"]) console.log(license[key]);
        ' "$license_json"
      )
      (( ${#license_values[@]} == 3 )) || {
        printf 'OCR_RUNTIME_NOTICES_INVALID: Pinned license record is incomplete for %s/%s@%s.\n' "$provider" "$dependency_name" "$dependency_version" >&2
        exit 1
      }
      license_path="${license_values[0]}"; license_sha256="${license_values[1]}"; license_spdx="${license_values[2]}"
      if ! license_file="$(python3 -c '
import os, sys
root, expected = sys.argv[1], sys.argv[2].replace("\\\\", "/")
matches = []
for directory, _, files in os.walk(root):
    for filename in files:
        path = os.path.join(directory, filename)
        relative = os.path.relpath(path, root).replace("\\\\", "/")
        if relative == expected or relative.endswith("/" + expected):
            matches.append(path)
if len(matches) != 1:
    sys.exit(1)
print(matches[0])
' "$dependency_root" "$license_path")"; then
        printf 'OCR_RUNTIME_NOTICES_INVALID: Pinned license path %s did not resolve uniquely for %s/%s@%s.\n' \
          "$license_path" "$provider" "$dependency_name" "$dependency_version" >&2
        exit 1
      fi
      [[ "$(shasum -a 256 "$license_file" | awk '{print $1}')" == "$license_sha256" ]] || {
        printf 'OCR_RUNTIME_NOTICES_INVALID: License SHA-256 mismatch for %s/%s@%s.\n' "$provider" "$dependency_name" "$dependency_version" >&2
        exit 1
      }
      [[ -s "$license_file" ]] || {
        printf 'OCR_RUNTIME_NOTICES_INVALID: Verified license text is empty for %s/%s@%s.\n' "$provider" "$dependency_name" "$dependency_version" >&2
        exit 1
      }
      printf 'License SPDX: %s\nLicense path: %s\nLicense SHA-256: %s\n\n' "$license_spdx" "$license_path" "$license_sha256"
      cat "$license_file"
      printf '\n\n'
    done < <(
      node --input-type=module --eval '
        for (const license of JSON.parse(process.argv[1])) console.log(JSON.stringify(license));
      ' "$licenses_json"
    )
  } >> "$homebrew_notices"
done

{
  printf 'Sheldon OCR runtime third-party notices\n\nPlatform: %s\n' "$platform"
  printf 'Tesseract source: %s\nRevision: %s\nSHA-256: %s\n\n== Tesseract OCR ==\n' "$tesseract_url" "$tesseract_revision" "$tesseract_sha"
  cat "$source_root/LICENSE"
  printf '\n\n== tessdata_fast base models ==\neng source: %s\npor source: %s\nlicense source: %s\nlicense SHA-256: %s\n' \
    "$eng_url" "$por_url" "$model_license_url" "$model_license_sha"
  cat "$work_root/tessdata-LICENSE"
  printf '\n\n== Bundled macOS dylibs ==\n'
  printf -- '- %s\n' "${library_names[@]}"
  printf '\n== Verified Homebrew package licenses ==\n'
  cat "$homebrew_notices"
} > "$runtime_root/THIRD_PARTY_NOTICES"
[[ -s "$runtime_root/THIRD_PARTY_NOTICES" ]] || { printf '%s\n' 'OCR_RUNTIME_NOTICES_INVALID: Notices are empty.' >&2; exit 1; }

health="$(DYLD_FALLBACK_LIBRARY_PATH="$library_root" "$executable" --tessdata-dir "$data_root" --list-langs)"
grep -qx 'eng' <<<"$health"
grep -qx 'por' <<<"$health"
