"""Pack an already-built candidate into a NEW disposable directory; never publish."""
import argparse
import base64
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import tarfile

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("output", type=Path, help="New, absent task-owned directory outside the source tree")
args = parser.parse_args()
root = Path(__file__).resolve().parents[3]
output = args.output.resolve()
if output == root or root in output.parents:
    parser.error("Output must be outside the source tree")
output.mkdir(parents=True, exist_ok=False)
stage = output / "stage"
stage.mkdir()
excluded = "docs/architecture/postgresql-entity-provider-p1-plan.md"


def copy(source, target):
    if source.is_symlink() or source.relative_to(root).as_posix() == excluded:
        return
    if source.is_dir():
        target.mkdir(exist_ok=True)
        for child in source.iterdir():
            copy(child, target / child.name)
    elif source.is_file():
        shutil.copy2(source, target)


package = json.loads((root / "package.json").read_text())
for name in [*package["files"], "package.json"]:
    path = Path(name)
    if path.is_absolute() or ".." in path.parts:
        parser.error("Unsafe package file path")
    copy(root / path, stage / path)
if not (stage / "dist/index.js").is_file():
    parser.error("Build the source before packing")
fixture = json.loads((Path(__file__).parent / "consumer/package.json").read_text())
allowed = {"@xpell/core", "@xpell/node-core", "@xpell/mcp", "@xpell/vibe", "@xpell/file-service"}
resolved = {}
for name, value in package["dependencies"].items():
    if value.startswith("workspace:"):
        if name not in allowed or value != "workspace:*":
            parser.error("Unreviewed workspace packaging dependency")
        resolved[name] = {"from": value, "to": fixture["dependencies"][name]}
        package["dependencies"][name] = fixture["dependencies"][name]
(stage / "package.json").write_text(json.dumps(package, indent=2) + "\n")
result = subprocess.run(["npm", "pack", "--offline", "--ignore-scripts", "--json", "--cache", str(output / "npm-cache"), "--pack-destination", str(output)],
                        cwd=stage, check=True, capture_output=True, text=True)
metadata = json.loads(result.stdout)
(output / "pack-result.json").write_text(json.dumps(metadata, indent=2) + "\n")
archive = output / metadata[0]["filename"]
data = archive.read_bytes()
sha = lambda data: hashlib.sha256(data).hexdigest()
dist = {p.relative_to(root / "dist").as_posix(): sha(p.read_bytes())
        for p in (root / "dist").rglob("*") if p.is_file() and not p.is_symlink()}
with tarfile.open(archive) as packed:
    assert not any(m.issym() or m.islnk() or m.name == "package/" + excluded for m in packed.getmembers())
    for name, expected in dist.items():
        assert sha(packed.extractfile("package/dist/" + name).read()) == expected, name
assert metadata[0]["integrity"] == "sha512-" + base64.b64encode(hashlib.sha512(data).digest()).decode()
provenance = {"archiveSHA256": sha(data), "workspacePackagingResolution": resolved, "distSHA256": dist,
              "sourcePackageSHA256": sha((root / "package.json").read_bytes()),
              "stagedPackageSHA256": sha((stage / "package.json").read_bytes()),
              "fixtureLockSHA256": sha((Path(__file__).parent / "consumer/package-lock.json").read_bytes()),
              "excludedLocalReviewArtifact": excluded, "excludedExternalSymlinks": True}
(output / "provenance.json").write_text(json.dumps(provenance, indent=2) + "\n")
print(json.dumps({"archive": str(archive), "sha256": sha(data), "verifiedDistFiles": len(dist)}))
