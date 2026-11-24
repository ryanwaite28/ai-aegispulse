"""Creates local buckets, enables versioning on raw/backups (PROJECT.md §5.6, §7.8). Idempotent."""

import os

import boto3
from botocore.client import Config
from botocore.exceptions import ClientError

s3 = boto3.client(
    "s3",
    endpoint_url="http://objectstore:8333",
    aws_access_key_id=os.environ["S3_ADMIN_ACCESS_KEY"],
    aws_secret_access_key=os.environ["S3_ADMIN_SECRET_KEY"],
    region_name="us-east-1",
    config=Config(signature_version="s3v4", s3={"addressing_style": "path"}),
)
for suffix in ("raw", "quarantine", "artifacts", "archive", "analytics", "backups"):
    name = f"aegispulse-local-{suffix}"
    try:
        s3.create_bucket(Bucket=name)
        print(f"created {name}")
    except ClientError as e:
        if e.response["Error"]["Code"] not in ("BucketAlreadyOwnedByYou", "BucketAlreadyExists"):
            raise
        print(f"exists  {name}")
    if suffix in ("raw", "backups"):
        s3.put_bucket_versioning(Bucket=name, VersioningConfiguration={"Status": "Enabled"})
print("objectstore init: done")
