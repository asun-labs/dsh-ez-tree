"""Publish verified release attachments with credentials from Git's credential helper.

No credential values are written to stdout, files or child command arguments.
"""
import argparse
import hashlib
import json
import pathlib
import subprocess
import urllib.error
import urllib.parse
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parent.parent
REPOSITORY = "asun-labs/dsh-ez-tree"


def credential():
    result = subprocess.run(["git", "credential", "fill"], input="protocol=https\nhost=github.com\n\n", text=True, capture_output=True, check=True)
    values = dict(line.split("=", 1) for line in result.stdout.splitlines() if "=" in line)
    if not values.get("password"):
        raise RuntimeError("No GitHub credential available")
    return values["password"]


def main():
    parser = argparse.ArgumentParser(description="Publish exactly the locally verified dsh-ez-tree release bytes")
    parser.add_argument("action", choices=["create-repository", "publish", "verify"])
    args = parser.parse_args()
    token = credential()

    def request(path, data=None, method=None, content_type="application/json"):
        url = path if path.startswith("https://") else "https://api.github.com/" + path
        if isinstance(data, dict):
            data = json.dumps(data).encode()
        req = urllib.request.Request(url, data=data, method=method, headers={"Authorization": "Bearer " + token,
            "Accept": "application/vnd.github+json", "Content-Type": content_type, "User-Agent": "dsh-ez-tree-release"})
        with urllib.request.urlopen(req, timeout=600) as response:
            return json.load(response)

    if args.action == "create-repository":
        try:
            repo = request("repos/" + REPOSITORY)
        except urllib.error.HTTPError as error:
            if error.code != 404:
                raise
            repo = request("orgs/asun-labs/repos", {"name": "dsh-ez-tree", "description": "Complete EZ-Tree desktop editor, Seal/DSH integration, MCP and skills", "private": False, "auto_init": False})
        print(json.dumps({"url": repo["html_url"], "private": repo["private"]}))
        return

    package = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))
    version = package["version"]
    manifest = json.loads((ROOT / "releases/runtime.json").read_text(encoding="utf-8"))
    if manifest["version"] != version:
        raise RuntimeError("Version mismatch")
    tag = "v" + version
    release_path = f"repos/{REPOSITORY}/releases/tags/{tag}"
    if args.action == "verify":
        release = request(release_path)
        if release["draft"] or release["prerelease"]:
            raise RuntimeError("Release is not a published stable release")
        for asset in release["assets"]:
            local = ROOT / "dist" / asset["name"]
            if not local.is_file() or local.stat().st_size != asset["size"]:
                raise RuntimeError("Remote asset size differs: " + asset["name"])
            expected = hashlib.file_digest(local.open("rb"), "sha256").hexdigest()
            if asset.get("digest") != "sha256:" + expected:
                raise RuntimeError("Remote asset SHA-256 differs: " + asset["name"])
            if asset["name"].endswith('.tgz') or asset["name"] == 'runtime.json':
                with urllib.request.urlopen(asset["browser_download_url"], timeout=60) as response:
                    downloaded = hashlib.file_digest(response, "sha256").hexdigest()
                if downloaded != expected:
                    raise RuntimeError("Public download differs: " + asset["name"])
            print(json.dumps({"name": asset["name"], "bytes": asset["size"], "url": asset["browser_download_url"], "digest": asset.get("digest"), "verified": True}), flush=True)
        return

    release = None
    try:
        release = request(release_path)
    except urllib.error.HTTPError as error:
        if error.code != 404:
            raise
    if release is not None and not release["draft"]:
        raise RuntimeError("Release exists; refusing to overwrite published bytes")
    if subprocess.check_output(["git", "status", "--porcelain"], cwd=ROOT, text=True).strip():
        raise RuntimeError("Commit verified source before publishing")
    head = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip()
    tagged = subprocess.check_output(["git", "rev-parse", tag + "^{}"], cwd=ROOT, text=True).strip()
    if head != tagged:
        raise RuntimeError("Release tag does not match verified source HEAD")
    verification = json.loads((ROOT / ".build/installed-verification.json").read_text(encoding="utf-8"))
    platform = verification["platform"] + "-" + verification["arch"]
    if verification["version"] != version or verification["archiveSha256"] != manifest["platforms"][platform]["sha256"]:
        raise RuntimeError("Installed verification does not match current archive")
    if not all(verification.get(key) for key in ["install", "realDesktop", "reopen", "close", "uninstall", "dataPreserved"]):
        raise RuntimeError("Installed lifecycle verification is incomplete")
    if not verification.get('legacyUpgradeVerified') or not verification.get('oldMcpPathPreserved'):
        raise RuntimeError('Legacy desktop upgrade verification is incomplete')
    package_filename = package['name'].lstrip('@').replace('/', '-') + '-' + version + '.tgz'
    migration = json.loads((ROOT / '.build/profile-upgrade-verification.json').read_text(encoding='utf-8'))
    artifact_hash = hashlib.file_digest((ROOT / 'dist' / package_filename).open('rb'), 'sha256').hexdigest()
    if migration.get('package') != package['name'] + '@' + version or migration.get('sha256') != artifact_hash:
        raise RuntimeError('Profile migration was not verified against this exact plugin archive')
    for key in ['desktop', 'web']:
        result = migration['steps'][key]
        if result.get('migration') != 'passed' or not result.get('physicalLegacyRemoved') or not result.get('idempotent'):
            raise RuntimeError('Profile migration verification incomplete: ' + key)
    if not migration['steps']['canonicalHostClient'].get('passed'):
        raise RuntimeError('Upgraded Host/Client verification incomplete')
    asset_names = {package_filename, package_filename + '.json', package_filename + '.sha256',
                   'runtime.json', 'validation.json', 'RELEASE-NOTES.md', 'SHA256SUMS'}
    for record in manifest['platforms'].values():
        filename = record['url'].rsplit('/', 1)[-1]
        if not filename.startswith('dsh-ez-tree-' + version + '-'):
            raise RuntimeError('Desktop artifact belongs to another release')
        asset_names.update([filename, filename + '.sha256'])
    files = [ROOT / 'dist' / name for name in sorted(asset_names)]
    if any(not path.is_file() for path in files):
        raise RuntimeError('Missing an exact current-version release attachment')
    if not any(path.suffix == ".tgz" for path in files) or not any(path.suffix == ".zip" for path in files):
        raise RuntimeError("Missing plugin or desktop package")
    for platform, record in manifest["platforms"].items():
        archive = ROOT / "dist" / record["url"].rsplit("/", 1)[-1]
        if archive.stat().st_size != record["bytes"] or hashlib.file_digest(archive.open("rb"), "sha256").hexdigest() != record["sha256"]:
            raise RuntimeError(f"Archive mismatch: {platform}")
    notes = (ROOT / "docs/release-notes.md").read_text(encoding="utf-8")
    if release is None:
        release = request(f"repos/{REPOSITORY}/releases", {"tag_name": tag, "name": "EZ-Tree " + version, "body": notes, "draft": True, "prerelease": False})
    upload = release["upload_url"].split("{", 1)[0]
    for path in files:
        digest = hashlib.file_digest(path.open("rb"), "sha256").hexdigest()
        previous = next((asset for asset in release["assets"] if asset["name"] == path.name), None)
        if previous is not None:
            if previous.get("digest") != "sha256:" + digest or previous["size"] != path.stat().st_size:
                raise RuntimeError("Existing draft asset differs: " + path.name)
            print("Already verified", path.name, digest, flush=True)
            continue
        asset = request(upload + "?name=" + urllib.parse.quote(path.name), path.read_bytes(), "POST", "application/octet-stream")
        if asset["size"] != path.stat().st_size or (asset.get("digest") and asset["digest"] != "sha256:" + digest):
            raise RuntimeError("Uploaded asset mismatch: " + path.name)
        print("Uploaded", path.name, digest, flush=True)
    release = request(f"repos/{REPOSITORY}/releases/{release['id']}", {"draft": False}, "PATCH")
    print("Published", release["html_url"])


if __name__ == "__main__":
    main()
