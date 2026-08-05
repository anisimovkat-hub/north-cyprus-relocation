#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import mimetypes
import os
import sys
from pathlib import Path

from boto3 import client as boto3_client
from botocore.client import Config
from botocore.exceptions import ClientError
from dotenv import load_dotenv


ROOT = Path(__file__).resolve().parent
SOURCE = ROOT / "site"
BUCKET = "north-cyprus-relocation-20260727-k7m4"
DEFAULT_ENV_FILE = Path(
    "/Users/katerinaanisimova/Documents/Клиентские проекты/"
    "Team Trip — Тим Трип/.env"
)
FORBIDDEN_PARTS = {
    ".git",
    ".netlify",
    "materials",
    "node_modules",
    "__pycache__",
}
FORBIDDEN_SUFFIXES = {
    ".bak",
    ".doc",
    ".docx",
    ".env",
    ".key",
    ".md",
    ".pem",
    ".ppt",
    ".pptx",
    ".py",
    ".zip",
}


def error_code(exc: Exception) -> str:
    response = getattr(exc, "response", {})
    error = response.get("Error", {}) if isinstance(response, dict) else {}
    return str(error.get("Code", ""))


def load_credentials() -> tuple[str, str, str, str]:
    env_file = Path(os.getenv("YC_DEPLOY_ENV_FILE", str(DEFAULT_ENV_FILE)))
    if not env_file.is_file():
        raise RuntimeError(f"Deployment credential file is unavailable: {env_file}")

    load_dotenv(env_file)
    values = {
        "access_key": os.getenv("AWS_ACCESS_KEY_ID", "").strip(),
        "secret_key": os.getenv("AWS_SECRET_ACCESS_KEY", "").strip(),
        "region": os.getenv("AWS_DEFAULT_REGION", "ru-central1").strip(),
        "endpoint": os.getenv(
            "YC_ENDPOINT", "https://storage.yandexcloud.net"
        ).strip(),
    }
    if not values["access_key"] or not values["secret_key"]:
        raise RuntimeError("Yandex Object Storage credentials are unavailable")
    return (
        values["access_key"],
        values["secret_key"],
        values["region"],
        values["endpoint"],
    )


def create_client():
    access_key, secret_key, region, endpoint = load_credentials()
    return boto3_client(
        "s3",
        endpoint_url=endpoint,
        region_name=region,
        aws_access_key_id=access_key,
        aws_secret_access_key=secret_key,
        config=Config(
            signature_version="s3v4",
            s3={"addressing_style": "path"},
        ),
    )


def collect_files() -> list[Path]:
    if not SOURCE.is_dir():
        raise RuntimeError(f"Public build is unavailable: {SOURCE}")

    files: list[Path] = []
    for path in sorted(SOURCE.rglob("*")):
        if not path.is_file():
            continue
        relative = path.relative_to(SOURCE)
        if path.is_symlink():
            raise RuntimeError(f"Symlinks are not allowed in the public build: {relative}")
        if any(part in FORBIDDEN_PARTS for part in relative.parts):
            raise RuntimeError(f"Forbidden path in public build: {relative}")
        if path.suffix.lower() in FORBIDDEN_SUFFIXES:
            raise RuntimeError(f"Forbidden file type in public build: {relative}")
        if "backup" in path.name.lower() or "before-" in path.name.lower():
            raise RuntimeError(f"Backup file in public build: {relative}")
        files.append(path)

    required = {
        "index.html",
        "404.html",
        "assets/images/zapasnoy-aerodrom-logo.svg",
    }
    available = {path.relative_to(SOURCE).as_posix() for path in files}
    missing = sorted(required - available)
    if missing:
        raise RuntimeError(f"Required public files are missing: {', '.join(missing)}")
    return files


def content_type(path: Path) -> str:
    guessed, _ = mimetypes.guess_type(path.name)
    return guessed or "application/octet-stream"


def cache_control(path: Path) -> str:
    if path.suffix.lower() in {".html", ".css"}:
        return "public, max-age=300"
    return "public, max-age=31536000, immutable"


def ensure_new_or_empty_bucket(s3) -> None:
    try:
        s3.head_bucket(Bucket=BUCKET)
    except ClientError as exc:
        code = error_code(exc)
        if code not in {"404", "NoSuchBucket", "NotFound"}:
            raise
    else:
        existing = s3.list_objects_v2(Bucket=BUCKET, MaxKeys=1)
        if existing.get("KeyCount", 0):
            raise RuntimeError(
                f"Bucket already contains objects; refusing to overwrite: {BUCKET}"
            )
        print(f"resuming empty bucket: {BUCKET}")
        return

    try:
        s3.create_bucket(Bucket=BUCKET)
    except ClientError as exc:
        if error_code(exc) in {
            "InvalidLocationConstraint",
            "IllegalLocationConstraintException",
        }:
            _, _, region, _ = load_credentials()
            s3.create_bucket(
                Bucket=BUCKET,
                CreateBucketConfiguration={"LocationConstraint": region},
            )
        else:
            raise


def require_existing_project_bucket(s3) -> None:
    try:
        s3.head_bucket(Bucket=BUCKET)
        website = s3.get_bucket_website(Bucket=BUCKET)
        if website.get("IndexDocument", {}).get("Suffix") != "index.html":
            raise RuntimeError("Existing bucket has an unexpected index document")
        if website.get("ErrorDocument", {}).get("Key") != "404.html":
            raise RuntimeError("Existing bucket has an unexpected error document")
        for key in (
            "index.html",
            "assets/images/zapasnoy-aerodrom-logo.svg",
        ):
            s3.head_object(Bucket=BUCKET, Key=key)
    except ClientError as exc:
        raise RuntimeError(
            f"Expected project bucket is unavailable or does not match: {BUCKET}"
        ) from exc


def configure_website(s3) -> bool:
    s3.put_bucket_website(
        Bucket=BUCKET,
        WebsiteConfiguration={
            "IndexDocument": {"Suffix": "index.html"},
            "ErrorDocument": {"Key": "404.html"},
        },
    )
    policy = {
        "Version": "2012-10-17",
        "Statement": [
            {
                "Sid": "PublicReadSiteFiles",
                "Effect": "Allow",
                "Principal": "*",
                "Action": ["s3:GetObject"],
                "Resource": [f"arn:aws:s3:::{BUCKET}/*"],
            }
        ],
    }
    try:
        s3.put_bucket_policy(Bucket=BUCKET, Policy=json.dumps(policy))
    except ClientError as exc:
        if error_code(exc) not in {"403", "AccessDenied"}:
            raise
        print("bucket policy unavailable; using public-read object ACLs")
        return False
    return True


def upload_files(s3, files: list[Path], policy_applied: bool) -> None:
    for path in files:
        key = path.relative_to(SOURCE).as_posix()
        extra_args = {
            "ContentType": content_type(path),
            "CacheControl": cache_control(path),
        }
        if not policy_applied:
            extra_args["ACL"] = "public-read"
        s3.upload_file(
            str(path),
            BUCKET,
            key,
            ExtraArgs=extra_args,
        )
        print(f"uploaded: {key}")


def verify_deployment(s3, files: list[Path], policy_applied: bool) -> None:
    website = s3.get_bucket_website(Bucket=BUCKET)
    if website.get("IndexDocument", {}).get("Suffix") != "index.html":
        raise RuntimeError("Unexpected index document configuration")
    if website.get("ErrorDocument", {}).get("Key") != "404.html":
        raise RuntimeError("Unexpected error document configuration")

    if policy_applied:
        policy = json.loads(s3.get_bucket_policy(Bucket=BUCKET)["Policy"])
        statements = policy.get("Statement", [])
        if not any(
            statement.get("Effect") == "Allow"
            and statement.get("Principal") == "*"
            and statement.get("Action") == ["s3:GetObject"]
            for statement in statements
        ):
            raise RuntimeError("Public read policy verification failed")

    for path in files:
        key = path.relative_to(SOURCE).as_posix()
        s3.head_object(Bucket=BUCKET, Key=key)
        if not policy_applied:
            acl = s3.get_object_acl(Bucket=BUCKET, Key=key)
            public_read = any(
                grant.get("Permission") == "READ"
                and grant.get("Grantee", {}).get("URI", "").endswith("/AllUsers")
                for grant in acl.get("Grants", [])
            )
            if not public_read:
                raise RuntimeError(f"Public read ACL verification failed: {key}")


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Deploy the clean North Cyprus public build to a new Yandex Object Storage bucket."
    )
    parser.add_argument(
        "--check-access",
        action="store_true",
        help="Validate API access without printing bucket names or credentials.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Validate and list the public build without changing cloud resources.",
    )
    parser.add_argument(
        "--deploy",
        action="store_true",
        help="Create the new bucket, configure static hosting and upload the site.",
    )
    parser.add_argument(
        "--update",
        action="store_true",
        help="Safely update the existing verified project bucket without deleting objects.",
    )
    args = parser.parse_args()
    if sum((args.check_access, args.dry_run, args.deploy, args.update)) != 1:
        parser.error(
            "Choose exactly one of --check-access, --dry-run, --deploy, or --update"
        )

    files = collect_files()
    if args.dry_run:
        print(f"bucket: {BUCKET}")
        print(f"public files: {len(files)}")
        for path in files:
            print(path.relative_to(SOURCE).as_posix())
        return 0

    s3 = create_client()
    if args.check_access:
        bucket_count = len(s3.list_buckets().get("Buckets", []))
        print(f"API access is valid; visible buckets: {bucket_count}")
        return 0

    if args.deploy:
        ensure_new_or_empty_bucket(s3)
    else:
        require_existing_project_bucket(s3)
        print(f"verified existing project bucket: {BUCKET}")
    policy_applied = configure_website(s3)
    print("configured static website access")
    upload_files(s3, files, policy_applied)
    verify_deployment(s3, files, policy_applied)
    print(f"verified objects: {len(files)}")
    print(f"website: https://{BUCKET}.website.yandexcloud.net")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (RuntimeError, ClientError) as exc:
        print(f"deployment error: {exc}", file=sys.stderr)
        raise SystemExit(1)
