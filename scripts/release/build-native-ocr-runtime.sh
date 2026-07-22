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
done < <(node --input-type=module --eval "const s=JSON.parse(process.argv[1]); for (const x of [s.tesseract.url,s.tesseract.revision,s.tesseract.sha256,s.models.eng.url,s.models.eng.sha256,s.models.eng.licenseSource,s.models.por.url,s.models.por.sha256]) console.log(x);" "$sources_json")
tesseract_url="${source_values[0]}"; tesseract_revision="${source_values[1]}"; tesseract_sha="${source_values[2]}"
eng_url="${source_values[3]}"; eng_sha="${source_values[4]}"; model_license_url="${source_values[5]}"
por_url="${source_values[6]}"; por_sha="${source_values[7]}"

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
      resolved_dependency="$(find "$work_root/build" "$(brew --prefix)" -type f -name "$dependency_name" -print -quit)"
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

model_license_url="${model_license_url/https:\/\/github.com\//https:\/\/raw.githubusercontent.com\/}"
model_license_url="${model_license_url/\/blob\//\/}"
curl --fail --location --proto '=https' --retry 5 --show-error "$model_license_url" --output "$work_root/tessdata-LICENSE"
[[ -s "$source_root/LICENSE" && -s "$work_root/tessdata-LICENSE" ]] || {
  printf '%s\n' 'OCR_RUNTIME_NOTICES_INVALID: Required upstream license text is missing.' >&2
  exit 1
}
{
  printf 'Sheldon OCR runtime third-party notices\n\nPlatform: %s\n' "$platform"
  printf 'Tesseract source: %s\nRevision: %s\nSHA-256: %s\n\n== Tesseract OCR ==\n' "$tesseract_url" "$tesseract_revision" "$tesseract_sha"
  cat "$source_root/LICENSE"
  printf '\n\n== tessdata_fast base models ==\neng source: %s\npor source: %s\n' "$eng_url" "$por_url"
  cat "$work_root/tessdata-LICENSE"
  for index in "${!library_names[@]}"; do
    name="${library_names[$index]}"
    library_source="${library_paths[$index]}"
    if [[ "$library_source" == "$work_root/build/"* ]]; then
      license_file="$source_root/LICENSE"
    else
      license_file="$(find "$(dirname "$(dirname "$library_source")")" -maxdepth 2 -type f \( -iname 'LICENSE*' -o -iname 'COPYING*' -o -iname 'NOTICE*' \) -print -quit)"
    fi
    [[ -n "$license_file" && -s "$license_file" ]] || {
      printf 'OCR_RUNTIME_NOTICES_INVALID: License text is missing for %s.\n' "$library_source" >&2
      exit 1
    }
    printf '\n\n== %s ==\n' "$name"
    cat "$license_file"
  done
} > "$runtime_root/THIRD_PARTY_NOTICES"
[[ -s "$runtime_root/THIRD_PARTY_NOTICES" ]] || { printf '%s\n' 'OCR_RUNTIME_NOTICES_INVALID: Notices are empty.' >&2; exit 1; }

health="$(DYLD_FALLBACK_LIBRARY_PATH="$library_root" "$executable" --tessdata-dir "$data_root" --list-langs)"
grep -qx 'eng' <<<"$health"
grep -qx 'por' <<<"$health"
