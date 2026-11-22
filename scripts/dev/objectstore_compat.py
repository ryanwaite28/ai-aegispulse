#!/usr/bin/env python3
"""ADR-0011 object-store compatibility check (S3 API features AegisPulse relies on).

Run:  uv run --with boto3 --with requests scripts/dev/objectstore_compat.py \
        --endpoint http://localhost:18333 --admin-key K --admin-secret S \
        --scoped-key K2 --scoped-secret S2 --bucket testbucket --scoped-prefix raw/

Checks (PROJECT.md §2.7, §7.8, ADR-0009/0011):
  1 bucket create            2 presigned PUT with signed Content-Type (accept matching, reject mismatched)
  3 HEAD size                4 presigned GET              5 multipart upload (2 parts)
  6 server-side copy + delete (quarantine move)           7 bucket versioning
  8 prefix-scoped principal (allowed prefix OK, other prefix denied)
Exit code 0 only if every check passes.
"""

from __future__ import annotations

import argparse
import contextlib
import sys
import uuid
from typing import Any

import boto3
import requests
from botocore.client import Config
from botocore.exceptions import ClientError

results: list[tuple[str, bool, str]] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    results.append((name, ok, detail))
    print(f"[{'PASS' if ok else 'FAIL'}] {name}{(' — ' + detail) if detail else ''}")


def client(endpoint: str, key: str, secret: str) -> Any:
    return boto3.client(
        "s3",
        endpoint_url=endpoint,
        aws_access_key_id=key,
        aws_secret_access_key=secret,
        region_name="us-east-1",
        config=Config(signature_version="s3v4", s3={"addressing_style": "path"}),
    )


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--endpoint", required=True)
    ap.add_argument("--admin-key", required=True)
    ap.add_argument("--admin-secret", required=True)
    ap.add_argument("--scoped-key", required=True)
    ap.add_argument("--scoped-secret", required=True)
    ap.add_argument("--bucket", default="testbucket")
    ap.add_argument("--scoped-prefix", default="raw/")
    a = ap.parse_args()

    s3 = client(a.endpoint, a.admin_key, a.admin_secret)
    b = a.bucket

    try:
        s3.create_bucket(Bucket=b)
        check("1 bucket create", True)
    except ClientError as e:
        code = e.response["Error"]["Code"]
        check("1 bucket create", code in ("BucketAlreadyOwnedByYou", "BucketAlreadyExists"), code)

    key = f"raw/{uuid.uuid4()}"
    body = b"%PDF-1.7 test body"
    url = s3.generate_presigned_url(
        "put_object", Params={"Bucket": b, "Key": key, "ContentType": "application/pdf"}, ExpiresIn=600
    )
    r_ok = requests.put(url, data=body, headers={"Content-Type": "application/pdf"}, timeout=10)
    check("2a presigned PUT (matching Content-Type)", r_ok.status_code == 200, f"HTTP {r_ok.status_code}")
    r_bad = requests.put(url, data=body, headers={"Content-Type": "text/html"}, timeout=10)
    check(
        "2b presigned PUT rejects mismatched Content-Type", r_bad.status_code in (400, 403), f"HTTP {r_bad.status_code}"
    )

    try:
        head = s3.head_object(Bucket=b, Key=key)
        check("3 HEAD size", head["ContentLength"] == len(body), str(head["ContentLength"]))
    except ClientError as e:
        check("3 HEAD size", False, str(e))

    get_url = s3.generate_presigned_url("get_object", Params={"Bucket": b, "Key": key}, ExpiresIn=300)
    r_get = requests.get(get_url, timeout=10)
    check("4 presigned GET", r_get.status_code == 200 and r_get.content == body, f"HTTP {r_get.status_code}")

    try:
        mkey = f"raw/{uuid.uuid4()}-multipart"
        mp = s3.create_multipart_upload(Bucket=b, Key=mkey, ContentType="text/csv")
        part = b"a" * (5 * 1024 * 1024)
        p1 = s3.upload_part(Bucket=b, Key=mkey, UploadId=mp["UploadId"], PartNumber=1, Body=part)
        p2 = s3.upload_part(Bucket=b, Key=mkey, UploadId=mp["UploadId"], PartNumber=2, Body=b"tail")
        s3.complete_multipart_upload(
            Bucket=b,
            Key=mkey,
            UploadId=mp["UploadId"],
            MultipartUpload={"Parts": [{"ETag": p1["ETag"], "PartNumber": 1}, {"ETag": p2["ETag"], "PartNumber": 2}]},
        )
        size = s3.head_object(Bucket=b, Key=mkey)["ContentLength"]
        check("5 multipart upload", size == len(part) + 4, f"{size} bytes")
    except ClientError as e:
        check("5 multipart upload", False, str(e))

    try:
        qkey = f"quarantine/{uuid.uuid4()}"
        s3.copy_object(Bucket=b, Key=qkey, CopySource={"Bucket": b, "Key": key})
        s3.delete_object(Bucket=b, Key=key)
        check("6 server-side copy + delete", s3.head_object(Bucket=b, Key=qkey)["ContentLength"] == len(body))
    except ClientError as e:
        check("6 server-side copy + delete", False, str(e))

    try:
        vb = f"{b}-versioned"
        with contextlib.suppress(ClientError):
            s3.create_bucket(Bucket=vb)
        s3.put_bucket_versioning(Bucket=vb, VersioningConfiguration={"Status": "Enabled"})
        status = s3.get_bucket_versioning(Bucket=vb).get("Status")
        s3.put_object(Bucket=vb, Key="obj", Body=b"v1")
        s3.put_object(Bucket=vb, Key="obj", Body=b"v2")
        versions = [
            v for v in s3.list_object_versions(Bucket=vb, Prefix="obj").get("Versions", []) if v["Key"] == "obj"
        ]
        check(
            "7 bucket versioning",
            status == "Enabled" and len(versions) >= 2,
            f"status={status} versions={len(versions)}",
        )
    except ClientError as e:
        check("7 bucket versioning", False, str(e))

    scoped = client(a.endpoint, a.scoped_key, a.scoped_secret)
    try:
        scoped.put_object(Bucket=b, Key=f"{a.scoped_prefix}{uuid.uuid4()}", Body=b"ok")
        check("8a scoped principal writes allowed prefix", True)
    except ClientError as e:
        check("8a scoped principal writes allowed prefix", False, e.response["Error"]["Code"])
    try:
        scoped.put_object(Bucket=b, Key=f"other/{uuid.uuid4()}", Body=b"nope")
        check("8b scoped principal denied outside prefix", False, "write succeeded")
    except ClientError as e:
        check(
            "8b scoped principal denied outside prefix",
            e.response["Error"]["Code"] in ("AccessDenied", "403"),
            e.response["Error"]["Code"],
        )

    failed = [n for n, ok, _ in results if not ok]
    print(f"\n{len(results) - len(failed)}/{len(results)} checks passed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
