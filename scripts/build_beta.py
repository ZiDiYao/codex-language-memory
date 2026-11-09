"""Build a self-contained Apple Silicon Beta ZIP and its integrity manifest."""

import argparse
import hashlib
import importlib.metadata
import json
import platform
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from installer import inventory, version_key


def command_file(action):
    argument = ' --package "$package_dir"' if action == "install" else ""
    return f'''#!/bin/bash
set -u
package_dir="$(cd -- "$(dirname -- "$0")" && pwd)"
if [[ "$(uname -s)" != "Darwin" || "$(uname -m)" != "arm64" ]]; then
  echo "This Beta requires an Apple Silicon Mac (M1 or later)."
  exit 1
fi
"$package_dir/runtime/language-memory" {action}{argument} "$@"
result=$?
if [[ -t 0 ]]; then
  echo
  if [[ $result -ne 0 ]]; then echo "The operation did not complete. Review the message above."; fi
  read -r -p "Press Return to close this window. " reply
fi
exit "$result"
'''


def write_notices(package):
    notices = package / "THIRD-PARTY-NOTICES"
    notices.mkdir()
    versions = {}
    # Copy installed distribution licenses, including native dependency notices.
    for distribution in importlib.metadata.distributions():
        name = distribution.metadata.get("Name", "unknown")
        versions[name] = distribution.version
        for entry in distribution.files or []:
            if any(part.lower().startswith(("license", "licence", "copying", "notice")) for part in entry.parts):
                source = Path(distribution.locate_file(entry))
                if source.is_file():
                    destination = notices / name / str(entry)
                    destination.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copyfile(source, destination)
    candidates = (Path(sys.base_prefix) / "LICENSE.txt",
                  Path(sys.base_prefix) / "lib" / f"python{sys.version_info.major}.{sys.version_info.minor}" / "LICENSE.txt")
    python_license = next((entry for entry in candidates if entry.is_file()), None)
    if python_license is None:
        raise SystemExit("A full Python license file is required to distribute the runtime.")
    shutil.copyfile(python_license, notices / "PYTHON-LICENSE.txt")
    # The native sidebar HTML bundles the MCP Apps SDK and its JS dependencies.
    for license_file in (ROOT / "node_modules").rglob("*"):
        if license_file.is_file() and license_file.name.lower().startswith(("license", "licence", "copying", "notice")):
            destination = notices / "javascript" / license_file.relative_to(ROOT / "node_modules")
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(license_file, destination)
    (package / "BUILD-DEPENDENCIES.json").write_text(json.dumps(versions, indent=2, sort_keys=True))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--skip-freeze", action="store_true", help="Reuse the already-built runtime when only package assets changed.")
    args = parser.parse_args()
    if (platform.system(), platform.machine()) != ("Darwin", "arm64"):
        raise SystemExit("Build this Beta on an Apple Silicon Mac.")
    version = (ROOT / "VERSION").read_text().strip()
    version_key(version)
    frozen = ROOT / "build" / "frozen"
    if not args.skip_freeze:
        subprocess.run(["npm", "run", "build"], cwd=ROOT, check=True)
        subprocess.run([
            sys.executable, "-m", "PyInstaller", "--noconfirm", "--clean", "--onedir",
            "--name", "language-memory", "--target-architecture", "arm64",
            "--distpath", str(frozen), "--workpath", str(ROOT / "build" / "pyinstaller"),
            "--specpath", str(ROOT / "build"), "--add-data", str(ROOT / "web") + ":web",
            "--collect-all", "docx", "--collect-data", "reportlab", "--collect-data", "certifi",
            "--recursive-copy-metadata", "mcp", "--copy-metadata", "fsrs",
            "--exclude-module", "tkinter", "--exclude-module", "pytest",
            str(ROOT / "release_runtime.py"),
        ], cwd=ROOT, check=True)
    output = ROOT / "dist"
    output.mkdir(exist_ok=True)
    package = output / f"language-memory-{version}-macos-arm64"
    if package.exists():
        shutil.rmtree(package)
    package.mkdir()
    shutil.copytree(frozen / "language-memory", package / "runtime", symlinks=True)
    shutil.copytree(ROOT / ".agents/skills/language-memory", package / "skills/language-memory")
    for filename in ("plugin.json", "mcp.json", "START-HERE.txt"):
        shutil.copyfile(ROOT / "packaging" / filename, package / filename)
    plugin = json.loads((package / "plugin.json").read_text())
    plugin["version"] = version
    (package / "plugin.json").write_text(json.dumps(plugin, indent=2) + "\n")
    for label, action in (("Install", "install"), ("Connect Extension", "connect-extension"), ("Check Installation", "status"), ("Roll Back", "rollback"), ("Uninstall", "uninstall")):
        entry = package / f"{label}.command"
        entry.write_text(command_file(action))
        entry.chmod(0o755)
    write_notices(package)
    metadata = {"format": 1, "name": "codex-language-memory", "version": version,
                "platform": "darwin-arm64", "python": platform.python_version(),
                "built_on": platform.mac_ver()[0], **inventory(package)}
    (package / "release.json").write_text(json.dumps(metadata, indent=2, sort_keys=True) + "\n")
    archive = output / (package.name + ".zip")
    archive.unlink(missing_ok=True)
    # ditto preserves the framework symlinks and executable permissions needed by PyInstaller.
    subprocess.run(["/usr/bin/ditto", "-c", "-k", "--keepParent", str(package), str(archive)], check=True)
    checksum = hashlib.sha256(archive.read_bytes()).hexdigest()
    (output / "SHA256SUMS.txt").write_text(f"{checksum}  {archive.name}\n")
    print(json.dumps({"package": str(package), "zip": str(archive), "bytes": archive.stat().st_size, "sha256": checksum}, indent=2))


if __name__ == "__main__":
    main()
